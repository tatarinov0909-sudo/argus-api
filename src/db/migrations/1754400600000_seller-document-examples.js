exports.up = pgm => pgm.sql(`
  CREATE TABLE seller_document_examples (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    source_invoice_id UUID NOT NULL,
    snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(company_id,source_invoice_id)
  );
  ALTER TABLE seller_document_examples ENABLE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON seller_document_examples USING (
    warehouse_id=NULLIF(current_setting('app.current_warehouse_id',true),'')::uuid
    OR company_id=NULLIF(current_setting('app.current_company_id',true),'')::uuid
  );
  DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='argus_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON seller_document_examples TO argus_app;
  END IF; END $$;
`);
exports.down = pgm => pgm.sql('DROP TABLE seller_document_examples');
