// «Лист грузчика» — сводный отбор по нескольким заказам сразу.
//
// Зачем: если заказов много, работник иначе бегает по складу за каждым
// отдельно и приходит в одну и ту же ячейку по три раза. Здесь одинаковый
// товар из разных заказов складывается, обход строится один раз по адресам
// ячеек, а разбивка «сколько чьё» остаётся в строке — разложить по заказам
// он сможет уже у стола, а не бегая между стеллажами.
//
// Считает правило, не модель: количество, ячейки и порядок обхода —
// арифметика и сортировка по адресу.

const { HttpError } = require('../middleware/errorHandler');
const { kitSkusAmong, kitInfo } = require('../kits/kits');
// Имя ячейки — общее на всё приложение. Своя копия этой функции печатала
// наши координаты «3.12.2» там, где на стеллаже висит табличка «01-10-015»:
// лист грузчика и лист комплектации называли одно место по-разному.
const { formatBlockLabel } = require('../cells/label');

const cellLabel = (r) => formatBlockLabel(r.row_num, r);

// Точка доставки приходит от поставки: по ней собранное раскладывают по
// машинам, и по ней же грузчик сортирует лист.
function orderView(r) {
  return {
    // id нужен печати: на бумагу уходит ровно то, что отобрано на экране.
    id: r.id,
    number: r.number,
    company: r.company_name,
    marketplace: r.source === '1c' ? '1c' : r.source,
    destination: r.destination || null,
    // Поставка целиком — для шапки листа: номер, куда везти, когда
    // отгрузка и когда пришла на склад. Заказ со склада без поставки — null.
    supply: r.supply_number ? {
      number: r.supply_number,
      destination: r.destination || null,
      shipDate: r.ship_date || null,
      arrivedAt: r.supply_created_at,
    } : null,
  };
}

