/* eslint-disable camelcase */

exports.shorthands = undefined;

// Outbound (отгрузка) — the mirror of receiving. Deliberately reuses
// invoices/invoice_items rather than duplicating them: an outbound order has
// exactly the same shape as an inbound one (company, number, line items with a
// declared qty), the only difference is which direction the goods move. A
// `direction` discriminator keeps one code path for listing/detail instead of
// two near-identical tables that would then both need 1C sync wiring later.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE invoice_direction AS ENUM ('in', 'out');

    -- Every invoice that already exists predates outbound support and is,
    -- by definition, a receiving document — hence the 'in' default.
    ALTER TABLE invoices
      ADD COLUMN direction invoice_direction NOT NULL DEFAULT 'in';

    -- Mirrors receiving_records, with three meaningful differences:
    --   * picked_qty vs accepted_qty — what the worker actually pulled off
    --     the shelf, which may be less than declared if the cell is short.
    --   * cell_block_id is where the goods came FROM (receiving records where
    --     they went TO).
    --   * MULTIPLE rows per invoice_item are allowed, unlike receiving's
    --     one-record-per-item rule. One SKU routinely sits in several cells,
    --     and the worker physically walks to each of them — forcing a single
    --     row would make it impossible to record what actually happened.
    --     is_final marks the pick that closes the line ("that's all there is"),
    --     which is what turns a short pick into a reportable discrepancy
    --     rather than an in-progress line.
    CREATE TABLE shipping_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_item_id UUID NOT NULL REFERENCES invoice_items(id) ON DELETE CASCADE,
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      picked_qty NUMERIC,
      cell_block_id UUID REFERENCES cell_blocks(id) ON DELETE SET NULL,
      worker_key_id UUID REFERENCES staff_keys(id) ON DELETE SET NULL,
      is_final BOOLEAN NOT NULL DEFAULT true,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      paused_ms INT NOT NULL DEFAULT 0,
      pause_reasons JSONB NOT NULL DEFAULT '[]'::jsonb
    );

    CREATE INDEX idx_shipping_records_item ON shipping_records(invoice_item_id);
    CREATE INDEX idx_shipping_records_warehouse ON shipping_records(warehouse_id);
    CREATE INDEX idx_shipping_records_company ON shipping_records(company_id);
    CREATE INDEX idx_invoices_direction ON invoices(warehouse_id, direction);

    -- Lets the "which cells hold this SKU?" lookup in the shipping suggest
    -- endpoint hit an index instead of scanning every block in the warehouse.
    CREATE INDEX idx_cell_stock_lookup ON cell_stock(warehouse_id, company_id, sku);

    -- Same policy shape as receiving_records: the warehouse side (owner and
    -- workers) sees everything in its warehouse, and a seller sees rows for
    -- their own company — so a seller can check what was shipped for them
    -- without ever seeing another company's movements.
    ALTER TABLE shipping_records ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON shipping_records USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );
  `);

  // setup-app-role.sql grants "ON ALL TABLES IN SCHEMA public", which is a
  // one-time snapshot taken when that script runs — it does NOT cover tables
  // created afterwards, and there is no ALTER DEFAULT PRIVILEGES backing it up.
  // Without this grant the app connects fine and then fails with "permission
  // denied for table shipping_records" on the first pick. Guarded on the role
  // existing so a fresh dev database (where argus_app was never created) can
  // still migrate.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON shipping_records TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS shipping_records CASCADE;
    DROP INDEX IF EXISTS idx_cell_stock_lookup;
    DROP INDEX IF EXISTS idx_invoices_direction;
    ALTER TABLE invoices DROP COLUMN IF EXISTS direction;
    DROP TYPE IF EXISTS invoice_direction;
  `);
};
