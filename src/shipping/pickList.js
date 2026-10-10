// «Лист комплектовщика» — сводный отбор по нескольким заказам сразу.
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
// лист комплектовщика и лист комплектации называли одно место по-разному.
const { formatBlockLabel } = require('../cells/label');
const addressing = require('../cells/addressing');

const cellLabel = (r) => formatBlockLabel(r.row_num, r);

// Точка доставки приходит от поставки: по ней собранное раскладывают по
// машинам, и по ней же комплектовщик сортирует лист.
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

// full — вся поставка целиком, а не только то, что осталось взять: лист уже
// собранной поставки печатают «с отметками» (что откуда взято) или «пустым»
// (владелец 27.09.2026). Только вместе с supplyId.
async function buildPickList(client, warehouseId, invoiceIds = [], supplyId = null, { full = false } = {}) {
  const whole = Boolean(full && supplyId);
  // Без списка берём всё, что реально ждёт отбора: открытые и начатые
  // отгрузки. Именно этот случай и есть «утро, заказов много». Заказы
  // с площадки — только отправленные менеджером на сборку, то есть
  // в поставке: вся очередь WB на листе комплектовщика означала бы, что решает
  // не менеджер, а тот, кто первым взял лист.
  const invoices = await client.query(
    `SELECT i.id, i.number, i.company_id, i.source, c.name AS company_name,
            s.destination, s.number AS supply_number,
            to_char(s.ship_date, 'YYYY-MM-DD') AS ship_date, s.created_at AS supply_created_at
     FROM invoices i JOIN companies c ON c.id = i.company_id AND c.archived_at IS NULL
     LEFT JOIN supplies s ON s.id = i.supply_id
     WHERE i.warehouse_id = $1 AND i.direction = 'out'
       AND (i.status IN ('open', 'in_progress') OR $4::boolean)
       AND i.mp_closed_at IS NULL
       AND (i.source = '1c' OR i.supply_id IS NOT NULL)
       AND ($2::uuid[] IS NULL OR i.id = ANY($2::uuid[]))
       AND ($3::uuid IS NULL OR i.supply_id = $3::uuid)
     ORDER BY i.created_at`,
    [warehouseId, invoiceIds.length ? invoiceIds : null, supplyId, whole],
  );
  if (invoices.rows.length === 0) {
    return { orders: [], lines: [], totalUnits: 0, cellsToVisit: 0 };
  }
  const ids = invoices.rows.map((r) => r.id);

  // Что осталось добрать по каждой строке: заявлено минус уже отобранное.
  // Закрытые строки (is_final) в лист не попадают — по ним ходить незачем.
  const items = await client.query(
    `SELECT ii.id, ii.invoice_id, ii.sku, ii.name, ii.company_id, ii.declared_qty,
            -- Поставка «из всего товара продавца» (06.10.2026): склад строки — любой ('*').
            CASE WHEN COALESCE((SELECT s.vw_any FROM invoices i JOIN supplies s ON s.id = i.supply_id WHERE i.id = ii.invoice_id), false)
                 THEN '*' ELSE ii.virtual_warehouse_id::text END AS vw,
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
    const declared = Number(it.declared_qty);
    const picked = Math.min(Number(it.picked), declared);
    // Сколько по строке ещё взять с полки: закрытая строка — нисколько.
    const left = it.closed ? 0 : Math.max(0, declared - Number(it.picked));
    const need = whole ? declared : left;
    if (!whole && need <= 0) continue;
    // И один виртуальный склад (02.10.2026): товар склада «Озон» не идёт
    // в строку поставки с «Основного».
    const key = `${it.company_id}|${it.sku}|${it.vw || ''}`;
    if (!lines.has(key)) {
      lines.set(key, {
        sku: it.sku, name: it.name, companyId: it.company_id, vw: it.vw || null, needQty: 0, leftQty: 0, pickedQty: 0, perOrder: [],
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
    line.leftQty += left;
    line.pickedQty += picked;
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
    `SELECT cs.company_id, cs.sku, cs.virtual_warehouse_id AS vw, cs.cell_block_id, SUM(cs.qty) AS available,
            wr.row_num, cb.label, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
     FROM cell_stock cs
     JOIN cell_blocks cb ON cb.id = cs.cell_block_id
     JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
     WHERE cs.warehouse_id = $1 AND cs.qty > 0 AND cs.quality = 'good'
     GROUP BY cs.company_id, cs.sku, cs.virtual_warehouse_id, cs.cell_block_id, wr.row_num, cb.label,
              cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
     ORDER BY wr.row_num, cb.rack_start, cb.tier_start`,
    [warehouseId],
  );

  const stockByKey = new Map();
  const push = (key, r) => { if (!stockByKey.has(key)) stockByKey.set(key, []); stockByKey.get(key).push(r); };
  for (const r of stock.rows) {
    push(`${r.company_id}|${r.sku}|${r.vw || ''}`, r);
    // «Весь товар продавца»: эта ячейка годится и строкам с любым складом.
    push(`${r.company_id}|${r.sku}|*`, r);
  }

  // Откуда уже взято — для листа всей поставки: отметка стоит у той ячейки,
  // из которой товар действительно сняли.
  const takenByKey = new Map();
  if (whole) {
    const taken = await client.query(
      `SELECT ii.company_id, ii.sku, ii.virtual_warehouse_id AS vw, sr.cell_block_id, SUM(sr.picked_qty) AS qty,
              wr.row_num, cb.label, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
         FROM shipping_records sr
         JOIN invoice_items ii ON ii.id = sr.invoice_item_id
         LEFT JOIN cell_blocks cb ON cb.id = sr.cell_block_id
         LEFT JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
        WHERE ii.invoice_id = ANY($1::uuid[]) AND sr.picked_qty > 0
        GROUP BY ii.company_id, ii.sku, ii.virtual_warehouse_id, sr.cell_block_id, wr.row_num, cb.label,
                 cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
        ORDER BY wr.row_num, cb.rack_start, cb.tier_start`,
      [ids],
    );
    for (const r of taken.rows) {
      const mark = {
        cellBlockId: r.cell_block_id,
        label: r.row_num == null ? '—' : cellLabel(r),
        route: r.row_num == null ? [Infinity, 0, 0] : [Number(r.row_num), Number(r.rack_start), Number(r.tier_start)],
        qty: Number(r.qty),
      };
      // И для строки «весь товар продавца» (склад '*', 06.10.2026).
      for (const key of [`${r.company_id}|${r.sku}|${r.vw || ''}`, `${r.company_id}|${r.sku}|*`]) {
        if (!takenByKey.has(key)) takenByKey.set(key, []);
        takenByKey.get(key).push(mark);
      }
    }
  }

  // Название склада продавца у строки — комплектовщик видит, почему один товар
  // стоит в листе двумя строками (виртуальные склады, 02.10.2026).
  const vwIds = [...new Set([...lines.values()].map((l) => l.vw).filter((v) => v && v !== '*'))];
  const vwNames = new Map(vwIds.length ? (await client.query(
    'SELECT id, name FROM virtual_warehouses WHERE id = ANY($1::uuid[])', [vwIds])).rows.map((r) => [r.id, r.name]) : []);
  const result = [];
  const visited = new Set();
  // Адресное хранение выключено (06.10.2026): всё берут из «Склада», сколько
  // нужно — сверх учёта он уйдёт в минус, нехватки в листе нет.
  const general = await addressing.isOff(client, warehouseId) ? await addressing.ensureGeneral(client, warehouseId) : null;
  for (const [key, line] of lines) {
    // Раскладываем нужное количество по ячейкам в порядке обхода: сколько
    // есть в первой, потом остаток во второй. Работнику остаётся идти и брать,
    // а не считать у стеллажа. У листа всей поставки — только то, что ещё
    // не взято.
    let left = whole ? line.leftQty : line.needQty;
    const cells = [];
    if (general && left > 0) {
      const actual = (stockByKey.get(key) || []).reduce((n, r) => n + Number(r.available), 0);
      cells.push({ cellBlockId: general, label: addressing.GENERAL_LABEL, route: [0, 1, 1], available: actual, take: left });
      visited.add(general);
      left = 0;
    }
    for (const r of general ? [] : stockByKey.get(key) || []) {
      if (left <= 0) break;
      const take = Math.min(left, Number(r.available));
      cells.push({
        cellBlockId: r.cell_block_id,
        label: cellLabel(r),
        route: [Number(r.row_num), Number(r.rack_start), Number(r.tier_start)],
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
      vw: line.vw === '*' ? null : line.vw,
      vwName: line.vw === '*' ? 'Весь товар продавца' : line.vw ? vwNames.get(line.vw) || null : null,
      article: line.article,
      barcode: line.barcode,
      photo: line.photo || null,
      marketplaces: [...line.marketplaces],
      needQty: line.needQty,
      cells,
      // Нехватку показываем здесь же: узнать о ней до похода, а не у полки.
      shortfall: left,
      perOrder: line.perOrder,
      ...(whole ? {
        pickedQty: line.pickedQty,
        leftQty: line.leftQty,
        taken: takenByKey.get(key) || [],
      } : {}),
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
    const info = await kitInfo(client, warehouseId, line.companyId, line.sku, line.vw === '*' ? null : line.vw);
    if (!info) continue;
    const key = (sku) => `${line.companyId}|${sku}|${line.vw || ''}`;
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
  // Ряд, потом ячейка вдоль ряда, потом ярус — порядок шагов по складу.
  // Строки без ячеек — в конец.
  const routeOf = (line) => line.cells[0]?.route || line.taken?.[0]?.route || [Infinity, 0, 0];
  result.sort((a, b) => {
    const [ra, rb] = [routeOf(a), routeOf(b)];
    return (ra[0] - rb[0]) || (ra[1] - rb[1]) || (ra[2] - rb[2]);
  });

  return {
    orders: invoices.rows.map(orderView),
    lines: result,
    totalUnits: result.reduce((sum, l) => sum + l.needQty, 0),
    cellsToVisit: visited.size,
    ...(whole ? { full: true, pickedUnits: result.reduce((sum, l) => sum + l.pickedQty, 0) } : {}),
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
