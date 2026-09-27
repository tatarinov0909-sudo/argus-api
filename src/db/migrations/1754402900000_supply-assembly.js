/* eslint-disable camelcase */

exports.shorthands = undefined;

// Сборка поставки как работа со своим состоянием (владелец 27.09.2026).
//
// Раньше таймер жил только в телефоне грузчика: вышел из сборки и вернулся —
// время начиналось заново, а «начал сборку» писалось от любого нажатия.
// Теперь каждый заход грузчика на поставку — строка: кто, когда начал, с
// какого момента на паузе, сколько всего простоял, чем кончилось (закончил,
// отказался) и последний комментарий «где оставил, что осталось». Что уже
// взято, хранится, как и раньше, в shipping_records.
//
// Живой заход (идёт или на паузе) у поставки один: второй грузчик не может
// начать ту же поставку молча — он её забирает, и это видно в журнале.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE supply_assemblies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      supply_id UUID NOT NULL REFERENCES supplies(id) ON DELETE CASCADE,
      worker_key_id UUID REFERENCES staff_keys(id) ON DELETE SET NULL,
      -- Имя на момент работы: ключ могут переименовать или удалить, а в
      -- истории поставки должен остаться тот, кто собирал.
      worker_name TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'app' CHECK (mode IN ('app', 'paper')),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'paused', 'abandoned', 'finished')),
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      paused_at TIMESTAMPTZ,
      paused_ms BIGINT NOT NULL DEFAULT 0 CHECK (paused_ms >= 0),
      pause_reason TEXT,
      ended_at TIMESTAMPTZ,
      comment TEXT CHECK (comment IS NULL OR length(comment) <= 500),
      comment_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((status = 'paused') = (paused_at IS NOT NULL)),
      CHECK ((status IN ('abandoned', 'finished')) = (ended_at IS NOT NULL))
    );
    CREATE UNIQUE INDEX supply_assemblies_live ON supply_assemblies (supply_id)
      WHERE status IN ('active', 'paused');
    CREATE INDEX supply_assemblies_by_supply ON supply_assemblies (supply_id, started_at DESC);

    -- Только склад: продавцу имена грузчиков и их заметки не нужны.
    ALTER TABLE supply_assemblies ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON supply_assemblies USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );

    -- Удалять заходы приложению незачем: они уходят только вместе с поставкой.
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='argus_app') THEN
      GRANT SELECT, INSERT, UPDATE ON supply_assemblies TO argus_app;
    END IF; END $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS supply_assemblies;');
};
