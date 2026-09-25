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

// Ключ продавца — внешний пользователь: файл без предела держал бы соединение
// с базой, пока разбираются десятки тысяч строк (проверка 25.09.2026).
// Столько же, сколько у загрузки остатков по ячейкам.
const MAX_LINES = 5000;
const MAX_GRID_ROWS = 20000;
const UNIQUE_VIOLATION = '23505';

const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
const low = (v) => text(v).toLowerCase().replace(/ё/g, 'е');

// Количество штук — целое и больше нуля, как на любом другом входе склада.
// «1 200» и «12 шт» — да; «1,5» и «0x10» — нет: такую строку показываем с
// причиной, а не округляем и не читаем по-своему. Пусто и ноль — строки нет.
function qtyOf(v) {
  if (typeof v === 'number') {
    if (v === 0) return { empty: true };
    return Number.isInteger(v) && v > 0 ? { qty: v } : { error: `количество «${v}» — не целое число штук` };
  }
  const raw = text(v);
  const t = raw.replace(/[\s ]/g, '').replace(/шт\.?$/i, '');
  if (!t || /^0+$/.test(t)) return { empty: true };
  if (!/^\d{1,7}$/.test(t)) return { error: `количество «${raw}» — не целое число штук` };
  return { qty: Number(t) };
}

// \b в JS не видит границу слова после кириллицы — отсюда (?![а-яa-z]).
const COLUMNS = {
  qty: /^(кол-?во|количество|кол\.?|qty|quantity|штук|шт\.?|к поставке)(?![а-яa-z])/,
  barcode: /(баркод|штрих-?код|^шк$|barcode|ean)/,
  article: /(артикул|^арт\.?|sku|^код|vendor ?code)/,
  name: /(наименование|название|^товар|номенклатура|^name)/,
};

function limitLines(lines) {
  if (lines.length > MAX_LINES) {
    throw new HttpError(400, `За раз — не больше ${MAX_LINES} строк. Разбейте файл на части`);
  }
  return lines;
}

// Разбор таблицы. grid — строки листа как массивы значений.
function parseInboundSheet(grid) {
  if (!Array.isArray(grid) || grid.length === 0) throw new HttpError(400, 'В файле нет строк');
  if (grid.length > MAX_GRID_ROWS) {
    throw new HttpError(400, `За раз — не больше ${MAX_LINES} строк. Разбейте файл на части`);
  }
  const rows = grid.map((r) => (Array.isArray(r) ? r : []));
  // Ведомость 1С — свой формат: количество в «Конечный остаток».
  if (rows.slice(0, 25).some((r) => r.some((v) => /^конечный остаток$/i.test(text(v))))) {
    return limitLines(parseStockSheet(grid).filter((r) => r.qty > 0)
      .map((r, i) => ({ row: i + 1, barcode: r.barcode, article: r.article || r.code, name: r.name, ...qtyOf(r.qty) })));
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
      const line = {
        row: i + 1,
        barcode: cols.barcode === undefined ? null : (text(r[cols.barcode]).replace(/\.0+$/, '') || null),
        article: cols.article === undefined ? null : (text(r[cols.article]).replace(/\.0+$/, '') || null),
        name: cols.name === undefined ? null : (text(r[cols.name]) || null),
      };
      if (!line.barcode && !line.article && !line.name) continue;
      if ([line.barcode, line.article, line.name].some((v) => /^(итог|всего)/i.test(v || ''))) continue;
      const q = qtyOf(r[cols.qty]);
      if (q.empty) continue;
      out.push({ ...line, ...q });
    }
    if (out.length) return limitLines(out);
  }
  throw new HttpError(400, 'Не нашёл в файле колонку количества и колонку штрихкода, артикула или названия товара');
}

