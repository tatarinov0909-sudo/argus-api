/* eslint-disable camelcase */

exports.shorthands = undefined;

// Состав набора: из каких товаров он собирается.
//
// Половина живой очереди заказов на Wildberries — наборы («сплиты»): площадка
// присылает один артикул, а на полке лежат два-четыре разных товара, которые
// работник должен взять и упаковать вместе. Без состава такой заказ физически
// нечем собрать: Аргус ищет артикул набора в ячейках, не находит и честно
// говорит «нет на складе», хотя всё нужное лежит в трёх метрах.
//
// Хранится в НАШИХ артикулах (КОД ФФ, вида PB000021144), а не в кодах
// площадки: склад живёт в кодах 1С, и перевод из артикулов маркетплейса —
// задача импорта, а не этой таблицы.
//
// Одна строка — один компонент. Компонент может входить в набор несколько раз
// (в матрице «печенье х 2 шт» встречается сплошь), поэтому количество —
// отдельное поле, а не повторяющиеся строки: иначе UNIQUE ниже пришлось бы
// снять, и дубли из импорта тихо удваивали бы состав при каждом повторе.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE product_kits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      kit_sku TEXT NOT NULL,
      component_sku TEXT NOT NULL,
      qty NUMERIC NOT NULL CHECK (qty > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Набор из самого себя — не опечатка, а бесконечная рекурсия при сборке.
      CONSTRAINT kit_is_not_its_own_component CHECK (kit_sku <> component_sku),
      UNIQUE (warehouse_id, company_id, kit_sku, component_sku)
    );

    -- «Из чего этот набор» — основной запрос, на каждой сборке.
    CREATE INDEX idx_product_kits_kit
      ON product_kits(warehouse_id, company_id, kit_sku);

    -- Обратный: «в какие наборы входит этот товар». Нужен, чтобы понять, что
    -- кончившийся компонент обрушил сразу несколько позиций в продаже.
    CREATE INDEX idx_product_kits_component
      ON product_kits(warehouse_id, company_id, component_sku);

    -- Та же форма политики, что у остального товарного: склад видит всё своё,
    -- продавец — только своё. Состав набора продавцу видеть можно: это его
    -- собственный товар, и он же его и придумал.
    ALTER TABLE product_kits ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON product_kits USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );
  `);

  // setup-app-role.sql выдаёт права снимком на момент запуска и новые таблицы
  // не покрывает — без этого первая же сборка падает на "permission denied".
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON product_kits TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS product_kits;');
};
