const express = require('express');
const fs = require('fs');
const PDFDocument = require('pdfkit'); // npm install pdfkit --save (not yet in package.json — see note below)
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway: attach a Volume mounted at /data for this to persist across deploys.
// Without a volume, the filesystem resets on every redeploy.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'pipeline-state.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups'); // same volume, but a separate bad-write can't silently take these out too

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

// Needed the other direction too — for the CRM to call THE BOT directly
// (e.g. "remind this client" below), reusing the same shared secret above
// rather than a separate one, since it's the same trusted relationship.
const BOT_DASHBOARD_URL = (process.env.BOT_DASHBOARD_URL || '').replace(/\/$/, '');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    clients: [], liveClients: [], prospects: [],
    prospectHistory: { added: 0, converted: 0, declined: 0 },
    // nextClientNumber starts at 2, not 1 — client # 1 is permanently
    // reserved for Nathan's own master account on the bot side (see
    // MASTER_CLIENT_ID in bot(6)_dashboard.py). A CRM client assigned #1
    // would silently never sync to the bot, since the sync logic refuses
    // to let anything claim that reserved slot.
    xp: 0, earnedBadges: [], nextClientNumber: 2
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
        name: c.name || null,               // used for the dashboard's personalized greeting
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

// Fetches each live client's REAL current balance directly from Hyperliquid,
// using their public wallet address only (no private key needed — this is
// just a balance read, same public info endpoint the bot itself uses).
// Checks crossMarginSummary as a fallback to marginSummary, since
// Hyperliquid's newer "Unified Account" structure can report real equity
// under crossMarginSummary instead — the same gotcha discovered while
// debugging the bot's dashboard.
async function fetchHyperliquidBalance(address) {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clearinghouseState', user: address }),
    });
    if (!res.ok) return { status: 'error' };
    const state = await res.json();
    const marginVal = parseFloat(state?.marginSummary?.accountValue || 0) || 0;
    const crossVal  = parseFloat(state?.crossMarginSummary?.accountValue || 0) || 0;
    const balance = (marginVal === 0 && crossVal !== 0) ? crossVal : marginVal;

    // Position data comes from this same response — no extra API call.
    // Report the first non-zero position found, if any; Orion only ever
    // trades one instrument per account so there's at most one to find.
    let position = null;
    for (const p of (state?.assetPositions || [])) {
      const szi = parseFloat(p?.position?.szi || 0);
      if (szi !== 0) {
        position = {
          coin: p.position.coin,
          direction: szi > 0 ? 'LONG' : 'SHORT',
          size: Math.abs(szi),
          entryPx: parseFloat(p.position.entryPx || 0),
          unrealizedPnl: parseFloat(p.position.unrealizedPnl || 0),
        };
        break;
      }
    }

    return { status: 'ok', balance, position };
  } catch (e) {
    console.error('[Balances] Hyperliquid fetch failed for', address, e.message);
    return { status: 'error' };
  }
}

app.get('/api/clients/balances', checkAuth, async (req, res) => {
  try {
    const data = readData();
    const liveClients = Array.isArray(data.liveClients) ? data.liveClients : [];

    const results = await Promise.all(
      liveClients
        .filter(c => c.dexWalletAddress)
        .map(async c => {
          const r = await fetchHyperliquidBalance(c.dexWalletAddress);
          return { id: c.id, ...r };
        })
    );

    const balances = {};
    for (const r of results) balances[r.id] = r;
    res.json({ balances });
  } catch (e) {
    console.error('[Balances] Error:', e.message);
    res.status(500).json({ error: 'failed to fetch balances' });
  }
});

// Computes UK midnight (00:00 Europe/London, correctly handling BST/GMT)
// as a UTC millisecond timestamp — used as the "today" boundary for daily
// P&L, matching how the bot itself defines "today" for its own stats.
function ukMidnightMs() {
  const now = new Date();
  const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = dateFmt.formatToParts(now);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  const utcGuess = new Date(`${y}-${m}-${d}T00:00:00Z`);
  const offsetFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/London', timeZoneName: 'shortOffset' });
  const offsetPart = offsetFmt.formatToParts(utcGuess).find(p => p.type === 'timeZoneName').value; // "GMT" or "GMT+1"
  const match = offsetPart.match(/GMT([+-]\d+)?/);
  const offsetHours = (match && match[1]) ? parseInt(match[1], 10) : 0;
  return utcGuess.getTime() - offsetHours * 3600 * 1000;
}

// Today's UK calendar date as YYYY-MM-DD — used to detect when a new day
// has begun, and as the key each daily-close balance is stored under.
function ukDateString(dateObj) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(dateObj || new Date());
}

