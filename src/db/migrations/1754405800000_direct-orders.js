/* eslint-disable camelcase */

exports.shorthands = undefined;

// Заказы физлицам по полной схеме (схема 06.10.2026, владелец 08.10:
// «заказы физлицам по полной схеме»).
//
// Заказ физлицу — обычный заказ на отгрузку (invoices, source 'direct'): его
// заводит склад или продавец, он стоит в «Заказах», склад составляет из
// таких заказов поставку, грузчик видит его только в поставке. Здесь — то,
// чего у заказа площадки нет: кому и куда, телефон, служба доставки,
// трек-номер и статусы после отъезда (в пути, доставлен, отказ). Данные
// получателя — персональные: видят склад и этот продавец (политика ниже).
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE direct_orders (
      invoice_id UUID PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      -- Склад продавца, с которого собирать; NULL — весь товар продавца.
      virtual_warehouse_id UUID REFERENCES virtual_warehouses(id),
      recipient TEXT NOT NULL,
      address TEXT NOT NULL,
      phone TEXT,
      delivery_service TEXT,
      planned_date DATE,
      comment TEXT,
      track_number TEXT,
      delivery_status TEXT CHECK (delivery_status IN ('in_transit', 'delivered', 'refused')),
      delivery_status_at TIMESTAMPTZ,
      delivery_status_by TEXT,
      created_role TEXT NOT NULL CHECK (created_role IN ('owner', 'manager', 'seller')),
      created_by_name TEXT,
      request_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX direct_orders_request ON direct_orders (company_id, request_id) WHERE request_id IS NOT NULL;
    CREATE INDEX direct_orders_by_warehouse ON direct_orders (warehouse_id, created_at DESC);
    CREATE INDEX direct_orders_by_company ON direct_orders (company_id, created_at DESC);

    ALTER TABLE direct_orders ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON direct_orders USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='argus_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON direct_orders TO argus_app;
    END IF; END $$;

    -- Настройка фулфилмента: продавцы сами заводят заказы физлицам.
    ALTER TABLE warehouses ADD COLUMN sellers_direct_orders BOOLEAN NOT NULL DEFAULT true;

    -- Поставки физлицу «одним шагом» (07.10): их заказ — тоже заказ физлицу.
    INSERT INTO direct_orders (invoice_id, warehouse_id, company_id, recipient, address, planned_date, created_role)
    SELECT i.id, i.warehouse_id, i.company_id, COALESCE(s.destination, '—'), COALESCE(s.destination, '—'), s.ship_date, 'owner'
      FROM invoices i LEFT JOIN supplies s ON s.id = i.supply_id
     WHERE i.source_document_type = 'direct_supply'
    ON CONFLICT DO NOTHING;
    UPDATE invoices SET source = 'direct' WHERE source_document_type = 'direct_supply';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE invoices SET source = '1c' WHERE source = 'direct';
    ALTER TABLE warehouses DROP COLUMN IF EXISTS sellers_direct_orders;
    DROP TABLE IF EXISTS direct_orders;
  `);
};
