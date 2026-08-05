/* eslint-disable camelcase */

exports.shorthands = undefined;

// Everything in one migration: this is the very first schema, and the
// RLS policies need to see the final table shapes anyway. Split into
// separate migrations once the schema has real history to preserve.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TYPE cell_state AS ENUM ('empty', 'occupied');
    CREATE TYPE dropzone_direction AS ENUM ('in', 'out');
    CREATE TYPE invoice_status AS ENUM ('open', 'in_progress', 'completed');
    CREATE TYPE journal_status AS ENUM ('auto', 'pending', 'confirmed', 'rolled_back');

    -- ===================== Core tenancy =====================

    CREATE TABLE owners (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE warehouses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_id UUID NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      city TEXT,
      warehouse_code TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE staff_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      key_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT true,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ
    );

    CREATE TABLE companies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- company_id is the ONLY FK a seller key carries — structurally
    -- impossible for one key to resolve to more than one company.
    -- warehouse_id is denormalized from companies.warehouse_id so the
    -- owner can list/revoke keys without a join, and so RLS stays cheap.
    CREATE TABLE seller_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      key_code TEXT NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT true,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ
    );

    -- ===================== Warehouse layout =====================

    CREATE TABLE warehouse_rows (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      row_num INT NOT NULL,
      rack_count INT NOT NULL,
      tier_count INT NOT NULL,
      UNIQUE (warehouse_id, row_num)
    );

    -- Pure geometry: a rectangular block of racks x tiers within one row.
    -- No sku/qty here on purpose — see cell_stock.
    CREATE TABLE cell_blocks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_row_id UUID NOT NULL REFERENCES warehouse_rows(id) ON DELETE CASCADE,
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      rack_start INT NOT NULL,
      rack_end INT NOT NULL,
      tier_start INT NOT NULL,
      tier_end INT NOT NULL,
      state cell_state NOT NULL DEFAULT 'empty',
      fill_pct INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- What's actually stored in a block. Kept separate from cell_blocks
    -- so a merged block can hold more than one company/sku without a
    -- schema change (needed once 1C reconciliation lands).
    CREATE TABLE cell_stock (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      cell_block_id UUID NOT NULL REFERENCES cell_blocks(id) ON DELETE CASCADE,
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
      sku TEXT NOT NULL,
      qty NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE dropzones (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      zone_num INT NOT NULL,
      label TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (warehouse_id, zone_num)
    );

    CREATE TABLE dropzone_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      dropzone_id UUID NOT NULL REFERENCES dropzones(id) ON DELETE CASCADE,
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
      sku TEXT NOT NULL,
      qty NUMERIC NOT NULL DEFAULT 0,
      direction dropzone_direction NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- ===================== Invoices / receiving =====================

    CREATE TABLE invoices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      number TEXT NOT NULL,
      status invoice_status NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (warehouse_id, number)
    );

    CREATE TABLE invoice_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sku TEXT NOT NULL,
      declared_qty NUMERIC NOT NULL
    );

    CREATE TABLE receiving_records (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_item_id UUID NOT NULL REFERENCES invoice_items(id) ON DELETE CASCADE,
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      accepted_qty NUMERIC,
      cell_block_id UUID REFERENCES cell_blocks(id) ON DELETE SET NULL,
      worker_key_id UUID REFERENCES staff_keys(id) ON DELETE SET NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      paused_ms INT NOT NULL DEFAULT 0,
      pause_reasons JSONB NOT NULL DEFAULT '[]'::jsonb
    );

    -- ===================== Journal (append-only) =====================

    CREATE TABLE journal_entries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      agent TEXT NOT NULL,
      action_text TEXT NOT NULL,
      entity_type TEXT,
      entity_id UUID,
      actor_type TEXT NOT NULL,
      actor_id UUID,
      status journal_status NOT NULL DEFAULT 'auto',
      root_entry_id UUID REFERENCES journal_entries(id),
      related_entry_id UUID REFERENCES journal_entries(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      resolved_by_owner_id UUID REFERENCES owners(id)
    );

    -- ===================== Indexes =====================

    CREATE INDEX idx_staff_keys_warehouse ON staff_keys(warehouse_id);
    CREATE INDEX idx_companies_warehouse ON companies(warehouse_id);
    CREATE INDEX idx_seller_keys_warehouse ON seller_keys(warehouse_id);
    CREATE INDEX idx_seller_keys_company ON seller_keys(company_id);
    CREATE INDEX idx_warehouse_rows_warehouse ON warehouse_rows(warehouse_id);
    CREATE INDEX idx_cell_blocks_warehouse ON cell_blocks(warehouse_id);
    CREATE INDEX idx_cell_blocks_row ON cell_blocks(warehouse_row_id);
    CREATE INDEX idx_cell_stock_block ON cell_stock(cell_block_id);
    CREATE INDEX idx_cell_stock_warehouse ON cell_stock(warehouse_id);
    CREATE INDEX idx_dropzones_warehouse ON dropzones(warehouse_id);
    CREATE INDEX idx_dropzone_items_zone ON dropzone_items(dropzone_id);
    CREATE INDEX idx_dropzone_items_warehouse ON dropzone_items(warehouse_id);
    CREATE INDEX idx_dropzone_items_company ON dropzone_items(company_id);
    CREATE INDEX idx_invoices_warehouse ON invoices(warehouse_id);
    CREATE INDEX idx_invoices_company ON invoices(company_id);
    CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id);
    CREATE INDEX idx_invoice_items_warehouse ON invoice_items(warehouse_id);
    CREATE INDEX idx_invoice_items_company ON invoice_items(company_id);
    CREATE INDEX idx_receiving_records_item ON receiving_records(invoice_item_id);
    CREATE INDEX idx_receiving_records_warehouse ON receiving_records(warehouse_id);
    CREATE INDEX idx_receiving_records_company ON receiving_records(company_id);
    CREATE INDEX idx_journal_entries_warehouse_created ON journal_entries(warehouse_id, created_at DESC);
    CREATE INDEX idx_journal_entries_root ON journal_entries(root_entry_id);

    -- ===================== Row-Level Security =====================
    -- Every tenant table is scoped by a session var set once per request
    -- in withTenantContext() (src/db/pool.js): app.current_warehouse_id
    -- for owner/worker sessions, app.current_company_id for seller
    -- sessions. NULLIF(...,'')::uuid turns an unset var into NULL instead
    -- of a cast error, and "column = NULL" correctly matches zero rows —
    -- so a request with no tenant context set sees nothing, by default.

    ALTER TABLE warehouses ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON warehouses USING (
      id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );

    ALTER TABLE staff_keys ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON staff_keys USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );

    ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON companies USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );

    ALTER TABLE seller_keys ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON seller_keys USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );

    ALTER TABLE warehouse_rows ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON warehouse_rows USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );

    ALTER TABLE cell_blocks ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON cell_blocks USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );

    -- cell_stock is warehouse-internal (owner/worker only) — sellers see
    -- receiving reports via invoices/receiving_records, not shelf placement.
    ALTER TABLE cell_stock ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON cell_stock USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );

    ALTER TABLE dropzones ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON dropzones USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );

    ALTER TABLE dropzone_items ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON dropzone_items USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );

    ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON invoices USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );

    ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON invoice_items USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );

    ALTER TABLE receiving_records ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON receiving_records USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );

    -- Journal is owner/worker only — sellers never see it.
    ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON journal_entries USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS journal_entries CASCADE;
    DROP TABLE IF EXISTS receiving_records CASCADE;
    DROP TABLE IF EXISTS invoice_items CASCADE;
    DROP TABLE IF EXISTS invoices CASCADE;
    DROP TABLE IF EXISTS dropzone_items CASCADE;
    DROP TABLE IF EXISTS dropzones CASCADE;
    DROP TABLE IF EXISTS cell_stock CASCADE;
    DROP TABLE IF EXISTS cell_blocks CASCADE;
    DROP TABLE IF EXISTS warehouse_rows CASCADE;
    DROP TABLE IF EXISTS seller_keys CASCADE;
    DROP TABLE IF EXISTS companies CASCADE;
    DROP TABLE IF EXISTS staff_keys CASCADE;
    DROP TABLE IF EXISTS warehouses CASCADE;
    DROP TABLE IF EXISTS owners CASCADE;
    DROP TYPE IF EXISTS journal_status;
    DROP TYPE IF EXISTS invoice_status;
    DROP TYPE IF EXISTS dropzone_direction;
    DROP TYPE IF EXISTS cell_state;
  `);
};
