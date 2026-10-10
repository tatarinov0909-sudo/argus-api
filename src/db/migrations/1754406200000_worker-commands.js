exports.up = (pgm) => pgm.sql(`
  CREATE TABLE worker_commands (
    warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    operation_id UUID NOT NULL,
    worker_key_id UUID NOT NULL,
    operation TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    result JSONB,
    occurred_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (warehouse_id, operation_id)
  );
  ALTER TABLE worker_commands ENABLE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON worker_commands
    USING (warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid)
    WITH CHECK (warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid);
  ALTER TABLE work_sessions ADD COLUMN event_sequence INTEGER NOT NULL DEFAULT 0 CHECK (event_sequence >= 0),
    ADD COLUMN last_event_at TIMESTAMPTZ;
  DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
    GRANT SELECT, INSERT, UPDATE ON worker_commands TO argus_app;
  END IF; END $$;
`);

exports.down = (pgm) => pgm.sql(`
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM worker_commands) OR EXISTS (SELECT 1 FROM work_sessions WHERE event_sequence > 0) THEN
      RAISE EXCEPTION 'Worker command history is in use; preserve it when rolling back the application';
    END IF;
  END $$;
  DROP TABLE worker_commands;
  ALTER TABLE work_sessions DROP COLUMN event_sequence, DROP COLUMN last_event_at;
`);
