/* eslint-disable camelcase */

exports.shorthands = undefined;

// Инвентаризация — пересчёт ячейки.
//
// Всё, что Кладовщик говорит владельцу, стоит на цифрах, которые ни разу не
// сверяли с полкой. Пересчёт — единственный способ узнать, что база и склад
// всё ещё говорят об одном и том же.
//
// Три вещи, ради которых схема выглядит именно так:
//
// 1. ПЕРЕСЧЁТ РЕДКИЙ И НАЗНАЧАЕМЫЙ. Работник не открывает инвентаризацию сам:
//    считать он идёт только по заданию. Иначе счёт съедает смену, которая
//    должна собирать заказы, и превращается в кнопку, которую прокликивают.
//
// 2. РАСХОЖДЕНИЕ НЕ ПРИМЕНЯЕТСЯ САМО. Приёмка добавляет товар, которого не
//    было; пересчёт может СПИСАТЬ чужой товар со склада по слову одного
//    человека. Риск несимметричный, поэтому остаток меняется только после
//    решения владельца, а до тех пор задание ждёт.
//
// 3. СНИМОК НА МОМЕНТ ОТКРЫТИЯ. Задание запоминает, что лежало в ячейке, когда
//    работник её открыл. Если между открытием и отправкой в ячейке шла работа,
//    пересчёт отклоняется: исправлять остаток по устаревшей картинке — значит
//    вносить ошибку, а не убирать её.
exports.up = (pgm) => {
  pgm.sql(`
    -- Регулировка. Одна строка на склад, значения по умолчанию осторожные:
    -- лучше считать реже, чем приучить нажимать «готово» не глядя.
    CREATE TABLE inventory_settings (
      warehouse_id UUID PRIMARY KEY REFERENCES warehouses(id) ON DELETE CASCADE,
      -- Ячейку, посчитанную свежее этого срока, правило не предложит.
      recount_after_days INT NOT NULL DEFAULT 90 CHECK (recount_after_days BETWEEN 1 AND 3650),
      -- Сколько ячеек уходит в один заход.
      cells_per_run INT NOT NULL DEFAULT 10 CHECK (cells_per_run BETWEEN 1 AND 200),
      -- Пауза между заходами: чтобы пересчёт не стал ежедневным ритуалом.
      min_days_between_runs INT NOT NULL DEFAULT 7 CHECK (min_days_between_runs BETWEEN 0 AND 365),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Один заход: владелец нажал «назначить пересчёт», правило выбрало ячейки.
    CREATE TABLE inventory_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      created_by_owner_id UUID REFERENCES owners(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_inv_runs_warehouse ON inventory_runs(warehouse_id, created_at DESC);

    CREATE TYPE inventory_task_status AS ENUM (
      'pending',       -- назначено, работник ещё не считал
      'matched',       -- посчитали, сошлось — больше ничего не нужно
      'waiting_owner', -- посчитали, не сошлось — ждёт решения владельца
      'applied',       -- владелец принял пересчёт, остаток исправлен
      'rejected'       -- владелец отклонил, остаток не тронут
    );

    CREATE TABLE inventory_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id UUID NOT NULL REFERENCES inventory_runs(id) ON DELETE CASCADE,
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      cell_block_id UUID NOT NULL REFERENCES cell_blocks(id) ON DELETE CASCADE,
      status inventory_task_status NOT NULL DEFAULT 'pending',
      -- Почему эту ячейку выбрали. Работнику это ничего не даёт, а владельцу
      -- объясняет, почему считают именно её, — иначе выбор выглядит случайным.
      reason TEXT NOT NULL,
      -- Что лежало в ячейке, когда работник её открыл, и что он насчитал.
      -- JSONB, а не строки: в ячейке бывает несколько артикулов и состояний,
      -- и таблица строк ради снимка, который никто не джойнит, лишняя.
      expected JSONB,
      counted JSONB,
      -- Работник нашёл в ячейке то, чего в списке нет. Записать это артикулом
      -- он пока не может — сканера нет, а набирать код руками у полки значит
      -- получить опечатку вместо факта. Поэтому отметка словами: она делает
      -- ячейку расхождением и зовёт владельца, а не притворяется цифрой.
      note TEXT,
      opened_at TIMESTAMPTZ,
      counted_at TIMESTAMPTZ,
      worker_key_id UUID REFERENCES staff_keys(id) ON DELETE SET NULL,
      resolved_at TIMESTAMPTZ,
      resolved_by_owner_id UUID REFERENCES owners(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Одна ячейка не может стоять в заходе дважды.
      UNIQUE (run_id, cell_block_id)
    );

    CREATE INDEX idx_inv_tasks_open
      ON inventory_tasks(warehouse_id, status) WHERE status IN ('pending', 'waiting_owner');
    -- «Когда эту ячейку считали в последний раз» — основа правила отбора.
    CREATE INDEX idx_inv_tasks_cell ON inventory_tasks(warehouse_id, cell_block_id, counted_at DESC);

    ALTER TABLE inventory_settings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE inventory_runs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE inventory_tasks ENABLE ROW LEVEL SECURITY;
    -- Продавца сюда не пускаем: пересчёт — внутренняя работа склада, и
    -- показывать клиенту сырое расхождение до решения владельца незачем.
    CREATE POLICY tenant_isolation ON inventory_settings USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );
    CREATE POLICY tenant_isolation ON inventory_runs USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );
    CREATE POLICY tenant_isolation ON inventory_tasks USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_settings TO argus_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_runs TO argus_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_tasks TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS inventory_tasks;
    DROP TABLE IF EXISTS inventory_runs;
    DROP TABLE IF EXISTS inventory_settings;
    DROP TYPE IF EXISTS inventory_task_status;
  `);
};
