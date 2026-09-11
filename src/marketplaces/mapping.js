const { HttpError } = require('../middleware/errorHandler');

// Сопоставление артикулов площадки с номенклатурой склада.
//
// Заказ приезжает с артикулом продавца — «1201010228». Склад живёт нашими
// артикулами, и пока эти два не связаны, заказ виден, но собрать его нечем:
// кладовщик пойдёт искать на полке код, которого на складе нет.
//
// Таблица существовала с самого начала и заполнялась один раз, файлом с
// матрицей продавца. Ни ручки, ни экрана к ней не было — то есть владелец
// физически не мог починить ни один несопоставленный заказ и смотрел на
// «не удалось узнать товар у 36 заданий» без единой кнопки.

// Заказ считается несопоставленным, если его артикула нет в номенклатуре.
const UNMAPPED = `NOT EXISTS (SELECT 1 FROM products p
                               WHERE p.warehouse_id = ii.warehouse_id
                                 AND p.company_id = ii.company_id
                                 AND p.sku = ii.sku)`;

async function list(client, warehouseId, companyId) {
  const r = await client.query(
    `SELECT m.id, m.company_id, c.name AS company_name, m.sku, m.marketplace,
            m.mp_sku, m.mp_article, m.mp_barcode, m.updated_at,
            p.name AS product_name
       FROM product_marketplace_skus m
       JOIN companies c ON c.id = m.company_id
       LEFT JOIN products p ON p.warehouse_id = m.warehouse_id
                           AND p.company_id = m.company_id AND p.sku = m.sku
      WHERE m.warehouse_id = $1 AND ($2::uuid IS NULL OR m.company_id = $2::uuid)
      ORDER BY c.name, m.sku
      LIMIT 500`,
    [warehouseId, companyId || null],
  );
  return r.rows.map((x) => ({
    id: x.id,
    companyId: x.company_id,
    companyName: x.company_name,
    sku: x.sku,
    productName: x.product_name,
    marketplace: x.marketplace,
    mpSku: x.mp_sku,
    mpArticle: x.mp_article,
    mpBarcode: x.mp_barcode,
    // Товар мог быть удалён из 1С после того, как сопоставление завели.
    // Такая строка выглядит рабочей и не работает — это стоит видеть.
    orphan: !x.product_name,
    updatedAt: x.updated_at,
  }));
}

// Что именно ждёт сопоставления — из живой очереди заказов, а не из отчёта.
//
// Ключ группировки — артикул площадки, а если его не сохранили (заказы,
// заведённые до того, как мы начали хранить поля площадки), то наш `sku`:
// туда при неудачном сопоставлении и кладётся артикул продавца. Иначе
// самые старые заказы — те, которых площадка в очереди «новых» больше
// не отдаёт, — остались бы непочинимыми навсегда.
async function unresolved(client, warehouseId) {
  const r = await client.query(
    `SELECT i.company_id, c.name AS company_name,
            COALESCE(ii.mp_article, ii.sku) AS article,
            max(ii.mp_nm_id::text) AS mp_nm_id,
            max(ii.mp_barcode) AS mp_barcode,
            count(DISTINCT i.id)::int AS orders,
            min(i.created_at) AS oldest
       FROM invoices i
       JOIN invoice_items ii ON ii.invoice_id = i.id
       JOIN companies c ON c.id = i.company_id
      WHERE i.warehouse_id = $1
        AND i.direction = 'out'
        AND i.supply_id IS NULL
        AND i.status <> 'shipped'
        AND i.mp_closed_at IS NULL
        AND ${UNMAPPED}
      GROUP BY i.company_id, c.name, COALESCE(ii.mp_article, ii.sku)
      ORDER BY count(DISTINCT i.id) DESC
      LIMIT 200`,
    [warehouseId],
  );
  return r.rows.map((x) => ({
    companyId: x.company_id,
    companyName: x.company_name,
    article: x.article,
    mpNmId: x.mp_nm_id,
    mpBarcode: x.mp_barcode,
    orders: x.orders,
    oldest: x.oldest,
  }));
}

