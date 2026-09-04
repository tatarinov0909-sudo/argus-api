/* eslint-disable camelcase */

exports.shorthands = undefined;

// Одна коробка на полке — три разных артикула. У склада товар лежит под своим
// кодом (PB100005), а на каждой площадке он числится под её собственным. Заказ
// приходит с артикулом площадки, а идти надо к полке склада — без этой связки
// заказы видны, но собрать их нельзя.
//
// Связь один-ко-многим, поэтому колонкой это не решается: отдельная таблица.
//
// Ключ — SKU, а не products.id, и это отступление от исходной формулировки
// плана. Причина фактическая: справочник товаров неполон (на живой базе
// нашлось два артикула из 633, которые лежат в ячейках, но карточки не имеют),
// а весь склад — остатки, позиции накладных, подбор ячейки — работает по SKU.
// Ключ на products.id сделал бы сопоставление неприменимым ровно для тех
// товаров, из-за которых обычно и разбираются.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE product_marketplace_skus (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      -- Наш артикул: тот же, что в cell_stock и invoice_items.
      sku TEXT NOT NULL,
      marketplace TEXT NOT NULL,
      mp_sku TEXT NOT NULL,
      mp_barcode TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Артикул площадки ведёт ровно к одному нашему товару: иначе заказ
    -- невозможно собрать однозначно.
    CREATE UNIQUE INDEX idx_mp_sku_unique
      ON product_marketplace_skus(warehouse_id, marketplace, mp_sku);
    -- Обратный вопрос — «под какими артикулами этот товар продаётся» — задаётся
    -- при выгрузке остатков на площадки.
    CREATE INDEX idx_mp_sku_by_ours
      ON product_marketplace_skus(warehouse_id, company_id, sku);

    ALTER TABLE product_marketplace_skus ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON product_marketplace_skus USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );
  `);

  // setup-app-role.sql — одноразовый снимок прав и новые таблицы не покрывает.
  // Забытый GRANT здесь выглядит как «permission denied» при первом обращении;
  // в этом проекте на нём уже спотыкались дважды.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON product_marketplace_skus TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS product_marketplace_skus CASCADE;`);
};
