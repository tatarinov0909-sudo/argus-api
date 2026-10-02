/* eslint-disable camelcase */
// «Хранить отдельно» у склада продавца (владелец 02.10.2026, этап 3):
// товар такого склада не лежит в одной ячейке с товаром других складов
// продавца; по желанию — закреплённая зона (свои ячейки), брак — отдельно
// второй галочкой. Перенос на такой склад и разделение уже смешанного —
// задания грузчику «переложить»: каждая переложенная штука сразу
// переходит куда нужно.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE virtual_warehouses ADD COLUMN defect_separate BOOLEAN NOT NULL DEFAULT false;

    -- Зона склада продавца: ячейка закреплена за ним, ничего другого туда
    -- не кладут.
    ALTER TABLE cell_blocks ADD COLUMN reserved_vw_id UUID REFERENCES virtual_warehouses(id) ON DELETE SET NULL;
    CREATE INDEX cell_blocks_reserved_vw ON cell_blocks (reserved_vw_id) WHERE reserved_vw_id IS NOT NULL;

    -- Задание грузчику «переложить»: separate — разделить смешанную ячейку
    -- (товар склада остаётся своим), transfer — перенос на склад «хранить
    -- отдельно» или с него (переложенное переходит на to_vw).
    CREATE TABLE vw_move_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('separate', 'transfer')),
      transfer_id UUID REFERENCES vw_transfers(id) ON DELETE CASCADE,
      sku TEXT NOT NULL,
      name TEXT,
      quality TEXT NOT NULL DEFAULT 'good',
      from_cell_block_id UUID NOT NULL REFERENCES cell_blocks(id),
      from_vw UUID REFERENCES virtual_warehouses(id),
      to_vw UUID REFERENCES virtual_warehouses(id),
      qty INT NOT NULL CHECK (qty > 0),
      moved INT NOT NULL DEFAULT 0 CHECK (moved >= 0),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'canceled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      done_at TIMESTAMPTZ,
      worker_key_id UUID REFERENCES staff_keys(id) ON DELETE SET NULL,
      cancel_note TEXT
    );
    CREATE INDEX vw_move_tasks_open ON vw_move_tasks (warehouse_id, created_at) WHERE status = 'open';

    ALTER TABLE vw_move_tasks ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON vw_move_tasks USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
      OR company_id = NULLIF(current_setting('app.current_company_id', true), '')::uuid
    );
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='argus_app') THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON vw_move_tasks TO argus_app;
    END IF; END $$;

    -- Кладовщик напоминает о складах продавцов (переносы, решения, зоны,
    -- задания «переложить»); руководитель может выключить.
    ALTER TABLE warehouses ADD COLUMN vw_reminders BOOLEAN NOT NULL DEFAULT true;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE warehouses DROP COLUMN IF EXISTS vw_reminders;
    DROP TABLE IF EXISTS vw_move_tasks;
    DROP INDEX IF EXISTS cell_blocks_reserved_vw;
    ALTER TABLE cell_blocks DROP COLUMN IF EXISTS reserved_vw_id;
    ALTER TABLE virtual_warehouses DROP COLUMN IF EXISTS defect_separate;
  `);
};
