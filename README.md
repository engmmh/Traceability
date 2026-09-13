# UFUQ Branch Inspection System (V3 — clean rewrite)

Web replacement for the old Google Sheets / Apps Script branch-inspection
process. Same architecture and same features as V2 — this pass only makes
the code easier to read and maintain. Nothing was removed or redesigned.

```
User → GitHub Pages (this repo) → Supabase Edge Function (inspection-api) → Postgres
```

## What changed vs V2

- **Backend** (`supabase/functions/inspection-api/index.ts`): same actions,
  same database contract, but organized into clearly named/commented
  sections (env & client → HTTP helpers → auth → branch detection →
  product codes → handlers → router). Added one small, additive action:
  `ping`, for a quick connectivity check without needing to log in.
- **Frontend**: split out of one long minified HTML file into
  `index.html` (structure), `assets/style.css` (design), and
  `assets/app.js` (logic) — same screens, same buttons, same behavior.
- **Not carried over**: `server.js` / `package.json` (an old Express/Node
  backend). It was never actually deployed anywhere — the project moved to
  GitHub Pages + Supabase Edge Functions after Render was ruled out — so it
  was dead code. Nothing user-facing depended on it. Say the word if you'd
  rather keep it around for reference.

## ⚠️ One thing to check before you commit this

The old `.env.example` had `APP_PASSWORD=1243` written in as a real-looking
value. If that ever got pushed to the public `engmmh/Traceability` repo,
treat it as compromised: **change the `APP_PASSWORD` secret in Supabase**
to something new. This rewrite's `.env.example` only has a placeholder.

## File map

```
index.html                                  ← GitHub Pages entry point (must stay in repo root)
assets/style.css                            ← all styling
assets/app.js                               ← all frontend logic (login, uploads, forms, printing)
schema.sql                                  ← database tables (safe to re-run)
SECURITY.sql                                ← enables Row Level Security
supabase/config.toml                        ← disables JWT verification at the gateway (we do our own auth)
supabase/functions/inspection-api/index.ts  ← the entire backend
```

## Deploying

1. **Database** — run `schema.sql` then `SECURITY.sql` in the Supabase SQL editor (safe to re-run, uses `IF NOT EXISTS` / `ON CONFLICT`).
2. **Edge Function** — Dashboard → Edge Functions → `inspection-api` → Code → select all → delete → paste `index.ts` → Deploy.
3. **Secrets** — Edge Functions → Secrets → add `APP_PASSWORD` and `JWT_SECRET`.
4. **GitHub Pages** — Repo Settings → Pages → Branch `main`, folder `/ (root)`.
5. Open the Pages URL, log in, confirm `bootstrap` loads without console errors.

## Still pending (unchanged from before)

- Import the real 12 forms + branch↔form mapping from the old Google Sheet.
- Import the real Product Master (codes, names, groups, display order).
- Finalize the print layout once real forms are in.
- OCR for scanned (image-only) invoice PDFs — deliberately out of scope for now.
