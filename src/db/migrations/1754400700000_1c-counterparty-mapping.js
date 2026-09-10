/* eslint-disable camelcase */

exports.shorthands = undefined;

// Контрагенты из 1С — это справочник для настройки интеграции, а не готовые
// продавцы Argus. В старой схеме каждый контрагент автоматически становился
// компанией, хотя в УТ среди них есть поставщики, перевозчики и архивные
// организации. Теперь 1С только сообщает доступные варианты, а владелец
// склада один раз связывает нужный вариант с уже созданной компанией.
//
// products.company_id становится nullable: позиция из 1С может приехать до
// того, как её контрагент связан с продавцом. Такая позиция видна владельцу
// склада, но RLS не покажет её ни одному продавцу. После сопоставления
// очередной документ 1С назначит владельца автоматически.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE integration_counterparties (
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      name TEXT NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (warehouse_id, external_id)
    );

    CREATE INDEX idx_integration_counterparties_search
      ON integration_counterparties(warehouse_id, lower(name));

    ALTER TABLE integration_counterparties ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON integration_counterparties USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );

    ALTER TABLE products ALTER COLUMN company_id DROP NOT NULL;

    ALTER TABLE invoice_items ADD COLUMN product_external_id TEXT;
    CREATE INDEX idx_invoice_items_product_external
      ON invoice_items(warehouse_id, product_external_id)
      WHERE product_external_id IS NOT NULL;

    ALTER TABLE product_cells_1c
      ADD COLUMN product_id UUID REFERENCES products(id) ON DELETE CASCADE;

    UPDATE product_cells_1c pc
       SET product_id = p.id
      FROM products p
     WHERE p.warehouse_id = pc.warehouse_id
       AND p.sku = pc.sku
       AND (pc.company_id IS NULL OR p.company_id = pc.company_id)
       AND NOT EXISTS (
         SELECT 1 FROM products other
          WHERE other.warehouse_id = p.warehouse_id
            AND other.sku = p.sku
            AND other.id <> p.id
       );

    ALTER TABLE product_cells_1c
      DROP CONSTRAINT IF EXISTS product_cells_1c_warehouse_id_sku_cell_name_key;

    CREATE UNIQUE INDEX idx_product_cells_1c_product_cell
      ON product_cells_1c(warehouse_id, product_id, cell_name)
      WHERE product_id IS NOT NULL;

    CREATE INDEX idx_product_cells_1c_product
      ON product_cells_1c(product_id)
      WHERE product_id IS NOT NULL;
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON integration_counterparties TO argus_app;
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_product_cells_1c_product;
    DROP INDEX IF EXISTS idx_product_cells_1c_product_cell;
    DROP INDEX IF EXISTS idx_invoice_items_product_external;
    ALTER TABLE invoice_items DROP COLUMN IF EXISTS product_external_id;
    ALTER TABLE product_cells_1c DROP COLUMN IF EXISTS product_id;
    ALTER TABLE product_cells_1c
      ADD CONSTRAINT product_cells_1c_warehouse_id_sku_cell_name_key
      UNIQUE (warehouse_id, sku, cell_name);
    DROP TABLE IF EXISTS integration_counterparties;
  `);
};