function ukYesterdayDateString() {
  // The day that JUST ended, relative to right now — computed from the
  // most recent UK midnight minus a few hours, not by naively subtracting
  // 24h from "now" (which would be wrong close to a UK midnight rollover).
  return ukDateString(new Date(ukMidnightMs() - 3600 * 1000));
}

// Manual "snapshot their balance right now" — meant for the cycle
// BASELINE specifically: taken once, before a client's first trade, so the
// 30-day/30% target has a genuine starting point that isn't backdated or
// guessed. A button for now, while client numbers are small enough that
// pressing it once per client is no burden — this does not touch the daily
// close history below.
app.post('/api/clients/:id/snapshot-balance', checkAuth, async (req, res) => {
  try {
    const data = readData();
    const client = findClientById(data, req.params.id);
    if (!client) return res.status(404).json({ error: 'client not found' });
    if (!client.dexWalletAddress) return res.status(400).json({ error: 'client has no wallet address set' });

    const result = await fetchHyperliquidBalance(client.dexWalletAddress);
    if (result.status !== 'ok') return res.status(502).json({ error: 'could not fetch live balance from Hyperliquid' });

    client.cycleStartBalance = result.balance;
    client.cycleStartDate = ukDateString();
    writeData(data);
    res.json({ cycleStartBalance: client.cycleStartBalance, cycleStartDate: client.cycleStartDate });
  } catch (e) {
    console.error('[Snapshot Balance] Error:', e.message);
    res.status(500).json({ error: 'failed to snapshot balance' });
  }
});

