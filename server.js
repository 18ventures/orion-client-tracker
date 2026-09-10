const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway: attach a Volume mounted at /data for this to persist across deploys.
// Without a volume, the filesystem resets on every redeploy.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'pipeline-state.json');

// Optional shared-secret protection. Set PIPELINE_PASSWORD in Railway env vars
// to require a header on write requests (basic protection since this will be
// a public URL). Leave unset to disable.
// STRONGLY recommended once you start storing DEX private keys below.
const PASSWORD = process.env.PIPELINE_PASSWORD || null;

// Encryption key for the DEX private key field ONLY. Must be a 64-character
// hex string (32 bytes) for AES-256-GCM. Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// Set the result as ENCRYPTION_KEY in Railway env vars. Never commit it,
// never put it in the JSON store — it lives only in the environment.
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || null;

// Separate secret for the bot service to pull live client credentials —
// deliberately NOT the same value as PIPELINE_PASSWORD. That one protects
// human writes/reveals from the CRM's own browser UI; this one protects a
// machine-to-machine endpoint that hands back DECRYPTED private keys, so it
// gets its own trust boundary. Set BOT_SYNC_SECRET in Railway and put the
// same value in the bot service's CRM_SYNC_SECRET.
const BOT_SYNC_SECRET = process.env.BOT_SYNC_SECRET || null;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    clients: [], liveClients: [], prospects: [],
    prospectHistory: { added: 0, converted: 0, declined: 0 },
    xp: 0, earnedBadges: [], nextClientNumber: 1
  }, null, 2));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function checkAuth(req, res, next) {
  if (!PASSWORD) return next();
  if (req.get('x-pipeline-key') === PASSWORD) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function findClientById(data, id) {
  return (data.clients || []).find(c => c.id === id) || (data.liveClients || []).find(c => c.id === id);
}

function encryptSecret(plaintext) {
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY not configured on server');
  const key = Buffer.from(ENCRYPTION_KEY, 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('hex'), tag: tag.toString('hex'), data: encrypted.toString('hex') };
}

function decryptSecret(blob) {
  if (!ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY not configured on server');
  const key = Buffer.from(ENCRYPTION_KEY, 'hex');
  const iv = Buffer.from(blob.iv, 'hex');
  const tag = Buffer.from(blob.tag, 'hex');
  const data = Buffer.from(blob.data, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

// Full state, minus any private key material. This is the only route the
// frontend uses for its normal load — the encrypted blob never leaves the
// server through here, only a boolean flag saying whether one is set.
app.get('/api/state', (req, res) => {
  try {
    const raw = readData();
    if (Array.isArray(raw.clients)) {
      raw.clients = raw.clients.map(c => {
        const { privateKeyEncrypted, ...rest } = c;
        return { ...rest, hasPrivateKey: !!privateKeyEncrypted };
      });
    }
    if (Array.isArray(raw.liveClients)) {
      raw.liveClients = raw.liveClients.map(c => {
        const { privateKeyEncrypted, ...rest } = c;
        return { ...rest, hasPrivateKey: !!privateKeyEncrypted };
      });
    }
    res.json(raw);
  } catch (e) {
    res.status(500).json({ error: 'failed to read state' });
  }
});

// Bulk save for everything EXCEPT the private key. Any privateKeyEncrypted
// or hasPrivateKey sent up from the client is ignored; whatever encrypted
// blob already exists on disk for that client id is preserved untouched.
app.post('/api/state', checkAuth, (req, res) => {
  try {
    const incoming = req.body;
    const existing = fs.existsSync(DATA_FILE) ? readData() : { clients: [], liveClients: [] };
    const existingKeys = {};
    (existing.clients || []).forEach(c => {
      if (c.privateKeyEncrypted) existingKeys[c.id] = c.privateKeyEncrypted;
    });
    (existing.liveClients || []).forEach(c => {
      if (c.privateKeyEncrypted) existingKeys[c.id] = c.privateKeyEncrypted;
    });
    const stripAndReattach = (c) => {
      const { hasPrivateKey, privateKeyEncrypted, ...rest } = c;
      if (existingKeys[c.id]) rest.privateKeyEncrypted = existingKeys[c.id];
      return rest;
    };
    if (Array.isArray(incoming.clients)) {
      incoming.clients = incoming.clients.map(stripAndReattach);
    }
    if (Array.isArray(incoming.liveClients)) {
      incoming.liveClients = incoming.liveClients.map(stripAndReattach);
    }
    writeData(incoming);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed to save state' });
  }
});

// Set or clear a client's DEX private key. Encrypted before it ever touches
// disk. Send { privateKey: "" } to clear it.
app.post('/api/clients/:id/key', checkAuth, (req, res) => {
  try {
    const { privateKey } = req.body;
    const data = readData();
    const client = findClientById(data, req.params.id);
    if (!client) return res.status(404).json({ error: 'client not found' });

    if (!privateKey) {
      delete client.privateKeyEncrypted;
    } else {
      client.privateKeyEncrypted = encryptSecret(privateKey);
    }
    writeData(data);
    res.json({ ok: true, hasPrivateKey: !!client.privateKeyEncrypted });
  } catch (e) {
    res.status(500).json({ error: e.message || 'failed to set key' });
  }
});

// Decrypt and return a client's DEX private key. Protected by the same
// PIPELINE_PASSWORD header as writes — set PIPELINE_PASSWORD once you're
// using this field, since this route hands back plaintext key material.
app.post('/api/clients/:id/key/reveal', checkAuth, (req, res) => {
  try {
    const data = readData();
    const client = findClientById(data, req.params.id);
    if (!client || !client.privateKeyEncrypted) {
      return res.status(404).json({ error: 'no key set for this client' });
    }
    const privateKey = decryptSecret(client.privateKeyEncrypted);
    res.json({ privateKey });
  } catch (e) {
    res.status(500).json({ error: e.message || 'failed to reveal key' });
  }
});

// Machine-to-machine endpoint for the bot service to pull its live client
// list directly from the CRM instead of Railway env vars per client. Only
// returns clients that are actually ready to trade (wallet address +
// private key both set) — anything still mid-onboarding is silently
// skipped, same as the bot's own is_configured() check would do anyway.
//
// This is the one place decrypted private key material leaves this server
// over the network (previously only /reveal did, to Nathan's own browser —
// this sends it to the bot instead). Gated by BOT_SYNC_SECRET, a header
// check only, no session/cookie state — matches this app's existing
// security model (a shared secret over HTTPS), not a stronger standard.
// If the bot and this CRM ever end up in the same Railway project, prefer
// Railway's private networking (service-to-service .railway.internal
// address) over the public URL for this specific route.
app.get('/api/bot/sync', (req, res) => {
  if (!BOT_SYNC_SECRET) {
    return res.status(503).json({ error: 'BOT_SYNC_SECRET not configured on this server' });
  }
  if (req.get('x-bot-sync-key') !== BOT_SYNC_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const data = readData();
    const liveClients = Array.isArray(data.liveClients) ? data.liveClients : [];

    const clients = [];
    for (const c of liveClients) {
      if (!c.dexWalletAddress || !c.privateKeyEncrypted || !c.clientNumber) continue; // not ready to trade
      let privateKey;
      try {
        privateKey = decryptSecret(c.privateKeyEncrypted);
      } catch (e) {
        console.error(`[Bot Sync] Failed to decrypt key for client ${c.id}: ${e.message}`);
        continue; // skip this one rather than fail the whole sync
      }
      clients.push({
        id: String(c.clientNumber),
        name: c.name || null,               // for the bot's own logs only
        address: c.dexWalletAddress,
        private_key: privateKey,
        dashboard_token: c.dashboardTokenId || null,
      });
    }

    res.json({ clients });
  } catch (e) {
    console.error('[Bot Sync] Error:', e.message);
    res.status(500).json({ error: 'failed to build client sync payload' });
  }
});

app.listen(PORT, () => {
  console.log(`Client pipeline CRM running on port ${PORT}`);
  if (!ENCRYPTION_KEY) {
    console.warn('WARNING: ENCRYPTION_KEY not set — DEX private key storage/reveal will be disabled until it is configured.');
  }
  if (!PASSWORD) {
    console.warn('WARNING: PIPELINE_PASSWORD not set — write and key-reveal endpoints are unauthenticated.');
  }
  if (!BOT_SYNC_SECRET) {
    console.warn('WARNING: BOT_SYNC_SECRET not set — /api/bot/sync will refuse all requests until it is configured.');
  }
});
