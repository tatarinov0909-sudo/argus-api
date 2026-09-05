/* eslint-disable camelcase */

exports.shorthands = undefined;

// Справочник ячеек владельца — то, из чего строится карта склада.
//
// В базе клиента 5 453 ячейки с именами вида «01-02-015»: ряд — ярус —
// ячейка (подтверждено владельцем, гадать было нельзя: перепутав ярус
// с местом, работник получил бы на экране одни координаты, а на стеллаже
// другие). Разбираем имя на три числа при записи, а не при чтении: разбор
// один раз на строку вместо разбора на каждый показ карты.
//
// Имя храним целиком и рядом. Оно — то, что написано на табличке стеллажа,
// и именно его работник сверяет глазами; собирать его обратно из трёх чисел
// значило бы однажды потерять ведущие нули и показать «1-2-15».
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE warehouse_cells_1c (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      cell_name TEXT NOT NULL,
      row_num INTEGER,
      tier INTEGER,
      pos INTEGER,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (warehouse_id, cell_name)
    );

    CREATE INDEX idx_warehouse_cells_1c_coords
      ON warehouse_cells_1c(warehouse_id, row_num, tier, pos);

    ALTER TABLE warehouse_cells_1c ENABLE ROW LEVEL SECURITY;

    CREATE POLICY tenant_isolation ON warehouse_cells_1c
      USING (warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid);
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON warehouse_cells_1c TO argus_app;
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS warehouse_cells_1c;');
};
