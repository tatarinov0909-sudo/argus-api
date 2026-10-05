/* eslint-disable camelcase */

exports.shorthands = undefined;

// Счета, проверка 05.10.2026.
//
// 1. Точные границы счёта по времени. Счёт помнил только даты, а работы
//    выбирались по датам в нынешнем поясе склада: после смены пояса вечерняя
//    приёмка попадала и в прошлый счёт, и в следующий (или ни в один). Новый
//    счёт хранит, с какой секунды по какую он считал работы, а следующий
//    начинается ровно с этой секунды.
// 2. Порядковый номер счёта у склада (СЧ-1, СЧ-2 …). Раньше номер — первые
//    8 знаков случайного идентификатора: не по порядку и мог совпасть у двух
//    счетов.
//
// Счета неизменяемы (триггер billing_invoice_immutable), поэтому у уже
// выставленных границ и номера нет: границы считаются по датам в нынешнем
// поясе, как раньше, номер остаётся прежним.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE billing_invoices
      ADD COLUMN covers_from TIMESTAMPTZ,
      ADD COLUMN covers_to TIMESTAMPTZ,
      ADD COLUMN number INT;
    CREATE UNIQUE INDEX billing_invoices_number ON billing_invoices (warehouse_id, number) WHERE number IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS billing_invoices_number;
    ALTER TABLE billing_invoices
      DROP COLUMN IF EXISTS number,
      DROP COLUMN IF EXISTS covers_to,
      DROP COLUMN IF EXISTS covers_from;
  `);
};
