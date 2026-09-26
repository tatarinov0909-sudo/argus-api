// Кто везёт товар на склад (владелец 26.09.2026): перевозчик или водитель и
// номер машины. Их пишут, когда оформляют документы на выгрузку на хранение,
// — продавец в «Привезти товар». Комментарий складу тоже хранится у прихода,
// а не только строкой в журнале: его показывают в списке приходов.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS carrier TEXT;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS vehicle TEXT;
    ALTER TABLE invoices ADD COLUMN IF NOT EXISTS inbound_comment TEXT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE invoices DROP COLUMN IF EXISTS inbound_comment;
    ALTER TABLE invoices DROP COLUMN IF EXISTS vehicle;
    ALTER TABLE invoices DROP COLUMN IF EXISTS carrier;
  `);
};
