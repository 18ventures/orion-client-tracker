# Client Pipeline CRM

Same UI as the artifact, now a standalone Node/Express app so it can run on Railway
like Orion and the compound tracker.

## What changed from the artifact
- `window.storage.get/set` (Claude-artifact-only APIs) → `fetch('/api/state')` GET/POST
  against a tiny Express server.
- State persists to a JSON file on disk instead of Claude's storage.

## Local test
```
npm install
npm start
```
Visit http://localhost:3000

## Deploy to Railway
1. Push this folder to a GitHub repo (new repo, e.g. `client-pipeline-crm`, or a
   folder in an existing monorepo — if it's a subfolder, set Railway's
   "Root Directory" to it).
2. In Railway: New Project → Deploy from GitHub repo → pick the repo.
   Railway auto-detects Node from `package.json` and runs `npm start`.
3. **Add a Volume** (Railway dashboard → your service → Settings → Volumes):
   mount path `/data`. Then set an env var `DATA_DIR=/data`.
   Without this, the JSON file lives on ephemeral storage and your pipeline
   data gets wiped on every redeploy.
4. (Optional) Set `PIPELINE_PASSWORD` env var to require a header on writes
   (this will be a public URL by default, like your other Railway apps).
   If you set it, also paste the same value into `PIPELINE_KEY` in
   `public/index.html` before deploying.
5. Railway gives you a `*.up.railway.app` domain automatically — same pattern
   as `trade-alert-bot-production.up.railway.app`.

## Notes
- This is single-user by design (JSON file, no auth by default) — fine for
  your own dashboard, not for handing to clients directly.
- If this pipeline data ever needs to be queried alongside Orion's data (e.g.
  cross-referencing which mirrored clients came from which funnel stage),
  swap the JSON file for a small SQLite or Postgres store — happy to do that
  if it comes up.
