exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE vw_transfer_batches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL,
      request_id UUID NOT NULL,
      payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
      result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY (warehouse_id,company_id) REFERENCES companies(warehouse_id,id) ON DELETE CASCADE,
      UNIQUE (warehouse_id,company_id,request_id)
    );
    ALTER TABLE vw_transfer_batches ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON vw_transfer_batches
      USING (warehouse_id=NULLIF(current_setting('app.current_warehouse_id',true),'')::uuid)
      WITH CHECK (warehouse_id=NULLIF(current_setting('app.current_warehouse_id',true),'')::uuid);
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='argus_app') THEN
      GRANT SELECT,INSERT,UPDATE,DELETE ON vw_transfer_batches TO argus_app;
    END IF; END $$;
    CREATE INDEX idx_products_transfer_page ON products(warehouse_id,company_id,sku COLLATE "C") WHERE active;
    CREATE INDEX idx_vw_move_tasks_transfer_source ON vw_move_tasks(warehouse_id,company_id,sku,from_vw)
      WHERE status='open' AND kind='transfer' AND quality='good';
  `);
};
exports.down = (pgm) => pgm.sql('DROP INDEX idx_vw_move_tasks_transfer_source; DROP INDEX idx_products_transfer_page; DROP TABLE vw_transfer_batches;');
