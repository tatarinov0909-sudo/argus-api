/* eslint-disable camelcase */

exports.shorthands = undefined;

// Заявки с лендинга.
//
// Единственная таблица в проекте без привязки к складу: заявку оставляет
// человек, у которого склада в Аргусе ещё нет — в этом весь смысл. Поэтому и
// RLS здесь нет: изолировать не по чему, а читать её через приложение никто
// не может, права на SELECT роли argus_app не выданы намеренно.
//
// До сих пор форма на лендинге ничего не отправляла: показывала «спасибо» и
// забывала введённое. Пустая вежливость хуже отсутствия формы — человек
// считает, что написал, и ждёт ответа.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE leads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT,
      contact TEXT,
      message TEXT,
      -- Что именно человек заполнил, целиком: форма на лендинге меняется чаще,
      -- чем схема базы, и терять новое поле из-за отсутствия колонки нельзя.
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      source TEXT NOT NULL DEFAULT 'landing',
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_leads_created ON leads(created_at DESC);
  `);

  // Только вставка: приложение принимает заявки, но читать их через него
  // нельзя — открытой ручки для чтения нет и заводить её без роли
  // администратора не следует.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'argus_app') THEN
        GRANT INSERT ON leads TO argus_app;
      END IF;
    END
    $$;
  `);
};

exports.down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS leads;');
};
