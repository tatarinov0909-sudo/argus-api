/* eslint-disable camelcase */

exports.shorthands = undefined;

// Поставка — пачка заказов, которая уезжает одной машиной.
//
// До неё цепочка рвалась в трёх местах сразу: заказы падали по одному и
// собрать их было нечем; документы (лист комплектации, упаковочный лист,
// QR) печатать не от чего; отгрузка заканчивалась статусом «shipped» без
// ответа на вопрос «куда и когда уехало». Всё это — свойства поставки,
// а не отдельные задачи.
//
// Заказ входит не более чем в одну поставку: физически коробка уезжает
// одной машиной. Поэтому связь — поле в накладной, а не отдельная таблица
// связей: вторая поставка на тот же заказ означала бы, что мы обещали одну
// коробку двум машинам, и такое лучше запретить в схеме.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TYPE supply_status AS ENUM ('collecting', 'ready', 'shipped');

    CREATE TABLE supplies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      -- Наш номер, человекочитаемый: его называют в разговоре и пишут на
      -- документах. Номер площадки приезжает отдельно и позже.
      number TEXT NOT NULL,
      marketplace TEXT,
      -- Номер поставки на стороне площадки (WB-GI-...). Появляется только
      -- когда мы получим право её там создавать; до тех пор пусто, и это
      -- честнее, чем выдумывать своё под видом их.
      mp_supply_id TEXT,
      status supply_status NOT NULL DEFAULT 'collecting',
      -- Куда уезжает: сортировочный центр, склад площадки, ПВЗ. Строкой,
      -- потому что у каждой площадки свои названия точек, и справочник
      -- на них завести не с чего.
      destination TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ready_at TIMESTAMPTZ,
      shipped_at TIMESTAMPTZ,
      UNIQUE (warehouse_id, number)
    );

    CREATE INDEX idx_supplies_lookup ON supplies(warehouse_id, status, created_at DESC);

    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS supply_id UUID
      REFERENCES supplies(id) ON DELETE SET NULL;
    CREATE INDEX idx_invoices_supply ON invoices(supply_id) WHERE supply_id IS NOT NULL;

    ALTER TABLE supplies ENABLE ROW LEVEL SECURITY;

    -- Продавец видит свои поставки: это его товар уезжает, и знать, когда
    -- и куда, — его законный интерес.
    CREATE POLICY tenant_isolation ON supplies
      USING (
        warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
        OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
      );
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON supplies TO argus_app;
      END IF;
    END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_invoices_supply;
    ALTER TABLE invoices DROP COLUMN IF EXISTS supply_id;
    DROP TABLE IF EXISTS supplies;
    DROP TYPE IF EXISTS supply_status;
  `);
};
