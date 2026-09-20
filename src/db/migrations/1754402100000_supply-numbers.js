/* eslint-disable camelcase */

exports.shorthands = undefined;

// Выданные номера поставок. Нужны отдельно от самих поставок, потому что
// разобранная поставка удаляется, а её номер уже назван вслух и напечатан на
// листе комплектации: выдать его второй поставке — значит сделать две разные
// бумаги с одним номером. Плюс счётчик по количеству поставок за день после
// разбора возвращался на занятое число, и новые поставки переставали
// создаваться до конца суток.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE supply_numbers (
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      number TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (warehouse_id, number)
    );

    -- Уже выданные номера переносим, иначе первая же поставка после выкладки
    -- получит номер, который сегодня уже был.
    INSERT INTO supply_numbers (warehouse_id, number, created_at)
      SELECT warehouse_id, number, created_at FROM supplies
      ON CONFLICT DO NOTHING;

    ALTER TABLE supply_numbers ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON supply_numbers USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );

    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='argus_app') THEN
      GRANT SELECT, INSERT ON supply_numbers TO argus_app;
    END IF; END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS supply_numbers;');
};
