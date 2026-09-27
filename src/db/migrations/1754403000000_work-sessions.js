/* eslint-disable camelcase */

exports.shorthands = undefined;

// Приёмка прихода — такая же работа грузчика со своим состоянием, как сборка
// поставки (владелец 27.09.2026, задание «приёмка и склад»): «Начать» с
// таймером, выход — пауза, «Продолжить / Закончить / Отказаться»,
// комментарий «где оставил, что осталось», «забрать себе».
//
// Отдельная таблица под приёмку повторяла бы supply_assemblies столбец в
// столбец, а код — строку в строку. Поэтому таблица одна — заходы грузчика на
// работу (work_sessions): у захода сборки есть поставка, у захода приёмки —
// приход. Живой заход (идёт или на паузе) у документа по-прежнему один.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE supply_assemblies RENAME TO work_sessions;
    ALTER INDEX supply_assemblies_pkey RENAME TO work_sessions_pkey;
    ALTER INDEX supply_assemblies_live RENAME TO work_sessions_live_supply;
    ALTER INDEX supply_assemblies_by_supply RENAME TO work_sessions_by_supply;

    ALTER TABLE work_sessions
      ADD COLUMN kind TEXT NOT NULL DEFAULT 'assembly' CHECK (kind IN ('assembly', 'receiving')),
      ADD COLUMN invoice_id UUID REFERENCES invoices(id) ON DELETE CASCADE,
      ALTER COLUMN supply_id DROP NOT NULL;
    ALTER TABLE work_sessions ALTER COLUMN kind DROP DEFAULT;
    -- Приёмку ведут только в приложении: бумажного листа приёмки нет.
    ALTER TABLE work_sessions ADD CONSTRAINT work_sessions_target CHECK (
      (kind = 'assembly' AND supply_id IS NOT NULL AND invoice_id IS NULL)
      OR (kind = 'receiving' AND invoice_id IS NOT NULL AND supply_id IS NULL AND mode = 'app'));

    CREATE UNIQUE INDEX work_sessions_live_invoice ON work_sessions (invoice_id)
      WHERE status IN ('active', 'paused');
    CREATE INDEX work_sessions_by_invoice ON work_sessions (invoice_id, started_at DESC)
      WHERE invoice_id IS NOT NULL;
  `);
  // RLS (только склад) и права argus_app переезжают вместе с таблицей.
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM work_sessions WHERE kind = 'receiving';
    DROP INDEX IF EXISTS work_sessions_by_invoice;
    DROP INDEX IF EXISTS work_sessions_live_invoice;
    ALTER TABLE work_sessions DROP CONSTRAINT work_sessions_target;
    ALTER TABLE work_sessions DROP COLUMN invoice_id, DROP COLUMN kind;
    ALTER TABLE work_sessions ALTER COLUMN supply_id SET NOT NULL;
    ALTER INDEX work_sessions_by_supply RENAME TO supply_assemblies_by_supply;
    ALTER INDEX work_sessions_live_supply RENAME TO supply_assemblies_live;
    ALTER INDEX work_sessions_pkey RENAME TO supply_assemblies_pkey;
    ALTER TABLE work_sessions RENAME TO supply_assemblies;
  `);
};
