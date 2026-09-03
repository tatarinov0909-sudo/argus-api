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

function cellLabel(r) {
  const rack = r.rack_start === r.rack_end ? r.rack_start : `${r.rack_start}–${r.rack_end}`;
  const tier = r.tier_start === r.tier_end ? r.tier_start : `${r.tier_start}–${r.tier_end}`;
  return `${r.row_num}.${rack}.${tier}`;
}

async function buildPickList(client, warehouseId, invoiceIds = []) {
  // Без списка берём всё, что реально ждёт отбора: открытые и начатые
  // отгрузки. Именно этот случай и есть «утро, заказов много».
  const invoices = await client.query(
    `SELECT i.id, i.number, i.company_id, c.name AS company_name
     FROM invoices i JOIN companies c ON c.id = i.company_id
     WHERE i.warehouse_id = $1 AND i.direction = 'out'
       AND i.status IN ('open', 'in_progress')
       AND ($2::uuid[] IS NULL OR i.id = ANY($2::uuid[]))
     ORDER BY i.created_at`,
    [warehouseId, invoiceIds.length ? invoiceIds : null],
  );
  if (invoices.rows.length === 0) {
    return { orders: [], lines: [], totalUnits: 0, cellsToVisit: 0 };
  }
  const ids = invoices.rows.map((r) => r.id);

  // Что осталось добрать по каждой строке: заявлено минус уже отобранное.
  // Закрытые строки (is_final) в лист не попадают — по ним ходить незачем.
  const items = await client.query(
    `SELECT ii.id, ii.invoice_id, ii.sku, ii.name, ii.company_id, ii.declared_qty,
            COALESCE((SELECT SUM(sr.picked_qty) FROM shipping_records sr
                      WHERE sr.invoice_item_id = ii.id), 0) AS picked,
            EXISTS (SELECT 1 FROM shipping_records sr2
                    WHERE sr2.invoice_item_id = ii.id AND sr2.is_final) AS closed
     FROM invoice_items ii
     WHERE ii.invoice_id = ANY($1::uuid[])
     ORDER BY ii.name`,
    [ids],
  );

  const byNumber = new Map(invoices.rows.map((r) => [r.id, r.number]));

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
      });
    }
    const line = lines.get(key);
    line.needQty += need;
    line.perOrder.push({ invoiceNumber: byNumber.get(it.invoice_id), qty: need, invoiceItemId: it.id });
  }
  if (lines.size === 0) {
    return {
      orders: invoices.rows.map((r) => ({ number: r.number, company: r.company_name })),
      lines: [], totalUnits: 0, cellsToVisit: 0,
    };
  }

  // Где это лежит — только годное: брак и ждущий перепаковки клиенту не едут.
  const stock = await client.query(
    `SELECT cs.company_id, cs.sku, cs.cell_block_id, SUM(cs.qty) AS available,
            wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
     FROM cell_stock cs
     JOIN cell_blocks cb ON cb.id = cs.cell_block_id
     JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
     WHERE cs.warehouse_id = $1 AND cs.qty > 0 AND cs.quality = 'good'
     GROUP BY cs.company_id, cs.sku, cs.cell_block_id, wr.row_num,
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
      needQty: line.needQty,
      cells,
      // Нехватку показываем здесь же: узнать о ней до похода, а не у полки.
      shortfall: left,
      perOrder: line.perOrder,
    });
  }

  // Порядок строк — по первой ячейке маршрута: лист читается сверху вниз и
  // ведёт работника по складу, а не гоняет туда-обратно.
  result.sort((a, b) => {
    const aFirst = a.cells[0]?.label || 'я';
    const bFirst = b.cells[0]?.label || 'я';
    return aFirst.localeCompare(bFirst, 'ru', { numeric: true });
  });

  return {
    orders: invoices.rows.map((r) => ({ number: r.number, company: r.company_name })),
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
