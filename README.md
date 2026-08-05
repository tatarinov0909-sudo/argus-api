# argus-api

Backend for Аргус (argus-ai.online) — Phase 1: real auth + persistence, replacing
the hardcoded JS objects the frontend prototype used to run on. See
`C:\Users\tatar\.claude\plans\delegated-coalescing-eagle.md` for the full design
rationale (why this schema, why RLS, what's deliberately deferred to later phases:
1C sync, LLM agents, automatic risk classification, billing).

## Stack

Node.js + Express, PostgreSQL with Row-Level Security for tenant isolation, JWT auth.
The static frontend (separate repo, `C:\Users\tatar\Desktop\argus-1`) stays where it
is on reg.ru shared hosting and calls this API at `https://api.argus-ai.online`.

## Local setup

```
npm install
cp .env.example .env   # fill in DATABASE_URL, JWT_SECRET
npm run migrate:up
psql -f src/db/setup-app-role.sql   # edit the password in the file first
npm run dev
```

`setup-app-role.sql` matters — it creates the restricted `argus_app` role the
app must connect as. If the app connects as the migration/owner role instead,
every RLS policy in the schema is silently ignored. See the comment at the
top of that file.

## Testing

```
npm test
```

Requires a real Postgres database (migrations + `argus_app` role already set
up) reachable via `DATABASE_URL` — not runnable against an in-memory mock,
since the tests specifically verify Postgres RLS and grant behavior.

## Deploying

`deploy/provision-vps.sh` — run once on a fresh Ubuntu VPS as root. Installs
Node, Postgres, nginx, certbot, pm2, and prints the remaining manual steps
(copy the app up, run migrations, set up the app DB role, get a cert).

## Project layout

One folder per domain under `src/`: `auth`, `warehouses`, `staff`, `sellers`,
`cells`, `dropzones`, `invoices`, `receiving`, `journal`. Each has `routes.js`
(and `service.js`/`repository.js` where the logic is more than route glue).
`src/middleware/auth.js` verifies JWTs; `src/auth/tenantContext.js` turns a
verified JWT into the `{warehouseId, companyId}` pair every DB call must be
scoped by — read the comment there before touching anything seller-facing,
it's the fix for a tenant-isolation bug this project already shipped once.
