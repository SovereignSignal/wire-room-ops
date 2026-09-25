# AGENTS.md

**Read `CLAUDE.md`** — it is the single maintained AI-context file for this repo (project overview, file tree, pipeline, database, schedule types, auth, API surface, common tasks). This file is only a pointer so the two can never drift apart again.

Agent-specific references:

- `STRINGER.md` — The Stringer agent's mandate, endpoints, and scan log
- `agents/daily-scan.md` — the daily grant-scan agent runbook (editorial standards, submit/brief API contract)

## Cursor Cloud specific instructions

Standard commands live in `README.md` (Quick Start) and `package.json` scripts; CI's canonical pipeline is `.github/workflows/ci.yml`. Notes below are the non-obvious, environment-specific caveats.

- **PostgreSQL must be started each session.** The update script only refreshes npm deps. Start the local DB with `sudo pg_ctlcluster 16 main start`. Apply schema changes explicitly with `npm run db:migrate -- --apply`, or use `npx ts-node --transpile-only scripts/ci-db-setup.ts` for CI. Server boot verifies the schema version without DDL. If a dev DB is missing, recreate it and run the migration command before starting the app.
- **`.env` is gitignored and preconfigured for local dev** (`DATABASE_URL` → local Postgres, `DB_SSL_REJECT_UNAUTHORIZED=false`, dummy `PRIVY_*`/`NOTIFICATION_EMAIL` to satisfy `validateConfig()`, and `DEV_MODE=true` to bypass Privy auth). It is not committed, so recreate it if the workspace is reset.
- **Two dev workflows** (see README): single-server = `npm run build:client` then `npm run dev` → http://localhost:3000; hot-reload = `npm run dev` (backend :3000) + `npm run dev:client` (Vite :5173, proxies `/api`).
- **CSRF origin gotcha:** the backend rejects state-changing requests whose `Origin`/`Referer` host ≠ `APP_URL` (`src/server.ts`) with `403 Forbidden: origin mismatch`. `APP_URL` in `.env` must match the browser origin — `http://localhost:5173` for the Vite hot-reload workflow (current default), or `http://localhost:3000` for single-server. GETs are unaffected, so this only bites on approve/decline/save actions.
- **Tests + `DEV_MODE`:** run with `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wireops_test npm test`. Because dotenv loads `.env` (which sets `DEV_MODE=true`) into the test process, the 3 auth-enforcement tests in `tests/routes-auth.test.js` fail. Prefix with `DEV_MODE=false` to match CI (all 569 pass): `DEV_MODE=false DATABASE_URL=...wireops_test npm test`.
- **Missing external services are expected locally:** the `summaries` table belongs to the sibling `tele-sum` service and does not exist here — summary-sync and approve write-through log a harmless "does not exist" skip. Optional API keys (Anthropic/Grok/Firecrawl/Resend/…) are unset, so LLM classification stays `UNCHECKED` and auto-summarize/distribution no-op. Intake, dedup, queue, and approve still work end to end without them.
