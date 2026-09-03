/* eslint-disable camelcase */

exports.shorthands = undefined;

// Outbound orders (заказ) have two more real-world stages past "every line
// picked" that the old 3-value invoice_status couldn't tell apart: fully
// packed/labeled and staged (Собран), and physically loaded onto a truck and
// gone (Реализация/отгружен) — confirmed by the reference company's owner.
// Receiving invoices don't have either of these steps and keep using 'open'
// -> 'in_progress' -> 'completed' exactly as before; only shipping routes
// start writing 'ready'/'shipped'.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'ready';
    ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'shipped';
  `);
};

// Postgres can't drop enum values — a down migration here would need to
// recreate the type from scratch and remap any 'ready'/'shipped' rows first.
// Not worth building for a value-only rollback; treat this migration as
// forward-only.
exports.down = false;
