/* eslint-disable camelcase */

exports.shorthands = undefined;

// Ссылки из записи журнала на ячейку и накладную.
//
// entity_type/entity_id у записи уже были, но указывали на одну сущность —
// обычно на строку накладной. Из-за этого журнал оставался текстом: прочитать
// «принято 38 вместо 40 в ячейке 4.12.2» можно, а пойти в эту ячейку — нет,
// адрес существовал только внутри фразы.
//
// Две отдельные необязательные колонки, а не расширение entity_*: у одного
// события обычно есть И документ, И место, и выбирать между ними — значит
// каждый раз терять половину.
//
// Журнал остаётся append-only: колонки заполняются в момент вставки, права на
// UPDATE у приложения по-прежнему нет.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE journal_entries
      ADD COLUMN invoice_id UUID REFERENCES invoices(id) ON DELETE SET NULL,
      ADD COLUMN cell_block_id UUID REFERENCES cell_blocks(id) ON DELETE SET NULL;

    -- «Что происходило с этой накладной» и «что происходило в этой ячейке» —
    -- два вопроса, которые journal обязан уметь отвечать быстро.
    CREATE INDEX idx_journal_invoice ON journal_entries(warehouse_id, invoice_id)
      WHERE invoice_id IS NOT NULL;
    CREATE INDEX idx_journal_cell ON journal_entries(warehouse_id, cell_block_id)
      WHERE cell_block_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_journal_cell;
    DROP INDEX IF EXISTS idx_journal_invoice;
    ALTER TABLE journal_entries
      DROP COLUMN IF EXISTS cell_block_id,
      DROP COLUMN IF EXISTS invoice_id;
  `);
};