// Pushes a one-time reminder to a client's OWN Orion dashboard — the
// "remind them" half of the renewal-reminder button. The CRM's own
// due-soon/overdue flags already remind Nathan; this is what he presses
// once he's decided it's time to actually notify the client.
app.post('/api/clients/:id/send-renewal-reminder', checkAuth, async (req, res) => {
  try {
    if (!BOT_DASHBOARD_URL || !BOT_SYNC_SECRET) {
      return res.status(503).json({ error: 'BOT_DASHBOARD_URL / BOT_SYNC_SECRET not configured on this server' });
    }
    const data = readData();
    const client = findClientById(data, req.params.id);
    if (!client) return res.status(404).json({ error: 'client not found' });
    if (!client.clientNumber) return res.status(400).json({ error: 'client has no client number set' });

    const message = req.body?.message
      || `Reminder: your subscription renews soon. Make sure your account stays funded so trading can continue without interruption.`;

    const botRes = await fetch(`${BOT_DASHBOARD_URL}/api/admin/client-reminder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bot-sync-key': BOT_SYNC_SECRET },
      body: JSON.stringify({ client_id: String(client.clientNumber), message }),
    });
    const botData = await botRes.json().catch(() => ({}));
    if (!botRes.ok) return res.status(502).json({ error: botData.error || 'bot rejected the reminder' });

    res.json({ ok: true });
  } catch (e) {
    console.error('[Send Renewal Reminder] Error:', e.message);
    res.status(500).json({ error: 'failed to send reminder — is the bot reachable?' });
  }
});

// ── Automatic daily-close balance capture ──
// The 30-day/30% target is measured against END-OF-DAY balance, not live
// intraday balance — live balance swings with whatever position happens to
// be open at the exact moment someone looks at the CRM, which makes for a
// noisy, misleading progress number. A stable daily close, captured once
// per UK day at the moment it rolls over, is what actually reflects settled
// day-to-day performance.
let lastDailySnapshotDate = null; // in-memory; re-derived from stored data on boot, see below

async function captureDailyCloseForAllClients() {
  const data = readData();
  const liveClients = Array.isArray(data.liveClients) ? data.liveClients : [];
  const closingDate = ukYesterdayDateString(); // the day that just ended

  const results = await Promise.all(
    liveClients
      .filter(c => c.dexWalletAddress)
      .map(async c => {
        const r = await fetchHyperliquidBalance(c.dexWalletAddress);
        return { id: c.id, result: r };
      })
  );

  for (const { id, result } of results) {
    if (result.status !== 'ok') continue;
    const client = liveClients.find(c => c.id === id);
    if (!client) continue;
    if (!client.dailyBalanceHistory) client.dailyBalanceHistory = {};
    client.dailyBalanceHistory[closingDate] = result.balance;
  }

  data.lastDailySnapshotDate = closingDate;
  writeData(data);
  lastDailySnapshotDate = closingDate;
  console.log(`[Daily Close] Captured balance for ${results.length} client(s) for ${closingDate}`);
}

function checkAndRunDailyClose() {
  const today = ukDateString();
  if (lastDailySnapshotDate === null) {
    // First tick since boot — recover the last known date from disk so a
    // restart doesn't cause an immediate duplicate or missed capture.
    try {
      const data = readData();
      lastDailySnapshotDate = data.lastDailySnapshotDate || null;
    } catch (e) { /* fall through, will just capture on next real rollover */ }
  }
  const yesterday = ukYesterdayDateString();
  if (lastDailySnapshotDate !== yesterday && lastDailySnapshotDate !== today) {
    captureDailyCloseForAllClients().catch(e => console.error('[Daily Close] Failed:', e.message));
  }
}

setInterval(checkAndRunDailyClose, 5 * 60 * 1000); // check every 5 minutes
checkAndRunDailyClose(); // and once on boot, in case of a missed rollover while offline

// ── Automatic daily backup ──
// Protects against a bad write (a bug, a bad migration) silently
// corrupting the live data file with nothing to recover from — this is a
// DIFFERENT failure mode than losing the Railway volume entirely, which
// only the manual export below actually protects against. Keeps the last
// 14 days, pruning older ones so this doesn't grow forever.
const BACKUP_RETENTION_DAYS = 14;
let lastBackupDate = null;

function runDailyBackup() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) return; // nothing to back up yet
    const today = ukDateString();
    const dest = path.join(BACKUP_DIR, `pipeline-state-${today}.json`);
    fs.copyFileSync(DATA_FILE, dest);
    lastBackupDate = today;

    // Prune anything older than the retention window
    const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(BACKUP_DIR)) {
      const full = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
    }
    console.log(`[Backup] Saved ${dest}`);
  } catch (e) {
    console.error('[Backup] Failed:', e.message);
  }
}

function checkAndRunDailyBackup() {
  const today = ukDateString();
  if (lastBackupDate !== today) runDailyBackup();
}

setInterval(checkAndRunDailyBackup, 30 * 60 * 1000); // check every 30 minutes
checkAndRunDailyBackup(); // and once on boot

// Manual export — the ONLY thing that actually protects against losing the
// whole Railway volume, since it's the one copy that ever leaves this
// server. Returns the current live data as a downloadable file.
app.get('/api/backup/export', checkAuth, (req, res) => {
  try {
    if (!fs.existsSync(DATA_FILE)) return res.status(404).json({ error: 'no data file found yet' });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Disposition', `attachment; filename="orion-crm-backup-${stamp}.json"`);
    res.setHeader('Content-Type', 'application/json');
    fs.createReadStream(DATA_FILE).pipe(res);
  } catch (e) {
    console.error('[Backup Export] Failed:', e.message);
    res.status(500).json({ error: 'failed to export backup' });
  }
});


// Generates a PDF statement for one client's current billing cycle —
// starting balance, latest recorded daily close, net change, and progress
// toward the 30% target, plus a day-by-day table for the cycle so far.
// Uses the exact same baseline logic as the CRM's own 30-day target
// display (explicit cycleStartBalance override if set, else initialBalance)
// so the numbers on the statement always match what's shown on the card.
app.get('/api/clients/:id/statement', checkAuth, (req, res) => {
  try {
    const data = readData();
    const client = findClientById(data, req.params.id);
    if (!client) return res.status(404).json({ error: 'client not found' });

    const hasOverride = client.cycleStartBalance != null && client.cycleStartDate;
    const cycleStart = hasOverride ? client.cycleStartBalance : client.initialBalance;
    const cycleDate = hasOverride ? client.cycleStartDate : client.dateFunded;
    if (!cycleStart || cycleStart <= 0 || !cycleDate) {
      return res.status(400).json({ error: 'client has no starting balance / funded date set yet — nothing to generate a statement from' });
    }

    const history = client.dailyBalanceHistory || {};
    const cycleDates = Object.keys(history).filter(d => d >= cycleDate).sort();
    const latestDate = cycleDates.length ? cycleDates[cycleDates.length - 1] : null;
    const latestBalance = latestDate ? history[latestDate] : null;

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stamp = ukDateString();
    res.setHeader('Content-Disposition', `attachment; filename="${client.name.replace(/[^a-z0-9]/gi, '_')}-statement-${stamp}.pdf"`);
    res.setHeader('Content-Type', 'application/pdf');
    doc.pipe(res);

    // ── Header ──
    doc.fontSize(20).fillColor('#111').text('ORION', { continued: true }).fillColor('#888').fontSize(11).text('  Client Statement', { align: 'left' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#888').text(`Generated ${stamp}`);
    doc.moveDown(1);

    // ── Client + period ──
    doc.fontSize(14).fillColor('#111').text(client.name);
    doc.fontSize(10).fillColor('#555').text(`Client #${String(client.clientNumber).padStart(3, '0')}`);
    doc.moveDown(0.5);
    const periodEnd = latestDate || cycleDate;
    doc.fontSize(11).fillColor('#111').text(`Statement period: ${cycleDate} to ${periodEnd}`);
    doc.moveDown(1);

    // ── Summary figures ──
    const endingBalance = latestBalance != null ? latestBalance : cycleStart;
    const netChange = endingBalance - cycleStart;
    const pctChange = (netChange / cycleStart) * 100;
    const changeColor = netChange >= 0 ? '#1a7a3c' : '#b3261e';

    const summaryRows = [
      ['Starting balance', `$${cycleStart.toFixed(2)}`],
      ['Ending balance', latestBalance != null ? `$${endingBalance.toFixed(2)}` : `$${endingBalance.toFixed(2)} (no daily close recorded yet)`],
      ['Net change', `${netChange >= 0 ? '+' : ''}$${netChange.toFixed(2)} (${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(1)}%)`],
      ['Progress to 30% target', `${Math.max(0, Math.min(100, pctChange / 30 * 100)).toFixed(0)}%`],
    ];
    summaryRows.forEach(([label, value], i) => {
      const y = doc.y;
      doc.fontSize(11).fillColor('#555').text(label, 50, y, { lineBreak: false });
      doc.fillColor(i === 2 ? changeColor : '#111').text(value, 220, y, { lineBreak: false });
      doc.y = y + 18;
    });
    doc.x = 50;
    doc.moveDown(0.8);

    // ── Daily breakdown ──
    if (cycleDates.length > 0) {
      doc.fontSize(12).fillColor('#111').text('Daily balances this cycle', 50, doc.y);
      doc.moveDown(0.3);
      let prevBalance = cycleStart;
      const rowHeight = 16;
      cycleDates.forEach(d => {
        const bal = history[d];
        const change = bal - prevBalance;
        const changeStr = `${change >= 0 ? '+' : ''}$${change.toFixed(2)}`;
        const y = doc.y;
        doc.fontSize(10).fillColor('#555').text(d, 50, y, { lineBreak: false });
        doc.fillColor('#111').text(`$${bal.toFixed(2)}`, 160, y, { lineBreak: false });
        doc.fillColor(change >= 0 ? '#1a7a3c' : '#b3261e').text(changeStr, 260, y, { lineBreak: false });
        doc.y = y + rowHeight;
        prevBalance = bal;
      });
    } else {
      doc.fontSize(10).fillColor('#888').text('No daily closes recorded yet this cycle.');
    }

    doc.x = 50;
    doc.moveDown(1.5);
    doc.fontSize(8).fillColor('#aaa').text('This statement is generated from recorded daily balances and is for informational purposes only. Past performance does not guarantee future results.', 50, doc.y, { width: 495 });

    doc.end();
  } catch (e) {
    console.error('[Statement] Error:', e.message);
    res.status(500).json({ error: 'failed to generate statement' });
  }
});


// Sums closedPnl from a client's fills since UK midnight —
// just read directly from Hyperliquid rather than through the bot.
async function fetchHyperliquidDailyPnl(address, startTimeMs) {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'userFillsByTime', user: address, startTime: startTimeMs }),
    });
    if (!res.ok) return { status: 'error' };
    const fills = await res.json();
    if (!Array.isArray(fills)) return { status: 'error' };
    let pnl = 0, trades = 0;
    const seenOids = new Set();
    for (const f of fills) {
      const closed = parseFloat(f.closedPnl || 0) || 0;
      if (closed !== 0) {
        pnl += closed;
        if (!seenOids.has(f.oid)) { seenOids.add(f.oid); trades += 1; }
      }
    }
    return { status: 'ok', pnl, trades };
  } catch (e) {
    console.error('[Daily PnL] Hyperliquid fetch failed for', address, e.message);
    return { status: 'error' };
  }
}

app.get('/api/clients/daily-pnl', checkAuth, async (req, res) => {
  try {
    const data = readData();
    const liveClients = Array.isArray(data.liveClients) ? data.liveClients : [];
    const startTimeMs = ukMidnightMs();

    const results = await Promise.all(
      liveClients
        .filter(c => c.dexWalletAddress)
        .map(async c => {
          const r = await fetchHyperliquidDailyPnl(c.dexWalletAddress, startTimeMs);
          return { id: c.id, ...r };
        })
    );

    const clients = {};
    let totalPnl = 0, totalTrades = 0;
    for (const r of results) {
      clients[r.id] = r;
      if (r.status === 'ok') { totalPnl += r.pnl; totalTrades += r.trades; }
    }
    res.json({ clients, total: { pnl: totalPnl, trades: totalTrades } });
  } catch (e) {
    console.error('[Daily PnL] Error:', e.message);
    res.status(500).json({ error: 'failed to fetch daily pnl' });
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
