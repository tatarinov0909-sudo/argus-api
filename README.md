# argus-api

Backend for Аргус (argus-ai.online) — Phase 1: real auth + persistence, replacing
the hardcoded JS objects the frontend prototype used to run on. See
`C:\Users\tatar\.claude\plans\delegated-coalescing-eagle.md` for the full design
rationale (why this schema, why RLS, what's deliberately deferred to later phases:
1C sync, LLM agents, automatic risk classification, billing).

## Stack

Node.js + Express, PostgreSQL with Row-Level Security for tenant isolation, JWT auth.
The static frontend is two separate repos — [argus-product](https://github.com/tatarinov0909-sudo/argus-product)
(the working app: owner cabinet, worker screen, seller access) and
[argus-landing](https://github.com/tatarinov0909-sudo/argus-landing) (marketing page only) —
both on reg.ru shared hosting, calling this API at `https://api.argus-ai.online`.

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

Already live: reg.ru Cloud VPS (Russia region), Node via pm2, Postgres 16 in
Docker (bound to 127.0.0.1 only), nginx + Let's Encrypt fronting
`https://api.argus-ai.online`. `deploy/provision-vps.sh` documents that setup
from scratch (Node, Postgres, nginx, certbot, pm2) — re-run it as a checklist
if this ever needs to move to a new server. For an ordinary code update:
upload the changed files (FTP-style file copy, same as the static frontend),
run any new migration with an admin `DATABASE_URL`, then `pm2 restart argus-api`.

## Project layout

One folder per domain under `src/`: `auth`, `warehouses`, `staff`, `sellers`,
`cells`, `dropzones`, `invoices`, `receiving`, `journal`. Each has `routes.js`
(and `service.js`/`repository.js` where the logic is more than route glue).
`src/middleware/auth.js` verifies JWTs; `src/auth/tenantContext.js` turns a
verified JWT into the `{warehouseId, companyId}` pair every DB call must be
scoped by — read the comment there before touching anything seller-facing,
it's the fix for a tenant-isolation bug this project already shipped once.

Any login/lookup query that runs *before* tenant context can be set (finding
a key or a warehouse by something other than its own RLS-protected id) needs
a narrow `SECURITY DEFINER` SQL function — see migrations 300000/400000/500000
and the matching `GRANT EXECUTE` lines in `setup-app-role.sql` for the
existing examples (`find_staff_key_for_login`, `find_seller_key_for_login`,
`find_owner_warehouse`). A plain `SELECT` under `argus_app` in that situation
silently returns zero rows instead of erroring — it looks like "not found,"
not like a permissions problem, so it's easy to miss.
