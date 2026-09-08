/* eslint-disable camelcase */

exports.shorthands = undefined;

// Поля заказа маркетплейса, из которых состоят печатные листы.
//
// Обмен читал их у Wildberries и тут же выбрасывал: в позицию накладной
// уходили только название, наш код и количество. А документы, которые
// владелец хочет получить один в один, состоят как раз из выброшенного:
//
//   rid       — «№ ОТПРАВЛЕНИЯ» в упаковочном листе. Приходит вместе
//               с заказом; я ошибочно считал, что за ним надо идти
//               в поставку, — проверено живым запросом 9 сентября.
//   article   — артикул продавца, колонка «АРТИКУЛ»
//   barcode   — штрихкод, колонка «ШТРИХКОД»
//   nm_id     — номер карточки; по нему ищется фото и открывается карточка
//
// Отдельные колонки, а не один JSON: по этим полям печатают, сортируют
// и ищут, а не хранят «на всякий случай». JSON пришлось бы разбирать
// в каждом запросе, и первая же опечатка в имени поля прошла бы молча.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE invoice_items
      ADD COLUMN IF NOT EXISTS mp_rid TEXT,
      ADD COLUMN IF NOT EXISTS mp_article TEXT,
      ADD COLUMN IF NOT EXISTS mp_barcode TEXT,
      ADD COLUMN IF NOT EXISTS mp_nm_id TEXT;

    -- Отправление уникально на площадке, и по нему сверяют посылку. Дубль
    -- означал бы две наклейки на одну коробку.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_items_mp_rid
      ON invoice_items(warehouse_id, mp_rid) WHERE mp_rid IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_invoice_items_mp_rid;
    ALTER TABLE invoice_items
      DROP COLUMN IF EXISTS mp_rid,
      DROP COLUMN IF EXISTS mp_article,
      DROP COLUMN IF EXISTS mp_barcode,
      DROP COLUMN IF EXISTS mp_nm_id;
  `);
};
