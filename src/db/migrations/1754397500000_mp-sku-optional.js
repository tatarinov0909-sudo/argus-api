/* eslint-disable camelcase */

exports.shorthands = undefined;

// Живая матрица продавца не влезла в первую версию ограничения — по двум
// причинам, и обе выяснились только на настоящих данных.
//
// 1. У компонентов наборов карточки на площадке нет вовсе: в матрице у них
//    стоит текст «--- нет МП ---». Обязательный mp_sku заставлял либо тащить
//    эту подпись в базу как номер (46 разных товаров схлопнулись в одну
//    строку), либо выбрасывать их вместе с артикулом и штрихкодом.
// 2. Одна карточка площадки может закрывать два наших кода: у 835248243 два
//    разных товара с разными артикулами и штрихкодами. Уникальность по одному
//    номеру карточки делала вторую строку невозможной.
//
// Поэтому: номер карточки необязателен, а уникальность — по паре «номер +
// артикул». Пустое значение в паре считается пустой строкой, иначе Postgres
// считал бы NULL-ы различными и пропускал бы настоящие дубли.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_marketplace_skus ALTER COLUMN mp_sku DROP NOT NULL;

    -- Мусор от первой загрузки: подпись «нет МП» вместо номера карточки.
    -- Номер у Wildberries всегда числовой, поэтому условие однозначное.
    UPDATE product_marketplace_skus
       SET mp_sku = NULL
     WHERE mp_sku IS NOT NULL AND mp_sku !~ '^[0-9]+$';

    DROP INDEX IF EXISTS idx_mp_sku_unique;

    CREATE UNIQUE INDEX idx_mp_sku_unique
      ON product_marketplace_skus(
        warehouse_id, marketplace, COALESCE(mp_sku, ''), COALESCE(mp_article, '')
      );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_mp_sku_unique;
    DELETE FROM product_marketplace_skus WHERE mp_sku IS NULL;
    ALTER TABLE product_marketplace_skus ALTER COLUMN mp_sku SET NOT NULL;
    CREATE UNIQUE INDEX idx_mp_sku_unique
      ON product_marketplace_skus(warehouse_id, marketplace, mp_sku);
  `);
};
