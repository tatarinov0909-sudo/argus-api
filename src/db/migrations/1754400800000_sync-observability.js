exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE invoices ADD COLUMN source_document_type TEXT;
    ALTER TABLE invoices ADD COLUMN source_document_date TEXT;
    COMMENT ON COLUMN invoices.source_document_date IS
      'Дата исходного документа в локальном времени 1С, без придуманного часового пояса.';

    CREATE TABLE integration_sync_state (
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      integration_key_id UUID NOT NULL REFERENCES integration_keys(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      module_version TEXT,
      run_mode TEXT CHECK (run_mode IN ('automatic', 'manual')),
      record_count INTEGER NOT NULL CHECK (record_count >= 0),
      summary JSONB NOT NULL,
      PRIMARY KEY (warehouse_id, integration_key_id, stage)
    );
    ALTER TABLE integration_sync_state ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON integration_sync_state USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON integration_sync_state TO argus_app;
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE integration_sync_state;
    ALTER TABLE invoices DROP COLUMN source_document_type;
    ALTER TABLE invoices DROP COLUMN source_document_date;
  `);
};
