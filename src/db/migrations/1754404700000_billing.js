/* eslint-disable camelcase */
// Расчёты с продавцами, первая версия (владелец 04.10.2026: «давай пока с
// примерными цифрами»). Две вещи, которых не было:
//   billing_tariffs      — прайс склада: ставка за каждую услугу и за что
//                          берём хранение (ячейка или штука в сутки);
//   billing_storage_days — занятость продавца за каждые сутки: cell_stock
//                          знает только «сейчас», а хранение платят по дням.
// Приёмка, сборка и возвраты считаются из уже записанных операций.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE billing_tariffs (
      warehouse_id UUID PRIMARY KEY REFERENCES warehouses(id) ON DELETE CASCADE,
      prices JSONB NOT NULL,
      storage_unit TEXT NOT NULL DEFAULT 'cell_day' CHECK (storage_unit IN ('cell_day', 'unit_day')),
      show_sellers BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by TEXT
    );
    ALTER TABLE billing_tariffs ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON billing_tariffs USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );

    CREATE TABLE billing_storage_days (
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      cells INT NOT NULL CHECK (cells >= 0),
      units BIGINT NOT NULL CHECK (units >= 0),
      PRIMARY KEY (warehouse_id, company_id, day)
    );
    ALTER TABLE billing_storage_days ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON billing_storage_days USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );

    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='argus_app') THEN
      GRANT SELECT, INSERT, UPDATE ON billing_tariffs TO argus_app;
      GRANT SELECT, INSERT, UPDATE ON billing_storage_days TO argus_app;
    END IF; END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS billing_storage_days; DROP TABLE IF EXISTS billing_tariffs;');
};