async function buildPickList(client, warehouseId, invoiceIds = [], supplyId = null) {
  // Без списка берём всё, что реально ждёт отбора: открытые и начатые
  // отгрузки. Именно этот случай и есть «утро, заказов много». Заказы
  // с площадки — только отправленные менеджером на сборку, то есть
  // в поставке: вся очередь WB на листе грузчика означала бы, что решает
  // не менеджер, а тот, кто первым взял лист.
  const invoices = await client.query(
    `SELECT i.id, i.number, i.company_id, i.source, c.name AS company_name,
            s.destination, s.number AS supply_number,
            to_char(s.ship_date, 'YYYY-MM-DD') AS ship_date, s.created_at AS supply_created_at
     FROM invoices i JOIN companies c ON c.id = i.company_id AND c.archived_at IS NULL
     LEFT JOIN supplies s ON s.id = i.supply_id
     WHERE i.warehouse_id = $1 AND i.direction = 'out'
       AND i.status IN ('open', 'in_progress')
       AND i.mp_closed_at IS NULL
       AND (i.source = '1c' OR i.supply_id IS NOT NULL)
       AND ($2::uuid[] IS NULL OR i.id = ANY($2::uuid[]))
       AND ($3::uuid IS NULL OR i.supply_id = $3::uuid)
     ORDER BY i.created_at`,
    [warehouseId, invoiceIds.length ? invoiceIds : null, supplyId],
  );
  if (invoices.rows.length === 0) {
    return { orders: [], lines: [], totalUnits: 0, cellsToVisit: 0 };
  }
  const ids = invoices.rows.map((r) => r.id);

  // Что осталось добрать по каждой строке: заявлено минус уже отобранное.
  // Закрытые строки (is_final) в лист не попадают — по ним ходить незачем.
  const items = await client.query(
    `SELECT ii.id, ii.invoice_id, ii.sku, ii.name, ii.company_id, ii.declared_qty,
            ii.mp_article, COALESCE(NULLIF(BTRIM(ii.mp_barcode), ''), p.barcode) AS barcode,
            m.photo_url,
            COALESCE((SELECT SUM(sr.picked_qty) FROM shipping_records sr
                      WHERE sr.invoice_item_id = ii.id), 0) AS picked,
            EXISTS (SELECT 1 FROM shipping_records sr2
                    WHERE sr2.invoice_item_id = ii.id AND sr2.is_final) AS closed
     FROM invoice_items ii
     LEFT JOIN products p ON p.warehouse_id = ii.warehouse_id
                         AND p.company_id = ii.company_id AND p.sku = ii.sku
     -- Фото товара с площадки, если оно есть: по нему узнают товар на полке.
     LEFT JOIN LATERAL (SELECT pm.photo_url FROM marketplace_product_media pm
                         WHERE pm.company_id = ii.company_id AND pm.nm_id = ii.mp_nm_id
                           AND pm.photo_url IS NOT NULL LIMIT 1) m ON true
     WHERE ii.invoice_id = ANY($1::uuid[])
     ORDER BY ii.name`,
    [ids],
  );

  const byNumber = new Map(invoices.rows.map((r) => [r.id, r.number]));
  // Площадка заказа — для цветной пометки на листе: по ней видно, чьи
  // правила приёмки действуют, а всё остальное печатается чёрным.
  const bySource = new Map(invoices.rows.map((r) => [r.id, r.source === '1c' ? '1c' : r.source]));

  // Складываем одинаковый товар одной компании: у разных компаний товар лежит
  // в своих ячейках и смешивать его нельзя даже в листе.
  const lines = new Map();
  for (const it of items.rows) {
    const need = Number(it.declared_qty) - Number(it.picked);
    if (it.closed || need <= 0) continue;
    const key = `${it.company_id}|${it.sku}`;
    if (!lines.has(key)) {
      lines.set(key, {
        sku: it.sku, name: it.name, companyId: it.company_id, needQty: 0, perOrder: [],
        // Артикул площадки и штрихкод: по ним сборщик и ищет товар на полке,
        // а не по внутреннему коду.
        article: it.mp_article || null,
        barcode: it.barcode || null,
        photo: it.photo_url || null,
        marketplaces: new Set(),
      });
    }
    const line = lines.get(key);
    line.needQty += need;
    if (!line.article && it.mp_article) line.article = it.mp_article;
    if (!line.photo && it.photo_url) line.photo = it.photo_url;
    if (!line.barcode && it.barcode) line.barcode = it.barcode;
    line.marketplaces.add(bySource.get(it.invoice_id) || '1c');
    line.perOrder.push({
      invoiceNumber: byNumber.get(it.invoice_id), qty: need, invoiceItemId: it.id,
      marketplace: bySource.get(it.invoice_id) || '1c',
    });
  }
  if (lines.size === 0) {
    return {
      orders: invoices.rows.map(orderView),
      lines: [], totalUnits: 0, cellsToVisit: 0,
    };
  }

  // Где это лежит — только годное: брак и ждущий перепаковки клиенту не едут.
  const stock = await client.query(
    `SELECT cs.company_id, cs.sku, cs.cell_block_id, SUM(cs.qty) AS available,
            wr.row_num, cb.label, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
     FROM cell_stock cs
     JOIN cell_blocks cb ON cb.id = cs.cell_block_id
     JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
     WHERE cs.warehouse_id = $1 AND cs.qty > 0 AND cs.quality = 'good'
     GROUP BY cs.company_id, cs.sku, cs.cell_block_id, wr.row_num, cb.label,
              cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
     ORDER BY wr.row_num, cb.rack_start, cb.tier_start`,
    [warehouseId],
  );

  const stockByKey = new Map();
  for (const r of stock.rows) {
    const key = `${r.company_id}|${r.sku}`;
    if (!stockByKey.has(key)) stockByKey.set(key, []);
    stockByKey.get(key).push(r);
  }

  const result = [];
  const visited = new Set();
  for (const [key, line] of lines) {
    // Раскладываем нужное количество по ячейкам в порядке обхода: сколько
    // есть в первой, потом остаток во второй. Работнику остаётся идти и брать,
    // а не считать у стеллажа.
    let left = line.needQty;
    const cells = [];
    for (const r of stockByKey.get(key) || []) {
      if (left <= 0) break;
      const take = Math.min(left, Number(r.available));
      cells.push({
        cellBlockId: r.cell_block_id,
        label: cellLabel(r),
        available: Number(r.available),
        take,
      });
      visited.add(r.cell_block_id);
      left -= take;
    }
    result.push({
      sku: line.sku,
      name: line.name,
      companyId: line.companyId,
      article: line.article,
      barcode: line.barcode,
      photo: line.photo || null,
      marketplaces: [...line.marketplaces],
      needQty: line.needQty,
      cells,
      // Нехватку показываем здесь же: узнать о ней до похода, а не у полки.
      shortfall: left,
      perOrder: line.perOrder,
    });
  }

  // Нехватка у набора — это не всегда нехватка. Половина заказов с площадки
  // приходит наборами: артикула набора на полке нет и быть не может, пока его
  // не собрали, а компоненты лежат рядом. Без этой проверки лист сборки честно
  // писал бы «не хватает 5», отправляя работника искать то, чего не существует.
  const shortSkus = result.filter((l) => l.shortfall > 0).map((l) => l.sku);
  const kitSkus = await kitSkusAmong(client, warehouseId, shortSkus);
  // Компоненты общие: два разных набора из одной и той же коробки нельзя
  // обещать оба. Ведём счёт уже занятого — иначе лист говорит «собрать 5» и
  // «собрать 5», а на полке хватит только на пять всего.
  const takenComponents = new Map();
  for (const line of result) {
    if (line.shortfall <= 0 || !kitSkus.has(line.sku)) continue;
    const info = await kitInfo(client, warehouseId, line.companyId, line.sku);
    if (!info) continue;
    const key = (sku) => `${line.companyId}|${sku}`;
    // Сколько наборов реально соберём с учётом уже занятых компонентов.
    let buildable = info.buildable;
    for (const part of info.components || []) {
      const perKit = Number(part.perKit ?? part.qty ?? 0);
      if (!perKit) continue;
      const free = Math.max(0, Number(part.available ?? 0) - (takenComponents.get(key(part.sku)) || 0));
      buildable = Math.min(buildable, Math.floor(free / perKit));
    }
    buildable = Math.max(0, Math.min(buildable, line.shortfall));
    for (const part of info.components || []) {
      const perKit = Number(part.perKit ?? part.qty ?? 0);
      if (!perKit) continue;
      takenComponents.set(key(part.sku), (takenComponents.get(key(part.sku)) || 0) + perKit * buildable);
    }
    line.kit = {
      // Сколько из нехватки закрывается сборкой, а сколько не закрывается ничем.
      canBuild: buildable,
      stillShort: Math.max(0, line.shortfall - buildable),
      components: info.components,
      limitedBy: info.limitedBy,
    };
  }

  // Порядок строк — по первой ячейке маршрута: лист читается сверху вниз и
  // ведёт работника по складу, а не гоняет туда-обратно.
  result.sort((a, b) => {
    const aFirst = a.cells[0]?.label || 'я';
    const bFirst = b.cells[0]?.label || 'я';
    return aFirst.localeCompare(bFirst, 'ru', { numeric: true });
  });

  return {
    orders: invoices.rows.map(orderView),
    lines: result,
    totalUnits: result.reduce((sum, l) => sum + l.needQty, 0),
    cellsToVisit: visited.size,
  };
}

function parseInvoiceIds(raw) {
  if (!raw) return [];
  const ids = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const id of ids) {
    if (!uuid.test(id)) throw new HttpError(400, 'В списке заказов есть некорректный идентификатор');
  }
  return ids;
}

module.exports = { buildPickList, parseInvoiceIds };
