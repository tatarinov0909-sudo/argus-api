/* eslint-disable camelcase */

exports.shorthands = undefined;

// Склады продавца на WB (владелец 30.09.2026).
//
// У фулфилмента своих складов на WB нет: каждый продавец заводит у себя
// «склад продавца» и привязывает его к пункту приёмки WB, куда фулфилмент
// возит поставки. Продавец работает с несколькими фулфилментами — у Авезова
// 16 складов, наших 6, — а WB отдаёт по ключу заказы всех складов сразу.
// Аргус брал их все: 559 заказов «в работе» вместо ~350.
//
// Теперь:
//   ff_wb_offices         — пункты приёмки WB, куда возит этот фулфилмент;
//   seller_wb_warehouses  — склады продавца на WB и отметка «наш»;
//   invoices.mp_warehouse_id — с какого склада WB заказ;
//   wb_foreign_orders     — заказы чужих складов. Не удаляются, а лежат
//                           здесь: поставили галочку «наш» — вернутся;
//   wb_stock_levels       — сколько продавец выставил на WB по нашим складам
//                           (только чтение WB).
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE ff_wb_offices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      office_id BIGINT NOT NULL,
      name TEXT,
      city TEXT,
      address TEXT,
      added_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (warehouse_id, office_id)
    );
    ALTER TABLE ff_wb_offices ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON ff_wb_offices USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );

    CREATE TABLE seller_wb_warehouses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      mp_warehouse_id TEXT NOT NULL,
      name TEXT NOT NULL,
      office_id BIGINT,
      office_name TEXT,
      office_city TEXT,
      office_address TEXT,
      cargo_type INT,
      delivery_type INT,
      ours BOOLEAN NOT NULL DEFAULT false,
      -- Кто решил. NULL — Аргус по правилу (наш пункт приёмки + наше имя в
      -- названии); решение человека правило больше не трогает.
      decided_by TEXT,
      decided_at TIMESTAMPTZ,
      -- Последний раз был в списке WB; пропал — gone_at.
      seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      gone_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (company_id, mp_warehouse_id)
    );
    CREATE INDEX seller_wb_warehouses_by_wh ON seller_wb_warehouses (warehouse_id, company_id);
    ALTER TABLE seller_wb_warehouses ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON seller_wb_warehouses USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );

    ALTER TABLE invoices ADD COLUMN mp_warehouse_id TEXT;
    CREATE INDEX invoices_by_mp_warehouse ON invoices (company_id, mp_warehouse_id) WHERE source = 'wb';
    -- Размер карточки WB: по нему WB отдаёт остаток склада.
    ALTER TABLE invoice_items ADD COLUMN mp_chrt_id TEXT;

    CREATE TABLE wb_foreign_orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      mp_warehouse_id TEXT NOT NULL,
      mp_created_at TIMESTAMPTZ,
      -- Заказ в том виде, в каком его заводит обмен (wb.normalizeOrder), —
      -- чтобы вернуть его той же дорогой, что и новый.
      wb_order JSONB NOT NULL,
      hidden_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (warehouse_id, external_id)
    );
    CREATE INDEX wb_foreign_orders_by_wh ON wb_foreign_orders (company_id, mp_warehouse_id);
    ALTER TABLE wb_foreign_orders ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON wb_foreign_orders USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );

    CREATE TABLE wb_stock_levels (
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      mp_warehouse_id TEXT NOT NULL,
      chrt_id TEXT NOT NULL,
      amount INT NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (company_id, mp_warehouse_id, chrt_id)
    );
    ALTER TABLE wb_stock_levels ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON wb_stock_levels USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );

    -- Состояние чтения WB по продавцу: когда читали склады и остатки, что
    -- ответил WB, докуда дочитана история заказов (чтобы узнать склад у
    -- заказов, заведённых раньше).
    ALTER TABLE marketplace_credentials
      ADD COLUMN wb_warehouses_at TIMESTAMPTZ,
      ADD COLUMN wb_warehouses_error TEXT,
      ADD COLUMN wb_history_until TIMESTAMPTZ,
      ADD COLUMN wb_stocks_at TIMESTAMPTZ,
      ADD COLUMN wb_stocks_error TEXT;
  `);
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON ff_wb_offices, seller_wb_warehouses,
          wb_foreign_orders, wb_stock_levels TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  // Скрытые заказы живут только в wb_foreign_orders: откат их бы потерял.
  // Сначала снять отметки складов (заказы вернутся обменом), потом откат.
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM wb_foreign_orders) THEN
        RAISE EXCEPTION 'в wb_foreign_orders есть скрытые заказы: откат их потеряет';
      END IF;
    END $$;
  `);
  pgm.sql(`
    ALTER TABLE marketplace_credentials
      DROP COLUMN IF EXISTS wb_warehouses_at, DROP COLUMN IF EXISTS wb_warehouses_error,
      DROP COLUMN IF EXISTS wb_history_until, DROP COLUMN IF EXISTS wb_stocks_at,
      DROP COLUMN IF EXISTS wb_stocks_error;
    DROP TABLE IF EXISTS wb_stock_levels;
    DROP TABLE IF EXISTS wb_foreign_orders;
    ALTER TABLE invoice_items DROP COLUMN IF EXISTS mp_chrt_id;
    DROP INDEX IF EXISTS invoices_by_mp_warehouse;
    ALTER TABLE invoices DROP COLUMN IF EXISTS mp_warehouse_id;
    DROP TABLE IF EXISTS seller_wb_warehouses;
    DROP TABLE IF EXISTS ff_wb_offices;
  `);
};
