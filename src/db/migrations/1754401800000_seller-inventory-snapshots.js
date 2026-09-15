/* eslint-disable camelcase */

exports.shorthands = undefined;

// Seller-visible inventory is an accepted, versioned business snapshot.
// Raw 1C balances remain diagnostic input and cannot silently replace it.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE seller_inventory_snapshots (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('file', '1c', 'manual', 'argus')),
      source_label TEXT NOT NULL,
      observed_at TIMESTAMPTZ,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      accepted_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'superseded', 'rejected')),
      item_count INTEGER NOT NULL CHECK (item_count > 0),
      total_qty NUMERIC NOT NULL CHECK (total_qty >= 0 AND total_qty = trunc(total_qty)),
      content_hash TEXT NOT NULL,
      note TEXT,
      UNIQUE (id, warehouse_id, company_id)
    );

    CREATE TABLE seller_inventory_snapshot_items (
      snapshot_id UUID NOT NULL,
      warehouse_id UUID NOT NULL,
      company_id UUID NOT NULL,
      sku TEXT NOT NULL,
      quantity NUMERIC NOT NULL CHECK (quantity >= 0 AND quantity = trunc(quantity)),
      PRIMARY KEY (snapshot_id, sku),
      FOREIGN KEY (snapshot_id, warehouse_id, company_id)
        REFERENCES seller_inventory_snapshots(id, warehouse_id, company_id)
        ON DELETE CASCADE,
      FOREIGN KEY (warehouse_id, company_id, sku)
        REFERENCES products(warehouse_id, company_id, sku)
        ON UPDATE CASCADE ON DELETE RESTRICT
    );

    CREATE UNIQUE INDEX seller_inventory_one_accepted
      ON seller_inventory_snapshots(company_id) WHERE status = 'accepted';
    CREATE INDEX seller_inventory_snapshots_company
      ON seller_inventory_snapshots(company_id, accepted_at DESC);
    CREATE INDEX seller_inventory_snapshot_items_company
      ON seller_inventory_snapshot_items(company_id, sku);

    ALTER TABLE seller_inventory_snapshots ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON seller_inventory_snapshots USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );
    ALTER TABLE seller_inventory_snapshot_items ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON seller_inventory_snapshot_items USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );

    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='argus_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON seller_inventory_snapshots TO argus_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON seller_inventory_snapshot_items TO argus_app;
    END IF; END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS seller_inventory_snapshot_items;
    DROP TABLE IF EXISTS seller_inventory_snapshots;
  `);
};

