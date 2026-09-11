const wb = require('./wb');
const credentials = require('./credentials');
const statuses = require('./statuses');

// Забрать заказы с площадки и превратить их в накладные склада.
//
// Только чтение. Ничего на площадке не подтверждается, не отменяется и не
// меняется — статусы и остатки останутся как есть, пока владелец не разрешит
// обратное (флаг write_enabled и отдельный модуль записи, которого пока нет).
//
// Что здесь важнее всего: заказ с площадки — ДРУГОЙ документ, чем заказ из 1С,
// даже если номер совпал. Поэтому у накладной есть source, а уникальность в
// базе построена на тройке «склад + источник + внешний номер». Из-за этого же
// повторный проход ничего не дублирует: тот же externalId просто не вставится.

// Сопоставление артикула площадки с нашим кодом.
//
// Три пути к одному товару, в порядке надёжности:
//   1. номер карточки (nmId) — площадка меняет его крайне редко;
//   2. артикул продавца — на живой очереди заполнен у каждого задания;
//   3. штрихкод — последний шанс, когда первых двух нет в матрице.
// Первый попавшийся выигрывает; ищем одним запросом на весь проход, потому что
// заданий в очереди десятки, а походов в базу должно быть единицы.
async function loadMapping(client, warehouseId, companyId, marketplace) {
  const r = await client.query(
    `SELECT sku, mp_sku, mp_article, mp_barcode
     FROM product_marketplace_skus
     WHERE warehouse_id = $1 AND company_id = $2 AND marketplace = $3`,
    [warehouseId, companyId, marketplace],
  );
  const byNm = new Map();
  const byArticle = new Map();
  const byBarcode = new Map();
  // Одна карточка площадки может закрывать два наших кода — на живой матрице
  // так и оказалось. Номер карточки в этом случае ни на что не указывает
  // однозначно, и угадывать нельзя: выберем не тот товар — отгрузим не то.
  // Такой номер просто перестаёт быть ключом, решает артикул или штрихкод.
  const ambiguous = new Set();
  const ambiguousArticles = new Set();
  const ambiguousBarcodes = new Set();
  for (const row of r.rows) {
    if (row.mp_sku) {
      const key = String(row.mp_sku);
      if (byNm.has(key) && byNm.get(key) !== row.sku) ambiguous.add(key);
      byNm.set(key, row.sku);
    }
    if (row.mp_article) {
      const key = String(row.mp_article);
      if (byArticle.has(key) && byArticle.get(key) !== row.sku) ambiguousArticles.add(key);
      byArticle.set(key, row.sku);
    }
    if (row.mp_barcode) {
      const key = String(row.mp_barcode);
      if (byBarcode.has(key) && byBarcode.get(key) !== row.sku) ambiguousBarcodes.add(key);
      byBarcode.set(key, row.sku);
    }
  }
  for (const key of ambiguous) byNm.delete(key);
  for (const key of ambiguousArticles) byArticle.delete(key);
  for (const key of ambiguousBarcodes) byBarcode.delete(key);
  return (order) => {
    if (order.nmId && byNm.has(order.nmId)) return byNm.get(order.nmId);
    // дальше — артикул и штрихкод: они же выручают, когда номер оказался общим
    // на два товара и потому выброшен выше.
    if (order.article && byArticle.has(order.article)) return byArticle.get(order.article);
    for (const bc of order.barcodes) if (byBarcode.has(bc)) return byBarcode.get(bc);
    return null;
  };
}

// Имя товара берём из своего справочника: у площадки в сборочном задании его
// просто нет, а «PB000021144» на экране работника — это не название.
async function loadNames(client, warehouseId, companyId, skus) {
  if (!skus.length) return new Map();
  const r = await client.query(
    `SELECT sku, name FROM products
     WHERE warehouse_id = $1 AND company_id = $2 AND sku = ANY($3::text[])`,
    [warehouseId, companyId, skus],
  );
  return new Map(r.rows.map((x) => [x.sku, x.name]));
}

// Один заказ Wildberries — одно сборочное задание на один товар в одном
// экземпляре. Это свойство площадки, а не упрощение: задания на две штуки
// приходят двумя заданиями.
const QTY_PER_ORDER = 1;

async function pullWildberries(client, warehouseId, { companyId }) {
  const lock = await client.query(`SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked`,
    [`wb-sync:${warehouseId}:${companyId}`]);
  if (!lock.rows[0]?.locked) return { marketplace: 'wb', skipped: true, seen: 0, created: 0, existed: 0, unmapped: [] };
  const token = await credentials.tokenFor(client, warehouseId, companyId, 'wb');
  const orders = await wb.newOrders(token);
  await credentials.markUsed(client, warehouseId, companyId, 'wb');
  const imported = await importOrders(client, warehouseId, { companyId, orders });
  return { ...imported, statuses: await statuses.reconcile(client, warehouseId, companyId, token) };
}