// Каталог продавца одним заходом: строк в файле до пяти тысяч, и запрос на
// каждую держал бы соединение с базой всё это время.
async function loadCatalog(client, companyId) {
  const products = (await client.query(
    `SELECT sku, name, btrim(barcode) AS barcode,
            substring(name from '([0-9]{8,14})[[:space:]]*$') AS name_barcode
       FROM products WHERE company_id = $1 AND active`, [companyId])).rows;
  const links = (await client.query(
    `SELECT m.sku, m.mp_barcode, m.mp_article FROM product_marketplace_skus m
       JOIN products p ON p.company_id = m.company_id AND p.sku = m.sku AND p.active
      WHERE m.company_id = $1`, [companyId])).rows;
  const byBarcode = new Map(); const byArticle = new Map(); const byName = new Map();
  const add = (map, key, sku) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(sku);
  };
  const names = new Map();
  for (const p of products) {
    names.set(p.sku, p.name);
    add(byBarcode, p.barcode, p.sku);
    add(byBarcode, p.name_barcode, p.sku);
    add(byArticle, p.sku.toUpperCase(), p.sku);
    add(byName, low(p.name), p.sku);
  }
  for (const m of links) {
    add(byBarcode, m.mp_barcode, m.sku);
    add(byArticle, m.mp_article && m.mp_article.toUpperCase(), m.sku);
  }
  // Товар узнаём, только если ключ указывает ровно на один товар.
  const one = (map, key) => {
    const set = key && map.get(key);
    return set && set.size === 1 ? [...set][0] : null;
  };
  return (line) => {
    for (const [sku, by] of [
      [line.barcode && one(byBarcode, line.barcode), 'штрихкод'],
      [line.article && one(byArticle, line.article.toUpperCase()), 'артикул'],
      [line.name && one(byName, low(line.name)), 'название'],
    ]) {
      if (sku) return { product: { sku, name: names.get(sku) }, by };
    }
    return { product: null, by: null };
  };
}

// Следующий свободный номер прихода за сегодня — как у прихода, заведённого
// складом: ПР-ДДММГГ-N. Год — чтобы через год номера не пошли по кругу.
async function nextNumber(client, warehouseId) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  const prefix = `ПР-${String(d.getDate()).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}`
    + `${String(d.getFullYear()).slice(2)}-`;
  const taken = new Set((await client.query(
    'SELECT number FROM invoices WHERE warehouse_id = $1 AND number LIKE $2', [warehouseId, `${prefix}%`],
  )).rows.map((r) => r.number));
  let n = 1;
  while (taken.has(prefix + n)) n += 1;
  return prefix + n;
}

// Номер и приход — под замком склада: продавцы жмут «Отправить» когда хотят,
// и без замка двое одновременно получали один номер, а второй — отказ
// (проверка 25.09.2026). Замок живёт до конца транзакции. Номер, занятый
// кем-то в обход замка (приход, заведённый складом), — ещё попытка.
async function insertInvoice(client, warehouseId, companyId, plannedDate) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('seller-inbound-number:' || $1))", [warehouseId]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const number = await nextNumber(client, warehouseId);
    await client.query('SAVEPOINT inbound_number');
    try {
      const inv = (await client.query(
        `INSERT INTO invoices (warehouse_id, company_id, number, direction, source_document_type, source_document_date)
         VALUES ($1, $2, $3, 'in', 'seller_inbound', $4) RETURNING id, number`,
        [warehouseId, companyId, number, plannedDate || null],
      )).rows[0];
      await client.query('RELEASE SAVEPOINT inbound_number');
      return inv;
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT inbound_number');
      if (err.code !== UNIQUE_VIOLATION) throw err;
    }
  }
  throw new HttpError(409, 'Не удалось выдать номер прихода — попробуйте ещё раз');
}

async function run(client, { warehouseId, companyId, grid, apply = false, plannedDate = null, comment = '', actor = {} }) {
  const lines = parseInboundSheet(grid);
  const find = await loadCatalog(client, companyId);
  const found = [];
  const bySku = new Map();
  for (const line of lines) {
    const { product, by } = line.error ? { product: null, by: null } : find(line);
    const item = { ...line, qty: line.qty || 0, sku: product ? product.sku : null, productName: product ? product.name : null, by };
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
  const inv = await insertInvoice(client, warehouseId, companyId, plannedDate);
  await client.query(
    `INSERT INTO invoice_items (invoice_id, warehouse_id, company_id, name, sku, declared_qty)
     SELECT $1, $2, $3, x.name, x.sku, x.qty
       FROM jsonb_to_recordset($4::jsonb) AS x(name text, sku text, qty int)`,
    [inv.id, warehouseId, companyId, JSON.stringify(items)]);
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
