// Продавец оформляет привоз товара на склад файлом (решение владельца
// 25.09.2026). Какой таблицей пользуется продавец, заранее не знаем: шаблон
// поставки WB («Баркод», «Количество»), своя таблица («Артикул», «Название»,
// «Кол-во»), ведомость 1С. Поэтому ищем в шапке колонку количества и то, по
// чему узнать товар, — штрихкод, артикул или название, — и сопоставляем с
// каталогом продавца. Что узнали — становится приходом «ждёт приёмки» у
// склада; что нет — показываем продавцу строкой, а не молча теряем.
const { HttpError } = require('../middleware/errorHandler');
const { parseStockSheet } = require('../cells/stockAlign');
const journal = require('../journal/repository');

const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
const low = (v) => text(v).toLowerCase().replace(/ё/g, 'е');
const qtyOf = (v) => {
  const n = Number(String(v === null || v === undefined ? '' : v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

// \b в JS не видит границу слова после кириллицы — отсюда (?![а-яa-z]).
const COLUMNS = {
  qty: /^(кол-?во|количество|кол\.?|qty|quantity|штук|шт\.?|к поставке)(?![а-яa-z])/,
  barcode: /(баркод|штрих-?код|^шк$|barcode|ean)/,
  article: /(артикул|^арт\.?|sku|^код|vendor ?code)/,
  name: /(наименование|название|^товар|номенклатура|^name)/,
};

// Разбор таблицы. grid — строки листа как массивы значений.
function parseInboundSheet(grid) {
  if (!Array.isArray(grid) || grid.length === 0) throw new HttpError(400, 'В файле нет строк');
  const rows = grid.map((r) => (Array.isArray(r) ? r : []));
  // Ведомость 1С — свой формат: количество в «Конечный остаток».
  if (rows.slice(0, 25).some((r) => r.some((v) => /^конечный остаток$/i.test(text(v))))) {
    return parseStockSheet(grid).filter((r) => r.qty > 0)
      .map((r, i) => ({ row: i + 1, barcode: r.barcode, article: r.article || r.code, name: r.name, qty: r.qty }));
  }
  for (let h = 0; h < Math.min(30, rows.length); h += 1) {
    const cols = {};
    rows[h].forEach((v, j) => {
      const t = low(v);
      if (!t) return;
      for (const [key, re] of Object.entries(COLUMNS)) {
        // «Кол-во коробов» — не количество товара.
        if (key === 'qty' && /короб|паллет|мест/.test(t)) continue;
        if (cols[key] === undefined && re.test(t)) cols[key] = j;
      }
    });
    if (cols.qty === undefined || (cols.barcode === undefined && cols.article === undefined && cols.name === undefined)) continue;
    const out = [];
    for (let i = h + 1; i < rows.length; i += 1) {
      const r = rows[i];
      const qty = qtyOf(r[cols.qty]);
      const line = {
        row: i + 1,
        barcode: cols.barcode === undefined ? null : (text(r[cols.barcode]).replace(/\.0+$/, '') || null),
        article: cols.article === undefined ? null : (text(r[cols.article]).replace(/\.0+$/, '') || null),
        name: cols.name === undefined ? null : (text(r[cols.name]) || null),
        qty,
      };
      if (!line.barcode && !line.article && !line.name) continue;
      if ([line.barcode, line.article, line.name].some((v) => /^(итог|всего)/i.test(v || ''))) continue;
      if (qty === null || qty <= 0) continue;
      out.push(line);
    }
    if (out.length) return out;
  }
  throw new HttpError(400, 'Не нашёл в файле колонку количества и колонку штрихкода, артикула или названия товара');
}

// Товар продавца по строке файла: штрихкод, артикул, название.
async function findProduct(client, companyId, line) {
  const one = (rows) => (rows.length === 1 ? rows[0] : null);
  if (line.barcode) {
    const r = await client.query(
      `SELECT DISTINCT p.sku, p.name FROM products p
         LEFT JOIN product_marketplace_skus m ON m.company_id = p.company_id AND m.sku = p.sku
        WHERE p.company_id = $1 AND p.active
          AND (btrim(p.barcode) = $2 OR substring(p.name from '([0-9]{8,14})[[:space:]]*$') = $2 OR m.mp_barcode = $2)`,
      [companyId, line.barcode]);
    if (one(r.rows)) return { product: r.rows[0], by: 'штрихкод' };
  }
  if (line.article) {
    const r = await client.query(
      `SELECT DISTINCT p.sku, p.name FROM products p
         LEFT JOIN product_marketplace_skus m ON m.company_id = p.company_id AND m.sku = p.sku
        WHERE p.company_id = $1 AND p.active AND (upper(p.sku) = upper($2) OR upper(m.mp_article) = upper($2))`,
      [companyId, line.article]);
    if (one(r.rows)) return { product: r.rows[0], by: 'артикул' };
  }
  if (line.name) {
    const r = await client.query(
      `SELECT sku, name FROM products WHERE company_id = $1 AND active AND lower(btrim(name)) = lower($2)`,
      [companyId, line.name]);
    if (one(r.rows)) return { product: r.rows[0], by: 'название' };
  }
  return { product: null, by: null };
}

// Следующий свободный номер прихода за сегодня — как у прихода, заведённого
// складом: ПР-ДДММ-N.
async function nextNumber(client, warehouseId) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  const prefix = `ПР-${String(d.getDate()).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}-`;
  const taken = new Set((await client.query(
    'SELECT number FROM invoices WHERE warehouse_id = $1 AND number LIKE $2', [warehouseId, `${prefix}%`],
  )).rows.map((r) => r.number));
  let n = 1;
  while (taken.has(prefix + n)) n += 1;
  return prefix + n;
}

async function run(client, { warehouseId, companyId, grid, apply = false, plannedDate = null, comment = '', actor = {} }) {
  const lines = parseInboundSheet(grid);
  const found = [];
  const bySku = new Map();
  for (const line of lines) {
    const { product, by } = await findProduct(client, companyId, line);
    const item = { ...line, sku: product ? product.sku : null, productName: product ? product.name : null, by };
    found.push(item);
    if (!product) continue;
    const agg = bySku.get(product.sku) || { sku: product.sku, name: product.name, qty: 0 };
    agg.qty += item.qty;
    bySku.set(product.sku, agg);
  }
  const items = [...bySku.values()];
  const summary = {
    lines: found.length,
    matched: found.filter((l) => l.sku).length,
    notMatched: found.filter((l) => !l.sku).length,
    products: items.length,
    units: items.reduce((s, i) => s + i.qty, 0),
  };
  if (!apply) return { applied: false, summary, lines: found };
  if (!items.length) throw new HttpError(400, 'В файле не нашлось ни одного товара из вашего каталога');
  if (plannedDate && !/^\d{4}-\d{2}-\d{2}$/.test(plannedDate)) throw new HttpError(400, 'Дата привоза — в виде ГГГГ-ММ-ДД');
  const company = (await client.query('SELECT name FROM companies WHERE id = $1', [companyId])).rows[0];
  const number = await nextNumber(client, warehouseId);
  const inv = (await client.query(
    `INSERT INTO invoices (warehouse_id, company_id, number, direction, source_document_type, source_document_date)
     VALUES ($1, $2, $3, 'in', 'seller_inbound', $4) RETURNING id, number`,
    [warehouseId, companyId, number, plannedDate || null],
  )).rows[0];
  for (const it of items) {
    await client.query(
      `INSERT INTO invoice_items (invoice_id, warehouse_id, company_id, name, sku, declared_qty)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [inv.id, warehouseId, companyId, it.name, it.sku, it.qty]);
  }
  await journal.createEntry(client, {
    warehouseId, agent: 'Кладовщик',
    actionText: `Продавец «${company.name}» оформил привоз ${inv.number}: ${items.length} товаров, ${summary.units} шт.`
      + (plannedDate ? ` Привезёт ${plannedDate.split('-').reverse().join('.')}.` : '')
      + (comment ? ` Комментарий: ${String(comment).slice(0, 300)}` : ''),
    entityType: 'invoice', entityId: inv.id, invoiceId: inv.id,
    actorType: actor.type || 'seller', actorId: actor.id || null,
  });
  return { applied: true, summary, lines: found, invoice: inv };
}

module.exports = { parseInboundSheet, run };
