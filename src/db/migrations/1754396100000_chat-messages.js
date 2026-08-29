/* eslint-disable camelcase */

exports.shorthands = undefined;

// Память чата.
//
// До этого каждый вопрос уходил в модель с чистого листа: спросить «а в каком
// ряду?» вторым сообщением было нельзя, приходилось каждый раз повторять
// артикул целиком. И вся переписка жила только в разметке страницы — обновил
// вкладку, и разговора не было.
//
// Переписка привязана и к складу, и к автору. Склад нужен для RLS, как везде;
// автор — потому что у владельца и работников склад один, а чат у каждого свой.
// Показывать работнику вопросы владельца никто не просил, и по умолчанию делать
// этого не стоит.
//
// author_id — это ownerId у владельца и staffKeyId у работника. Внешнего ключа
// нет намеренно: ключ работника можно отозвать, и его переписка от этого не
// должна исчезать из истории вместе с ним.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
      author_id UUID NOT NULL,
      -- 'user' — то, что написал человек; 'agent' — ответ.
      role TEXT NOT NULL CHECK (role IN ('user', 'agent')),
      -- Кто именно ответил: «Оркестратор», «Кладовщик». У сообщений человека пусто.
      agent TEXT,
      text TEXT NOT NULL,
      -- Шаги маршрутизации: кому передали задачу и с каким запросом. Храним,
      -- чтобы при перезагрузке страницы переписка выглядела так же, как в
      -- момент разговора, а не теряла середину.
      steps JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Читаем всегда одним и тем же способом: последние N сообщений одного
    -- автора на одном складе, в обратном порядке.
    CREATE INDEX IF NOT EXISTS idx_chat_messages_thread
      ON chat_messages (warehouse_id, author_id, created_at DESC);

    ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON chat_messages USING (
      warehouse_id = NULLIF(current_setting('app.current_warehouse_id', true), '')::uuid
    );
  `);

  // setup-app-role.sql выдаёт права снимком на момент своего запуска и новые
  // таблицы не покрывает — без этого приложение подключится и упадёт на первом
  // же сообщении с «permission denied for table chat_messages».
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON chat_messages TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS chat_messages CASCADE;`);
};