// Сохранение заказов отдельно от их получения.
//
// Так это проверяется без сети — иначе единственный способ убедиться, что
// поля доезжают до накладной, это дождаться живого заказа. И тот же шов
// понадобится, чтобы дозагрузить историю: очередь `orders/new` отдаёт только
// текущее, а за прошлым надо идти в выборку по датам.
async function importOrders(client, warehouseId, { companyId, orders }) {
  const resolve = await loadMapping(client, warehouseId, companyId, 'wb');
  const resolved = orders.map((o) => ({ order: o, sku: resolve(o) }));
  const names = await loadNames(
    client, warehouseId, companyId,
    [...new Set(resolved.map((r) => r.sku).filter(Boolean))],
  );

  let created = 0;
  let existed = 0;
  const unmapped = [];

  for (const { order, sku } of resolved) {
    // Товар, которого нет в матрице, не выбрасываем: заказ существует, его
    // нельзя просто не заметить. Заводим накладную с артикулом площадки и
    // честной подписью — на складе она сразу видна как несобираемая, а не
    // теряется в отчёте, который никто не откроет.
    const isMapped = Boolean(sku);
    if (!isMapped) unmapped.push({ orderId: order.externalId, article: order.article });

    const lineSku = sku || order.article || order.nmId || order.externalId;
    const lineName = isMapped
      ? (names.get(sku) || sku)
      : `Не сопоставлен с номенклатурой: артикул WB ${order.article || order.nmId}`;

    const inserted = await client.query(
      `INSERT INTO invoices (warehouse_id, company_id, number, direction, source, external_id)
       VALUES ($1, $2, $3, 'out', 'wb', $4)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [warehouseId, companyId, `WB-${order.externalId}`, order.externalId],
    );
    if (!inserted.rows[0]) {
      existed += 1;
      // Заказ уже заведён — но, возможно, ещё до того, как мы стали сохранять
      // поля площадки. Дозаполняем, пока он в очереди: уйдёт из неё — взять
      // будет негде. COALESCE, а не перезапись: то, что уже сохранено, площадка
      // подтвердит тем же значением, а спорить с собой незачем.
      await client.query(
        `UPDATE invoice_items ii
            SET mp_rid     = COALESCE(ii.mp_rid, $3),
                mp_article = COALESCE(ii.mp_article, $4),
                mp_barcode = COALESCE(ii.mp_barcode, $5),
                mp_nm_id   = COALESCE(ii.mp_nm_id, $6)
          FROM invoices i
         WHERE i.id = ii.invoice_id
           AND ii.warehouse_id = $1
           AND i.external_id = $2
           AND i.source = 'wb'
           AND (ii.mp_rid IS NULL OR ii.mp_article IS NULL
                OR ii.mp_barcode IS NULL OR ii.mp_nm_id IS NULL)
           -- Только когда в накладной ровно одна позиция. Номер отправления
           -- уникален на складе, и записать его в две позиции сразу значит
           -- нарушить индекс и уронить весь проход обмена, а не одну строку.
           -- Сегодня заказ WB всегда одна позиция; появятся сплиты — здесь
           -- честно ничего не заполнится, а не сломается молча.
           AND (SELECT count(*) FROM invoice_items x WHERE x.invoice_id = i.id) = 1`,
        [warehouseId, order.externalId, order.rid || null, order.article || null,
          (order.barcodes && order.barcodes[0]) || null, order.nmId || null],
      );
      continue;
    }

    // Поля площадки сохраняем ВСЕ, из которых потом печатаются листы:
    // номер отправления, артикул продавца, штрихкод, номер карточки. Раньше
    // они читались у Wildberries и выбрасывались здесь же, а печатать было
    // нечем — и заново их взять негде: очередь `orders/new` отдаёт только
    // текущее, ушедшее из неё пропадает.
    await client.query(
      `INSERT INTO invoice_items
         (invoice_id, warehouse_id, company_id, name, sku, declared_qty,
          mp_rid, mp_article, mp_barcode, mp_nm_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [inserted.rows[0].id, warehouseId, companyId, lineName, lineSku, QTY_PER_ORDER,
        order.rid || null, order.article || null,
        (order.barcodes && order.barcodes[0]) || null, order.nmId || null],
    );
    created += 1;
  }

  return {
    marketplace: 'wb',
    seen: orders.length,
    created,
    existed,
    unmapped,
  };
}

// Проход по всем подключённым продавцам склада. Ошибка у одного не должна
// останавливать остальных: ключ мог протухнуть у кого-то одного.
async function pullAll(client, warehouseId) {
  const pairs = await credentials.list(client, warehouseId);
  const results = [];
  for (const pair of pairs) {
    if (pair.marketplace !== 'wb') continue;
    await client.query('SAVEPOINT marketplace_seller');
    try {
      results.push({
        company: pair.company,
        ...await pullWildberries(client, warehouseId, { companyId: pair.companyId }),
      });
      await client.query('RELEASE SAVEPOINT marketplace_seller');
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT marketplace_seller');
      await client.query('RELEASE SAVEPOINT marketplace_seller');
      results.push({ company: pair.company, marketplace: pair.marketplace, error: err.message });
    }
  }
  return results;
}

module.exports = { pullWildberries, importOrders, pullAll, loadMapping };
