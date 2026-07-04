# EM2 D2P1 Meeting Kit Generator — Production Deployment (v4.0)

Self-hosted build. Same five-stage pipeline and four exports as the app,
served from EM2 infrastructure. API keys live on the server only.

## What Otobong needs (≈15 minutes)
1. **Server**: any box with Node 18+ (a $6/mo VPS is plenty).
2. **Upload** this folder, then:
       npm install --omit=dev
       cp .env.example .env
3. **Edit `.env`** with two keys:
   - `ANTHROPIC_API_KEY` — console.anthropic.com → API Keys (usage bills to this key)
   - `AHREFS_API_KEY` — Ahrefs → Account settings → API keys
   - Optional: `APP_PASSCODE` (recommended — gates the app), `PORT` (default 8787)
4. **Run**:
       node server.js            # or: pm2 start server.js --name d2p1
5. **Point a subdomain** (suggest `d2p1.ethosm2.com`) at it. Minimal nginx:
       location / { proxy_pass http://127.0.0.1:8787; }
   Add TLS via certbot as usual.
6. **Open the URL → hit "System check."** Expected:
   `server ✓ · model ✓ · structured output ✓ · Ahrefs ✓ (units left)`

## Smoke tests (curl)
    curl -s http://127.0.0.1:8787/api/health
    curl -s -X POST http://127.0.0.1:8787/api/ahrefs -H 'content-type: application/json' -d '{"probe":true}'
    curl -s -X POST http://127.0.0.1:8787/api/ahrefs -H 'content-type: application/json' -d '{"domain":"occc.edu"}'

## Endpoints
- `GET  /api/health` — liveness + key presence
- `POST /api/claude` — Anthropic Messages proxy (field-allowlisted)
- `POST /api/ahrefs` — deterministic Ahrefs pull: batch-analysis +
  ai-responses-count, normalized (USD, AI-citation totals). `{probe:true}`
  hits the free subscription-info endpoint.

Ahrefs REST reference if paths ever change: docs.ahrefs.com/docs/api/reference
(then adjust `AHREFS_BASE` or the two paths in server.js — errors from the
server include the upstream status and body head, so any mismatch is a
one-line diagnosis).

## Cost notes
- Ahrefs: ~130 API units per entity pull (Lite plan: 100,000/mo). Probe is free.
- Anthropic: a full 5-stage run is a handful of Sonnet calls billed to your key.

## Verified before handoff (in-session)
- Full-stack E2E over real HTTP: real server + real front-end, OCCC packet,
  System check clean, all five stages, all four export buttons enabled,
  domain normalization confirmed at the server boundary.
- Front-end logic is the same code that passed the 8-suite verification
  (happy path, sabotage recovery, parser repair ×6, export validation).
