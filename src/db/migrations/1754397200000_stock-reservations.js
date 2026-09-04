/* eslint-disable camelcase */

exports.shorthands = undefined;

// Один товар — три витрины. Заказ пришёл с одной площадки, а остаток должен
// упасть на всех сразу, иначе та же коробка продастся дважды и отмену оплатит
// продавец.
//
// Отсюда разница, которой в системе до сих пор не было: «лежит в ячейке» и
// «можно продать» — разные числа. Доступное к продаже = остаток по cell_stock
// − активные резервы − то, что не годно (состояние товара уже учитывается,
// см. миграцию stock-quality).
//
// Резерв живёт от прихода заказа до отгрузки или отмены. Снимается простановкой
// released_at, а не удалением строки: почему товар был недоступен вчера — это
// вопрос, который обязательно зададут.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE stock_reservations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      sku TEXT NOT NULL,
      qty NUMERIC NOT NULL CHECK (qty > 0),
      -- Под какую строку заказа зарезервировано. Позиция удалится — резерв
      -- уйдёт с ней: держать резерв под несуществующий заказ незачем.
      invoice_item_id UUID REFERENCES invoice_items(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      released_at TIMESTAMPTZ
    );

    -- Главный запрос: «сколько этого товара сейчас зарезервировано». Считается
    -- на каждой выгрузке остатков, то есть часто.
    CREATE INDEX idx_reservations_active
      ON stock_reservations(warehouse_id, company_id, sku) WHERE released_at IS NULL;
    CREATE INDEX idx_reservations_item ON stock_reservations(invoice_item_id);

    ALTER TABLE stock_reservations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON stock_reservations USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON stock_reservations TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS stock_reservations CASCADE;`);
};
