// «На WB» против «Доступно» (владелец 06.10.2026): сколько продавец выставил
// на WB по нашим складам WB и не больше ли это свободного товара. Одно правило
// для кабинета склада, сводки по продавцам и «Главной»; кабинет продавца
// считает так же у себя (seller-cabinet.js, wbOver).

// Размер WB → наш товар: по заказам, где размер записан; у размера,
// встречавшегося под разными кодами, — сначала настоящий товар продавца,
// потом самый частый (проверка 02.10, находка 7).
async function levels(client, warehouseId, companyId) {
  return (await client.query(
    `WITH sizes AS (
       SELECT DISTINCT ON (ii.mp_chrt_id) ii.mp_chrt_id AS chrt_id, ii.sku
         FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
        WHERE ii.warehouse_id = $1 AND ii.company_id = $2 AND i.source = 'wb' AND ii.mp_chrt_id IS NOT NULL
        GROUP BY ii.mp_chrt_id, ii.sku
        ORDER BY ii.mp_chrt_id,
                 EXISTS (SELECT 1 FROM products p
                          WHERE p.warehouse_id = $1 AND p.company_id = $2 AND p.sku = ii.sku) DESC,
                 count(*) DESC)
     SELECT s.sku, l.mp_warehouse_id, sum(l.amount)::int AS amount, max(l.fetched_at) AS fetched_at
       FROM wb_stock_levels l JOIN sizes s ON s.chrt_id = l.chrt_id
      WHERE l.warehouse_id = $1 AND l.company_id = $2
      GROUP BY s.sku, l.mp_warehouse_id`, [warehouseId, companyId])).rows;
}

// Свободно для WB: со складов, с которых собирают на WB («Остальной товар» и
// склады WB продавца), минус заказы вне поставки. Без складов — «Доступно».
function baseFree(row, wbVw) {
  if (!row.byWarehouse) return row.sellerAvailable == null ? null : row.sellerAvailable;
  const parts = row.byWarehouse.filter((w) => wbVw.has(w.id || ''));
  const own = (w) => (w.own === undefined ? w.available : w.own);
  if (parts.some((w) => own(w) == null)) return null;
  return Math.max(0, parts.reduce((n, w) => n + own(w), 0) - Number(row.orderedNotInSupply || 0));
}
// Набор — плюс сколько можно собрать из частей, лежащих там же, на складах
// для WB (stock.js, addKits → kitBuildableWb): иначе «На WB больше, чем
// свободно» по каждому набору было ложной тревогой, а части со склада «Озон»
// прятали настоящую (проверка 08.10, Н6).
function freeForWb(row, wbVw) {
  const kit = row.kitParts ? row.kitBuildableWb : 0;
  if (kit == null) return null;
  const base = baseFree(row, wbVw);
  return base == null ? null : base + Number(kit);
}

// sku → { listed, free, over, warehouses, top: { name, amount } } по товарам,
// которые выставлены хотя бы на одном нашем складе WB.
async function listing(client, warehouseId, companyId, rows) {
  const ours = new Map((await client.query(
    `SELECT mp_warehouse_id, name FROM seller_wb_warehouses
      WHERE warehouse_id = $1 AND company_id = $2 AND ours`, [warehouseId, companyId])).rows
    .map((w) => [String(w.mp_warehouse_id), w.name]));
  const out = new Map();
  if (!ours.size) return out;
  const wbVw = new Set([''].concat((await client.query(
    `SELECT id FROM virtual_warehouses WHERE company_id = $1 AND archived_at IS NULL AND marketplace = 'wb'`,
    [companyId])).rows.map((w) => w.id)));
  const bySku = new Map(rows.map((r) => [r.sku, r]));
  for (const l of await levels(client, warehouseId, companyId)) {
    const name = ours.get(String(l.mp_warehouse_id));
    if (name === undefined) continue;
    const x = out.get(l.sku) || { listed: 0, warehouses: 0, top: null };
    x.listed += l.amount;
    if (l.amount > 0) x.warehouses += 1;
    if (!x.top || l.amount > x.top.amount) x.top = { name, amount: l.amount };
    out.set(l.sku, x);
  }
  for (const [sku, x] of out) {
    const row = bySku.get(sku);
    x.free = row ? freeForWb(row, wbVw) : null;
    x.over = x.free != null && x.listed > x.free;
  }
  return out;
}

// Строкам остатка — «На WB» и расхождение; возвращает число товаров с ним.
async function annotate(client, warehouseId, companyId, rows) {
  const map = await listing(client, warehouseId, companyId, rows);
  let over = 0;
  for (const r of rows) {
    const x = map.get(r.sku);
    if (!x) continue;
    r.wbListed = x.listed;
    r.wbOver = x.over ? x.listed - x.free : 0;
    r.wbWarehouses = x.warehouses;
    r.wbTop = x.top;
    if (x.over && r.listed) over += 1;
  }
  return over;
}

module.exports = { levels, listing, annotate, baseFree };
