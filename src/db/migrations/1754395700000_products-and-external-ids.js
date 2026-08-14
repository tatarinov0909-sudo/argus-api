/* eslint-disable camelcase */

exports.shorthands = undefined;

// Two things 1C sync structurally cannot work without, added together because
// they only make sense as a pair:
//
// 1. A products directory. Until now `sku` was a bare TEXT string copied into
//    every invoice line, with no category (needed to group goods for packing)
//    and no dimensions (needed to judge whether something fits a cell). Those
//    live on the 1C nomenclature card and have nowhere to land here.
//
// 2. external_id — the 1C identifier — on every entity that crosses the
//    boundary. Without it a sync cannot tell "our ООО Ромашка" from "1C's
//    ООО Ромашка"; matching by name would silently merge or duplicate rows.
//    Adding these AFTER sync logic exists would mean back-filling by hand,
//    which is exactly what this avoids.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE products (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      -- In a fulfillment centre every SKU belongs to a seller, never to the
      -- warehouse itself — same scoping cell_stock and invoice_items already use.
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      sku TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      -- Millimetres and grams: integers in practice, NUMERIC so a 1C card
      -- carrying fractional values can't fail the import.
      length_mm NUMERIC,
      width_mm NUMERIC,
      height_mm NUMERIC,
      weight_g NUMERIC,
      -- 1C archives nomenclature rather than deleting it; mirror that instead
      -- of removing rows that historical documents still point at.
      active BOOLEAN NOT NULL DEFAULT true,
      external_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (warehouse_id, company_id, sku)
    );

    -- No FK from invoice_items to products on purpose: a document must keep
    -- recording what was declared at the time even if the directory later
    -- changes, and (warehouse_id, company_id, sku) already joins the two.
    CREATE INDEX idx_products_warehouse ON products(warehouse_id);
    CREATE INDEX idx_products_company ON products(company_id);
    CREATE INDEX idx_products_lookup ON products(warehouse_id, company_id, sku);

    ALTER TABLE companies     ADD COLUMN external_id TEXT;
    ALTER TABLE invoices      ADD COLUMN external_id TEXT;
    ALTER TABLE invoice_items ADD COLUMN external_id TEXT;

    -- One warehouse maps to one 1C base, so a 1C id is unique per warehouse.
    -- Partial indexes: rows created by hand have no 1C id yet, and NULLs must
    -- not collide with each other.
    CREATE UNIQUE INDEX idx_products_external
      ON products(warehouse_id, external_id) WHERE external_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_companies_external
      ON companies(warehouse_id, external_id) WHERE external_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_invoices_external
      ON invoices(warehouse_id, external_id) WHERE external_id IS NOT NULL;
    CREATE INDEX idx_invoice_items_external
      ON invoice_items(warehouse_id, external_id) WHERE external_id IS NOT NULL;

    -- Same shape as invoices: the warehouse side sees everything, a seller
    -- sees their own catalogue and nothing else.
    ALTER TABLE products ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON products USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );
  `);

  // setup-app-role.sql granted "ON ALL TABLES" as a one-time snapshot, so any
  // table created later starts with no privileges for argus_app and the app
  // fails with "permission denied" on first use. Guarded on the role existing
  // so a fresh dev database can still migrate.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON products TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS products CASCADE;
    DROP INDEX IF EXISTS idx_companies_external;
    DROP INDEX IF EXISTS idx_invoices_external;
    DROP INDEX IF EXISTS idx_invoice_items_external;
    ALTER TABLE companies     DROP COLUMN IF EXISTS external_id;
    ALTER TABLE invoices      DROP COLUMN IF EXISTS external_id;
    ALTER TABLE invoice_items DROP COLUMN IF EXISTS external_id;
  `);
};
