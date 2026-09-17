/* eslint-disable camelcase */

exports.shorthands = undefined;

// Передача поставки на Wildberries: что Аргус там создал и чем это можно
// напечатать. Без поставки на стороне площадки собранный товар не примут на
// воротах, поэтому эти поля — часть отгрузки, а не отчётность.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE supplies
      ADD COLUMN mp_handed_at TIMESTAMPTZ,
      ADD COLUMN mp_delivered_at TIMESTAMPTZ,
      ADD COLUMN mp_barcode TEXT,
      ADD COLUMN mp_barcode_file TEXT;

    COMMENT ON COLUMN supplies.mp_supply_id IS 'Номер поставки на площадке, созданный Аргусом';
    COMMENT ON COLUMN supplies.mp_handed_at IS 'Когда заказы подтверждены на площадке (статус «на сборке»)';
    COMMENT ON COLUMN supplies.mp_delivered_at IS 'Когда поставка передана в доставку на площадке';

    -- Заказ, который на площадку поставил сам Аргус. Отличать обязательно:
    -- «на сборке» от чужой руки означает, что заказ собирают без нас, и
    -- в поставку Аргуса он попадать не должен.
    ALTER TABLE invoices ADD COLUMN mp_confirmed_at TIMESTAMPTZ;
    COMMENT ON COLUMN invoices.mp_confirmed_at IS 'Когда Аргус подтвердил заказ на площадке';

    -- Этикетки заказов: их клеят на посылки. Площадка отдаёт их один раз на
    -- заказ, поэтому храним, а не спрашиваем заново перед каждой печатью.
    CREATE TABLE marketplace_order_stickers (
      invoice_id UUID PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      part_a TEXT,
      part_b TEXT,
      barcode TEXT,
      file TEXT,
      kind TEXT NOT NULL DEFAULT 'svg',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX marketplace_order_stickers_company ON marketplace_order_stickers(company_id);

    ALTER TABLE marketplace_order_stickers ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON marketplace_order_stickers USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );

    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='argus_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON marketplace_order_stickers TO argus_app;
    END IF; END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS marketplace_order_stickers;
    ALTER TABLE invoices DROP COLUMN IF EXISTS mp_confirmed_at;
    ALTER TABLE supplies
      DROP COLUMN IF EXISTS mp_handed_at,
      DROP COLUMN IF EXISTS mp_delivered_at,
      DROP COLUMN IF EXISTS mp_barcode,
      DROP COLUMN IF EXISTS mp_barcode_file;
  `);
};
