/* eslint-disable camelcase */

exports.shorthands = undefined;

// Артикул продавца на площадке — отдельно от номера площадки.
//
// Wildberries присылает в сборочном задании три разных идентификатора:
//   nmId    — номер карточки в системе площадки (598949751);
//   article — артикул, который продавец задал сам (1201010209);
//   skus[]  — штрихкоды.
// В матрице продавца есть все три, и совпадать с нашим кодом они должны все:
// на живой очереди artikul оказался единственным, который заполнен у каждого
// задания, тогда как в самой матрице колонка «артикул продавца на WB» местами
// осталась от старой схемы («конфеты»). Класть его в mp_sku нельзя — там номер
// карточки, и уникальность построена на нём.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_marketplace_skus ADD COLUMN mp_article TEXT;

    -- Поиск при разборе заказа идёт по артикулу так же часто, как по номеру.
    CREATE INDEX idx_mp_skus_article
      ON product_marketplace_skus(warehouse_id, marketplace, mp_article);

    -- Штрихкод — третий путь к тому же товару, когда первых двух не хватило.
    CREATE INDEX idx_mp_skus_barcode
      ON product_marketplace_skus(warehouse_id, marketplace, mp_barcode);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_mp_skus_barcode;
    DROP INDEX IF EXISTS idx_mp_skus_article;
    ALTER TABLE product_marketplace_skus DROP COLUMN IF EXISTS mp_article;
  `);
};
