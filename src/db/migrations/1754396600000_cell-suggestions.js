/* eslint-disable camelcase */

exports.shorthands = undefined;

// Аргус приходит не на пустой склад. У клиента уже год лежит товар по его
// собственному порядку, и часто по причинам, которых в базе нет: колонна,
// сквозняк, «здесь всегда этот продавец». Подсказка обязана этот порядок
// повторять, а не навязывать свой.
//
// Единственный способ узнать причины, которых мы не видим, — смотреть, что
// работник делает с подсказкой. Согласился — правило угадало. Обошёл ячейку
// сорок раз — у неё есть причина, и предлагать её больше не надо.
//
// Поэтому подсказку записываем в момент выдачи (пересчитать её потом нельзя:
// склад к тому времени другой), а выбор работника дописываем при приёмке.
// Пока это только честная запись фактов — никаких выводов из неё ещё не
// делается, и специально: сначала данные, потом правило.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE cell_suggestions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
      sku TEXT NOT NULL,
      -- Что именно показали работнику и почему — в том порядке, в котором он
      -- это увидел. Первая опция и есть «главный совет».
      options JSONB NOT NULL,
      worker_key_id UUID REFERENCES staff_keys(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Заполняется приёмкой. NULL значит «работник так и не положил товар»:
      -- отвлёкся, отменил, ушёл — это тоже факт, и терять его незачем.
      chosen_cell_block_id UUID REFERENCES cell_blocks(id) ON DELETE SET NULL,
      decided_at TIMESTAMPTZ
    );

    CREATE INDEX idx_cell_suggestions_warehouse ON cell_suggestions(warehouse_id, created_at DESC);
    CREATE INDEX idx_cell_suggestions_sku ON cell_suggestions(warehouse_id, sku);

    ALTER TABLE cell_suggestions ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON cell_suggestions USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );
  `);

  // Гранты снимком в setup-app-role.sql новые таблицы не покрывают — без
  // этого приложение падает на первом же обращении «permission denied».
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON cell_suggestions TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS cell_suggestions CASCADE;`);
};
