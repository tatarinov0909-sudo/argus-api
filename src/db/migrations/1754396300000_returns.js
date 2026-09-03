/* eslint-disable camelcase */

exports.shorthands = undefined;

// Returns (возврат) — seller-initiated: a marketplace return lands on the
// warehouse and gets sorted into three buckets (confirmed by the reference
// company's owner): sellable again, defective/expired (unsellable, the
// warehouse can't fix it, seller decides what happens next), and packaging
// damage only (fixable — becomes 'good' again once repacked). Modeled as its
// own invoice direction rather than reusing 'in', because a plain receiving
// line has no quality dimension at all and forcing one in would change
// receiving's shape for a case it doesn't have.
//
// return_records mirrors shipping_records, not receiving_records: a return
// line can split across multiple buckets (7 good + 2 defective + 1 packaging
// damage out of one declared line), so multiple rows per invoice_item are
// allowed, same as a multi-cell shipping pick. cell_block_id is nullable —
// a defective/packaging-damage bucket doesn't have to be shelved anywhere to
// be recorded; only a 'good' bucket normally gets a real cell.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TYPE invoice_direction ADD VALUE IF NOT EXISTS 'return';

    CREATE TYPE return_quality AS ENUM ('good', 'defective', 'packaging_defect');

    CREATE TABLE return_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_item_id UUID NOT NULL REFERENCES invoice_items(id) ON DELETE CASCADE,
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      quality_bucket return_quality NOT NULL,
      qty NUMERIC NOT NULL CHECK (qty > 0),
      cell_block_id UUID REFERENCES cell_blocks(id) ON DELETE SET NULL,
      worker_key_id UUID REFERENCES staff_keys(id) ON DELETE SET NULL,
      finished_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      paused_ms INT NOT NULL DEFAULT 0,
      pause_reasons JSONB NOT NULL DEFAULT '[]'::jsonb
    );

    CREATE INDEX idx_return_records_item ON return_records(invoice_item_id);
    CREATE INDEX idx_return_records_warehouse ON return_records(warehouse_id);
    CREATE INDEX idx_return_records_company ON return_records(company_id);

    -- Same policy shape as receiving_records/shipping_records: warehouse side
    -- sees everything in its warehouse, seller sees only their own company's
    -- rows.
    ALTER TABLE return_records ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON return_records USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );
  `);

  // setup-app-role.sql's GRANT is a one-time snapshot at the time it was run —
  // any table created by a later migration needs its own grant, guarded on
  // the role existing so a fresh dev database can still migrate before that
  // role is ever created. Same footgun documented in the shipping migration.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON return_records TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS return_records CASCADE;
    DROP TYPE IF EXISTS return_quality;
  `);
  // invoice_direction 'return' value itself is not removable (see the
  // order-statuses migration for why) — down is partial by necessity.
};
