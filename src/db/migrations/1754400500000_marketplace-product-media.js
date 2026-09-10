exports.up = pgm => pgm.sql(`
  ALTER TABLE marketplace_credentials
    ADD COLUMN photo_cursor JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN photo_sync_after TIMESTAMPTZ;
  CREATE TABLE marketplace_product_media (
    credential_id UUID NOT NULL REFERENCES marketplace_credentials(id) ON DELETE CASCADE,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    nm_id TEXT NOT NULL,
    photo_url TEXT,
    credential_version TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (credential_id, nm_id)
  );
  CREATE INDEX marketplace_media_company ON marketplace_product_media(company_id, nm_id);
  ALTER TABLE marketplace_product_media ENABLE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON marketplace_product_media USING (
    warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
  );
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
      GRANT SELECT,INSERT,UPDATE,DELETE ON marketplace_product_media TO argus_app;
    END IF;
  END $$;
`);
exports.down = pgm => pgm.sql(`
  DROP TABLE marketplace_product_media;
  ALTER TABLE marketplace_credentials DROP COLUMN photo_cursor, DROP COLUMN photo_sync_after;
`);
