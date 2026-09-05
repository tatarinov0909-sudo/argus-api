/* eslint-disable camelcase */

exports.shorthands = undefined;

// След от операций, которые двигают остаток без документа.
//
// У приёмки, отгрузки и возврата есть своя запись с работником и временем —
// потому что у каждой из них есть накладная, к которой она привязана. А сборка
// набора и перепаковка накладной не имеют: работник просто взял с полки и
// переложил. До сих пор они не оставляли следа вообще: остаток менялся, а кто
// и когда — неизвестно.
//
// Это дыра ровно в том обещании, ради которого журнал и заводился: за каждой
// цифрой должно стоять действие с временем, работником и ячейкой. Спор с
// продавцом о недостаче упирается именно в это.
//
// Отдельной таблицей, а не в journal_entries: журнал — про расхождения,
// которые ждут решения владельца, и добавлять туда рутину значит утопить в ней
// то, что требует внимания.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE stock_operations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
      -- 'kit_assemble' — собрали набор, 'move' — переставили, 'repack' —
      -- перепаковали. Текстом, а не перечислением: добавить вид операции
      -- не должно требовать миграции с ALTER TYPE.
      kind TEXT NOT NULL,
      sku TEXT NOT NULL,
      qty NUMERIC NOT NULL CHECK (qty > 0),
      from_cell_block_id UUID REFERENCES cell_blocks(id) ON DELETE SET NULL,
      to_cell_block_id UUID REFERENCES cell_blocks(id) ON DELETE SET NULL,
      -- Подробности, у которых нет своей колонки: состав набора при сборке,
      -- состояния «до» и «после» при перепаковке.
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      worker_key_id UUID REFERENCES staff_keys(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_stock_ops_warehouse ON stock_operations(warehouse_id, created_at DESC);
    CREATE INDEX idx_stock_ops_sku ON stock_operations(warehouse_id, sku);

    ALTER TABLE stock_operations ENABLE ROW LEVEL SECURITY;
    -- Та же форма, что у остального товарного: склад видит своё, продавец —
    -- операции со своим товаром. Продавцу это и нужно: спор о недостаче
    -- разрешается тем, что он сам видит, кто и когда её трогал.
    CREATE POLICY tenant_isolation ON stock_operations USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );
  `);

  // Как и у всех таблиц, созданных после setup-app-role.sql.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT SELECT, INSERT ON stock_operations TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS stock_operations;');
};
