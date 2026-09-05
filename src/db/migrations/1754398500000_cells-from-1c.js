/* eslint-disable camelcase */

exports.shorthands = undefined;

// Адреса хранения из 1С.
//
// В базе клиента нашёлся регистр «ЯчейкиТоваров»: номенклатура → складская
// ячейка, 1 049 записей при 1 353 позициях с остатком. То есть владелец давно
// ведёт адресное хранение, просто у себя, и Аргус об этом не знал.
//
// Кладём РЯДОМ с нашими ячейками, а не вместо: у нас своя карта склада, где
// ячейка — это объект с координатами, в который работник физически положил
// товар при приёмке. Адрес из 1С — чужое утверждение о том же товаре, и
// ценность как раз в сравнении. Совпало — хорошо; разошлось — кто-то
// переставил и не сказал, и это первый сигнал, а не повод затирать.
//
// Одна позиция может лежать в нескольких ячейках, поэтому строка на пару
// (товар, ячейка), а не поле в products.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE product_cells_1c (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
      sku TEXT NOT NULL,
      cell_name TEXT NOT NULL,
      qty NUMERIC,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (warehouse_id, sku, cell_name)
    );

    CREATE INDEX idx_product_cells_1c_lookup
      ON product_cells_1c(warehouse_id, sku);

    ALTER TABLE product_cells_1c ENABLE ROW LEVEL SECURITY;

    CREATE POLICY tenant_isolation ON product_cells_1c
      USING (
        warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
        OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
      );
  `);

  // Гранты — снимок разовый, каждая новая таблица выдаёт свои сама, иначе
  // роль приложения молча не видит таблицу и запрос вернёт ноль строк.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON product_cells_1c TO argus_app;
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS product_cells_1c;');
};
