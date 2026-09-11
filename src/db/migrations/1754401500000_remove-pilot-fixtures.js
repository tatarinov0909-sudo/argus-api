/* eslint-disable camelcase */

exports.shorthands = undefined;

// Production cleanup after the first cabinet pilot.
//
// A company can be retired without deleting its source history. Archived
// companies disappear from operational screens and their access keys stop
// working, while their rows remain available for a controlled reassignment.
//
// `cell_stock.source = '1c'` was an early inference that placed an accounting
// balance on a shelf nobody had counted. 1C quantities and addresses already
// live in products.stock_qty_1c and product_cells_1c, so those inferred shelf
// rows are removed. The constraint prevents that shortcut from returning.
//
// Seller document examples were a pilot-only preview. Real seller documents
// now come from the seller's own mapped 1C records, so the snapshot table is
// removed together with the feature.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE companies ADD COLUMN archived_at TIMESTAMPTZ;
    CREATE INDEX idx_companies_active
      ON companies (warehouse_id, created_at) WHERE archived_at IS NULL;

    CREATE OR REPLACE FUNCTION find_seller_key_for_login(p_key_code TEXT)
    RETURNS TABLE(id UUID, company_id UUID, warehouse_id UUID, active BOOLEAN, company_name TEXT)
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      SELECT sk.id, sk.company_id, sk.warehouse_id, sk.active, c.name AS company_name
      FROM seller_keys sk JOIN companies c ON c.id = sk.company_id
      WHERE sk.key_code = p_key_code AND c.archived_at IS NULL;
    $$;

    CREATE OR REPLACE FUNCTION seller_key_is_active(p_id UUID)
    RETURNS BOOLEAN
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      SELECT COALESCE((
        SELECT sk.active AND c.archived_at IS NULL
        FROM seller_keys sk JOIN companies c ON c.id = sk.company_id
        WHERE sk.id = p_id
      ), false);
    $$;

    DROP TABLE IF EXISTS seller_document_examples;

    DELETE FROM cell_stock WHERE source = '1c';
    UPDATE cell_blocks cb
       SET state = CASE WHEN EXISTS (
             SELECT 1 FROM cell_stock cs WHERE cs.cell_block_id = cb.id AND cs.qty > 0
           ) THEN 'occupied'::cell_state ELSE 'empty'::cell_state END,
           fill_pct = NULL,
           updated_at = now();
    ALTER TABLE cell_stock
      ADD CONSTRAINT cell_stock_physical_source_only CHECK (source IS NULL);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE cell_stock DROP CONSTRAINT IF EXISTS cell_stock_physical_source_only;

    CREATE TABLE seller_document_examples (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      source_invoice_id UUID NOT NULL,
      snapshot JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(company_id, source_invoice_id)
    );
    ALTER TABLE seller_document_examples ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON seller_document_examples USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='argus_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON seller_document_examples TO argus_app;
    END IF; END $$;

    CREATE OR REPLACE FUNCTION find_seller_key_for_login(p_key_code TEXT)
    RETURNS TABLE(id UUID, company_id UUID, warehouse_id UUID, active BOOLEAN, company_name TEXT)
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      SELECT sk.id, sk.company_id, sk.warehouse_id, sk.active, c.name AS company_name
      FROM seller_keys sk JOIN companies c ON c.id = sk.company_id
      WHERE sk.key_code = p_key_code;
    $$;

    CREATE OR REPLACE FUNCTION seller_key_is_active(p_id UUID)
    RETURNS BOOLEAN
    LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
      SELECT COALESCE((SELECT active FROM seller_keys WHERE id = p_id), false);
    $$;

    DROP INDEX IF EXISTS idx_companies_active;
    ALTER TABLE companies DROP COLUMN archived_at;
  `);
};
