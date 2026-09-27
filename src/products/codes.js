// Коды, по которым товар узнают на полке и на коробке: штрихкод и артикул WB
// (номер карточки). Нужны там, где товар ищут глазами, — приёмка, карточка
// ячейки (владелец 27.09.2026: «крупно штрихкод, артикул, артикул WB»).
//
// Штрихкод — из карточки товара, а если там пусто — из сопоставления с WB
// (у товара с размерами их несколько — перечисляем все). Артикул WB — номер
// карточки из того же сопоставления (product_marketplace_skus.mp_sku).
//
// Подставляется в запрос как LEFT JOIN LATERAL; wh, co, sku — выражения
// SQL для склада, продавца и артикула строки, к которой пристёгиваем коды.
function productCodesJoin(wh, co, sku, alias = 'codes') {
  return `LEFT JOIN LATERAL (
    SELECT COALESCE(
             (SELECT NULLIF(BTRIM(p.barcode), '') FROM products p
               WHERE p.warehouse_id = ${wh} AND p.company_id = ${co} AND p.sku = ${sku}),
             (SELECT string_agg(DISTINCT BTRIM(m.mp_barcode), ', ') FROM product_marketplace_skus m
               WHERE m.warehouse_id = ${wh} AND m.company_id = ${co} AND m.sku = ${sku}
                 AND m.marketplace = 'wb' AND NULLIF(BTRIM(m.mp_barcode), '') IS NOT NULL)) AS barcode,
           (SELECT string_agg(DISTINCT BTRIM(m.mp_sku), ', ') FROM product_marketplace_skus m
             WHERE m.warehouse_id = ${wh} AND m.company_id = ${co} AND m.sku = ${sku}
               AND m.marketplace = 'wb' AND NULLIF(BTRIM(m.mp_sku), '') IS NOT NULL) AS wb_article
  ) ${alias} ON true`;
}

module.exports = { productCodesJoin };
