-- Run this ONCE per environment, as a superuser, after running migrations
-- and BEFORE pointing the app's DATABASE_URL at this database.
--
-- Why this exists: RLS policies are silently ignored for the table owner
-- and for any role with BYPASSRLS. Migrations run as an owner/admin role
-- (needs CREATE TABLE etc.), but the running app must connect as a
-- separate, restricted role or every tenant-isolation policy in
-- 1754395200000_initial-schema.js does nothing.
--
-- Replace 'CHANGE_ME_STRONG_PASSWORD' before running, then put the
-- resulting connection string in .env as DATABASE_URL, e.g.:
--   postgres://argus_app:<password>@localhost:5432/argus

CREATE ROLE argus_app WITH LOGIN PASSWORD 'CHANGE_ME_STRONG_PASSWORD' NOBYPASSRLS;

GRANT CONNECT ON DATABASE argus TO argus_app;
GRANT USAGE ON SCHEMA public TO argus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO argus_app;
-- No DELETE on journal_entries: the repository layer must never issue one,
-- and now the database backs that up structurally too.
REVOKE DELETE ON journal_entries FROM argus_app;
-- Also block UPDATE on journal_entries at the grant level — "insert-only"
-- from src/journal/repository.js becomes enforced by Postgres itself,
-- not just by which methods the repository happens to export.
REVOKE UPDATE ON journal_entries FROM argus_app;

-- Login lookups for staff/seller keys run as SECURITY DEFINER functions
-- (see 1754395300000_login-lookup-functions.js) precisely so they can see
-- past RLS for that one narrow, safe-by-uniqueness query. argus_app needs
-- EXECUTE on them specifically — table grants above don't cover functions.
GRANT EXECUTE ON FUNCTION find_staff_key_for_login(TEXT) TO argus_app;
GRANT EXECUTE ON FUNCTION find_seller_key_for_login(TEXT) TO argus_app;

-- Sequences aren't used (all PKs are gen_random_uuid()), so no sequence
-- grants needed. If a future migration adds a SERIAL/IDENTITY column,
-- remember to GRANT USAGE on its sequence too.
