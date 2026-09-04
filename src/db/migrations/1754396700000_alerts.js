/* eslint-disable camelcase */

exports.shorthands = undefined;

// Кладовщик до сих пор только отвечал на вопросы. Склад при этом сам подаёт
// сигналы — возврат лежит неразобранным, заказ собран и не уехал, расхождение
// ждёт решения, — и агент про всё это знал, но молчал, пока не спросят.
//
// Две вещи, которые определили форму таблицы:
//
// 1. Обнаружение — это SQL, а не модель. Тревога не стоит ни одного токена:
//    правило находит факт, текст собирается шаблоном. Модель включается,
//    только если владелец ответит и начнётся обычный разговор.
//
// 2. Тревоги НЕ ложатся в chat_messages. Оттуда последние сообщения уходят в
//    модель как история разговора — тревоги отравили бы контекст и съели
//    бюджет живых вопросов. Поэтому отдельная таблица и отдельный поток на
//    экране, сведённый по времени.
//
// key — устойчивое имя проблемы («расхождение такое-то», «синхронизация
// молчит»). Пока проблема жива, повторных сообщений о ней быть не должно:
// агент, который напоминает о том же каждый час, выключается в первую неделю.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE alerts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      -- Имя проблемы, а не текста: по нему ищется уже открытая тревога.
      alert_key TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      -- Проставляется, когда проблема исчезла сама (разобрали возврат,
      -- подтвердили расхождение). История остаётся: полезно видеть, что
      -- висело и как долго.
      resolved_at TIMESTAMPTZ,
      -- Владелец прочитал. На повторное появление не влияет.
      seen_at TIMESTAMPTZ
    );

    -- Одна открытая тревога на проблему. Индекс делает дедупликацию правилом
    -- базы, а не надеждой на аккуратность кода.
    CREATE UNIQUE INDEX idx_alerts_open_key
      ON alerts(warehouse_id, alert_key) WHERE resolved_at IS NULL;
    CREATE INDEX idx_alerts_warehouse ON alerts(warehouse_id, created_at DESC);

    ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON alerts USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );

    -- Сторож, который сам умер и молчит, хуже отсутствия сторожа. Отметка
    -- последнего прохода — единственный способ отличить «всё спокойно» от
    -- «проверка не работает уже сутки».
    CREATE TABLE alert_runs (
      warehouse_id UUID PRIMARY KEY REFERENCES warehouses(id) ON DELETE CASCADE,
      last_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_digest_on DATE
    );

    ALTER TABLE alert_runs ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON alert_runs USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON alerts TO argus_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON alert_runs TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS alerts CASCADE;
    DROP TABLE IF EXISTS alert_runs CASCADE;
  `);
};
