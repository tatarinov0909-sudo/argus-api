/* eslint-disable camelcase */

exports.shorthands = undefined;

// The transport layer for 1C. Two tables and one lookup function:
//
// integration_keys — the .epf module needs its own credential. It is not a
//   person, so neither the owner password nor a staff key fits: it must be
//   revocable on its own, and compromising it must not hand over an owner
//   session. One key per warehouse, revocable like every other key here.
//
// sync_outbox — an ordered log of movements 1C has yet to post. 1C cannot be
//   queried in real time and may be offline for hours, so pushing at it is
//   hopeless; instead it asks "what happened after id N?" and we answer from
//   here. That demands a MONOTONIC cursor, which is why this is the only
//   table in the schema with an integer key instead of a UUID — UUIDs give no
//   ordering to page by. Rows are written inside the same transaction as the
//   movement itself, so a movement can never be recorded without its
//   corresponding sync event.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE integration_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      key_code TEXT NOT NULL UNIQUE,
      label TEXT,
      active BOOLEAN NOT NULL DEFAULT true,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ,
      -- Lets the owner see at a glance whether the 1C module is still talking
      -- to us. Silent sync failure is the likeliest real-world breakage: the
      -- warehouse closes 1C and nobody notices data has stopped flowing.
      last_seen_at TIMESTAMPTZ
    );

    -- GENERATED AS IDENTITY rather than SERIAL deliberately: setup-app-role.sql
    -- notes that a SERIAL column would also need USAGE granted on its sequence,
    -- which is easy to forget. An identity column's sequence is owned by the
    -- column and needs no separate grant.
    CREATE TABLE sync_outbox (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- NULL until 1C confirms it posted the event. Kept rather than deleted so
      -- a failed 1C-side posting can be investigated after the fact.
      delivered_at TIMESTAMPTZ
    );

    CREATE INDEX idx_integration_keys_warehouse ON integration_keys(warehouse_id);
    -- The exact shape of the "give me everything after N" query.
    CREATE INDEX idx_sync_outbox_cursor ON sync_outbox(warehouse_id, id);

    ALTER TABLE integration_keys ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON integration_keys USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );

    -- Warehouse-scoped only: sync is between one warehouse and its own 1C.
    -- Sellers have no business seeing it, so no company_id clause here.
    ALTER TABLE sync_outbox ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON sync_outbox USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );

    -- Same bootstrap problem the staff/seller key lookups have: the key IS how
    -- we learn which warehouse to scope to, so the lookup cannot itself be
    -- scoped. Safe for the same reason — key_code is globally UNIQUE, so an
    -- exact-match lookup returns at most the single row that key belongs to.
    CREATE FUNCTION find_integration_key_for_login(p_key_code TEXT)
    RETURNS TABLE(id UUID, warehouse_id UUID, active BOOLEAN)
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      SELECT id, warehouse_id, active FROM integration_keys WHERE key_code = p_key_code;
    $$;
  `);

  // setup-app-role.sql grants privileges as a one-time snapshot — both its
  // "ON ALL TABLES" and its explicit per-function EXECUTE grants. On an
  // already-deployed database that script has long since run, so anything
  // created here starts with no privileges at all and fails at first use.
  // setup-app-role.sql is updated in the same change for fresh installs.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON integration_keys TO argus_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON sync_outbox TO argus_app;
        GRANT EXECUTE ON FUNCTION find_integration_key_for_login(TEXT) TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP FUNCTION IF EXISTS find_integration_key_for_login(TEXT);
    DROP TABLE IF EXISTS sync_outbox CASCADE;
    DROP TABLE IF EXISTS integration_keys CASCADE;
  `);
};
