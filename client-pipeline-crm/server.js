const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Railway: attach a Volume mounted at /data for this to persist across deploys.
// Without a volume, the filesystem resets on every redeploy.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'pipeline-state.json');

// Optional shared-secret protection. Set PIPELINE_PASSWORD in Railway env vars
// to require a header on write requests (basic protection since this will be
// a public URL). Leave unset to disable.
const PASSWORD = process.env.PIPELINE_PASSWORD || null;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    clients: [], xp: 0, streak: 0, lastActiveDate: null, earnedBadges: []
  }, null, 2));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function checkAuth(req, res, next) {
  if (!PASSWORD) return next();
  if (req.get('x-pipeline-key') === PASSWORD) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

app.get('/api/state', (req, res) => {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    res.json(JSON.parse(raw));
  } catch (e) {
    res.status(500).json({ error: 'failed to read state' });
  }
});

app.post('/api/state', checkAuth, (req, res) => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'failed to save state' });
  }
});

app.listen(PORT, () => {
  console.log(`Client pipeline CRM running on port ${PORT}`);
});