// Поиск по номенклатуре: у одного продавца двенадцать тысяч товаров, и
// отдавать их в браузер целиком, чтобы человек выбрал один, незачем.
async function searchProducts(client, warehouseId, companyId, q) {
  if (!companyId) throw new HttpError(400, 'Не указан продавец');
  const needle = String(q || '').trim();
  if (needle.length < 2) return [];
  const r = await client.query(
    `SELECT sku, name, barcode FROM products
      WHERE warehouse_id = $1 AND company_id = $2 AND active
        AND (sku ILIKE $3 OR name ILIKE $3 OR barcode = $4)
      ORDER BY (sku ILIKE $4) DESC, name
      LIMIT 20`,
    [warehouseId, companyId, `%${needle}%`, needle],
  );
  return r.rows;
}

async function save(client, warehouseId, {
  companyId, marketplace = 'wb', sku, mpSku = null, mpArticle = null, mpBarcode = null,
}) {
  if (!companyId) throw new HttpError(400, 'Не указан продавец');
  if (!sku) throw new HttpError(400, 'Не указан наш артикул');
  if (!mpSku && !mpArticle && !mpBarcode) {
    throw new HttpError(400, 'Нужен хотя бы один ключ площадки: артикул, номер карточки или штрихкод');
  }

  // Артикул проверяем по номенклатуре сразу. Сопоставление с товаром, которого
  // на складе нет, выглядит выполненной работой и не работает — а разбираться
  // придётся у полки, когда заказ уже в поставке.
  const product = await client.query(
    'SELECT sku, name FROM products WHERE warehouse_id = $1 AND company_id = $2 AND sku = $3',
    [warehouseId, companyId, sku],
  );
  if (!product.rows[0]) {
    throw new HttpError(404, `Артикула «${sku}» нет в номенклатуре этого продавца`);
  }

  // Один артикул площадки ведёт ровно к одному нашему товару. Старую связь
  // убираем, а не оставляем рядом: две связи на один артикул означают, что
  // собирать заказ придётся угадывая.
  await client.query(
    `DELETE FROM product_marketplace_skus
      WHERE warehouse_id = $1 AND marketplace = $2 AND company_id = $5
        AND ((mp_article IS NOT NULL AND mp_article = $3)
          OR (mp_sku IS NOT NULL AND mp_sku = $4)
          OR (mp_barcode IS NOT NULL AND mp_barcode = $6))`,
    [warehouseId, marketplace, mpArticle || null, mpSku || null, companyId, mpBarcode || null],
  );
  const ins = await client.query(
    `INSERT INTO product_marketplace_skus
       (warehouse_id, company_id, sku, marketplace, mp_sku, mp_article, mp_barcode)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [warehouseId, companyId, sku, marketplace, mpSku || null, mpArticle || null, mpBarcode || null],
  );

  // И сразу починить то, что уже лежит в очереди.
  //
  // Без этого шага экран был бы наполовину бесполезным: очередь `orders/new`
  // отдаёт только текущее, и заказ, ушедший из неё, второй раз не приедет —
  // пересопоставить его было бы негде. Правим только те позиции, которые
  // сейчас несопоставлены: у остальных артикул уже верный, и трогать его
  // значит переписать чужую работу.
  const fixed = await client.query(
    `UPDATE invoice_items ii
        SET sku = $3, name = $4
       FROM invoices i
      WHERE i.id = ii.invoice_id
        AND ii.warehouse_id = $1
        AND ii.company_id = $2
        AND i.direction = 'out'
        AND i.supply_id IS NULL
        AND i.status <> 'shipped'
        AND i.mp_closed_at IS NULL
        AND ${UNMAPPED}
        AND (($5::text IS NOT NULL AND (ii.mp_article = $5 OR ii.sku = $5))
          OR ($6::text IS NOT NULL AND ii.mp_nm_id::text = $6)
          OR ($7::text IS NOT NULL AND ii.mp_barcode = $7))`,
    [warehouseId, companyId, sku, product.rows[0].name || sku,
      mpArticle || null, mpSku || null, mpBarcode || null],
  );

  return { id: ins.rows[0].id, sku, name: product.rows[0].name, fixedOrders: fixed.rowCount };
}

async function remove(client, warehouseId, id) {
  const r = await client.query(
    'DELETE FROM product_marketplace_skus WHERE warehouse_id = $1 AND id = $2',
    [warehouseId, id],
  );
  if (r.rowCount === 0) throw new HttpError(404, 'Сопоставление не найдено');
  return { removed: r.rowCount };
}

module.exports = { list, unresolved, searchProducts, save, remove };
