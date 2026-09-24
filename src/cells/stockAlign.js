// Сверка остатков продавца с документом (решение владельца 24.09.2026).
//
// Документ — отчёт 1С «Ведомость по товарам на складах» по товару продавца:
// строки сгруппированы «Артикул → Код → Номенклатура» (или короче), справа —
// приход, расход и «Конечный остаток». Такой отчёт присылает склад или сам
// продавец, и Аргус по нему делает три вещи за один заход:
//
//   1. Товар из документа — товар этого продавца. Карточка, которую обмен с
//      1С положил без владельца или в архив нераспределённого, переходит к
//      продавцу (тем же правилом, что и документ 1С с контрагентом). Так
//      больше не бывает «товар у продавца выключен, а остаток пишется в
//      архив» — у любого продавца, а не только у «Слим Тим».
//   2. Артикул из документа — это артикул продавца на WB: связь «артикул WB ↔
//      наш товар» заводится сама, и заказы перестают висеть несопоставленными.
//   3. Ячейки Аргуса выравниваются по документу: в одной ячейке — ставим
//      число из документа; в нескольких — разницу снимаем с самой полной или
//      добавляем в неё; товара нет ни в одной — по выбору владельца кладём в
//      свободную рядом с товаром продавца (подсказка Кладовщика), такой адрес
//      надо проверить на полке.
//
// Сначала всегда показываем, что изменится (apply: false), и только потом
// пишем. В 1С ничего не уходит: документ и так из неё.
const { HttpError } = require('../middleware/errorHandler');
const { refreshCellFill } = require('./fill');
const { formatBlockLabel } = require('./label');
const journal = require('../journal/repository');

const text = (v) => (v === null || v === undefined ? '' : String(v).trim());
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const barcodeOf = (name) => (text(name).match(/(\d{8,14})\s*$/) || [])[1] || null;

// Разобрать документ. grid — строки листа как массивы значений.
function parseStockSheet(grid) {
  if (!Array.isArray(grid) || grid.length === 0) throw new HttpError(400, 'В документе нет строк');
  const rows = grid.map((r) => (Array.isArray(r) ? r : []));

  // Шапка: где количество («Конечный остаток» — последняя такая колонка,
  // если отчёт по дням) и какие уровни группировки идут в строках.
  let qtyCol = -1;
  let labelCol = -1;
  let headerEnd = -1;
  const levels = [];
  rows.slice(0, 25).forEach((r, i) => {
    r.forEach((v, j) => {
      if (/^конечный остаток$/i.test(text(v))) { qtyCol = Math.max(qtyCol, j); headerEnd = Math.max(headerEnd, i); }
    });
    const j = r.findIndex((v) => /^номенклатура/i.test(text(v)));
    if (j >= 0) {
      const label = text(r[j]);
      levels.push(/артикул/i.test(label) ? 'article' : /\.код/i.test(label) ? 'code' : 'name');
      labelCol = labelCol < 0 ? j : labelCol;
      headerEnd = Math.max(headerEnd, i);
    }
  });
  if (qtyCol < 0) throw new HttpError(400, 'В документе нет колонки «Конечный остаток» — это не ведомость по товарам');
  if (labelCol < 0) throw new HttpError(400, 'В шапке документа нет строк «Номенклатура…» — не понять, где товар');

  // Строки товаров. Один товар — столько подряд строк, сколько уровней
  // группировки, и у всех одинаковые числа. Строка группы (склад, итог) —
  // с суммой по группе, её числа с соседней строкой не совпадают: пропускаем.
  const signature = (r) => JSON.stringify(r.slice(labelCol + 1).map(num));
  const candidates = rows.slice(headerEnd + 1)
    .filter((r) => text(r[labelCol]) && !/^итог/i.test(text(r[labelCol])));
  const noSpaces = (v) => !/\s/.test(text(v));
  const records = [];
  for (let i = 0; i + levels.length <= candidates.length;) {
    const window = candidates.slice(i, i + levels.length);
    const same = window.every((r) => signature(r) === signature(window[0]));
    const shaped = window.every((r, k) => levels[k] === 'name' || noSpaces(r[labelCol]));
    if (!same || !shaped) { i += 1; continue; }
    const rec = { article: null, code: null, name: null };
    window.forEach((r, k) => { rec[levels[k]] = text(r[labelCol]); });
    // «…, шт» — единица измерения, которую 1С дописывает к названию.
    if (rec.name) rec.name = rec.name.replace(/,\s*(шт|кг|г|л|м|упак|уп)\.?$/i, '');
    rec.qty = Math.max(0, num(window[0][qtyCol]) || 0);
    rec.barcode = barcodeOf(rec.name);
    records.push(rec);
    i += levels.length;
  }
  if (!records.length) throw new HttpError(400, 'В документе не нашлось ни одного товара');
  return records;
}

// Найти карточку товара по строке документа: по коду 1С, по штрихкоду из
// названия, по названию. Свою карточку продавца — первой.
async function findProduct(client, warehouseId, companyId, rec) {
  const pick = (rows) => rows.find((p) => p.company_id === companyId) || (rows.length === 1 ? rows[0] : null)
    || rows.find((p) => p.external_id) || null;
  if (rec.code) {
    const r = await client.query(
      `SELECT id, sku, name, company_id, external_id, active FROM products
        WHERE warehouse_id = $1 AND upper(sku) = upper($2)`, [warehouseId, rec.code]);
    if (r.rows.length) return { rows: r.rows, product: pick(r.rows), by: 'код' };
  }
  if (rec.barcode) {
    const r = await client.query(
      `SELECT id, sku, name, company_id, external_id, active FROM products
        WHERE warehouse_id = $1
          AND (btrim(barcode) = $2 OR substring(name from '([0-9]{8,14})[[:space:]]*$') = $2)`,
      [warehouseId, rec.barcode]);
    if (r.rows.length) return { rows: r.rows, product: pick(r.rows), by: 'штрихкод' };
  }
  if (rec.name) {
    const r = await client.query(
      `SELECT id, sku, name, company_id, external_id, active FROM products
        WHERE warehouse_id = $1 AND lower(btrim(name)) = lower($2)`, [warehouseId, rec.name]);
    if (r.rows.length) return { rows: r.rows, product: pick(r.rows), by: 'название' };
  }
  return { rows: [], product: null, by: null };
}

async function cellsOf(client, companyId, sku) {
  return (await client.query(
    `SELECT cs.id, cs.cell_block_id, cs.qty, wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
       FROM cell_stock cs
       JOIN cell_blocks cb ON cb.id = cs.cell_block_id
       JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
      WHERE cs.company_id = $1 AND cs.sku = $2 AND cs.quality = 'good' AND cs.qty > 0
      ORDER BY cs.qty DESC, cs.id FOR UPDATE OF cs`,
    [companyId, sku],
  )).rows;
}

// placeNew — товар, которого нет ни в одной ячейке, класть в свободную ячейку
// по подсказке. По умолчанию нет: у продавца, чей товар ещё не разложен по
// ячейкам Аргуса, выдуманный адрес отправит грузчика к пустой полке.
async function run(client, warehouseId, {
  companyId, grid, apply = false, source = 'документ', placeNew = false,
}, actor = {}) {
  if (!companyId) throw new HttpError(400, 'Выберите продавца');
  const company = (await client.query(
    'SELECT id, name FROM companies WHERE id = $1 AND warehouse_id = $2 AND archived_at IS NULL',
    [companyId, warehouseId],
  )).rows[0];
  if (!company) throw new HttpError(404, 'Продавец не найден');
  const records = parseStockSheet(grid);

  // Собранное, но не уехавшее уже снято с полки, а документ 1С его ещё
  // числит (реализация проводится при отгрузке). Для ячеек цель — документ
  // минус собранное: иначе штуки задвоятся.
  const stagedBySku = new Map((await client.query(
    `SELECT ii.sku, SUM(sr.picked_qty)::numeric AS qty FROM shipping_records sr
       JOIN invoice_items ii ON ii.id = sr.invoice_item_id
       JOIN invoices i ON i.id = ii.invoice_id
      WHERE sr.company_id = $1 AND i.status <> 'shipped' AND i.mp_stock_returned_at IS NULL
      GROUP BY ii.sku`, [companyId])).rows.map((r) => [r.sku, Number(r.qty)]));

  // Кладовщик и обмен 1С тянут за собой много модулей — берём, когда нужны.
  const kladovshchik = require('../agents/kladovshchik');
  const mapping = require('../marketplaces/mapping');
  const { claimProductOwnership } = require('../sync/service');

  const lines = [];
  const usedCells = new Set();
  const touched = new Set();
  let added = 0;
  let removed = 0;
  for (const rec of records) {
    const found = await findProduct(client, warehouseId, companyId, rec);
    const line = { ...rec, sku: null, productName: null, by: found.by, owner: null, inCells: 0, change: 0, note: null };
    lines.push(line);
    if (!found.product) { line.note = 'нет в каталоге Аргуса — придёт с обменом 1С'; continue; }
    let product = found.product;
    line.sku = product.sku;
    line.productName = product.name;
    line.owner = product.company_id === companyId ? 'свой' : product.company_id ? 'другой' : 'без продавца';

    if (apply && (product.company_id !== companyId || found.rows.some((p) => p.company_id !== companyId && p.external_id))) {
      // Карточка из обмена 1С — у архива или без владельца — переходит к
      // продавцу, сливаясь с его копией, если она есть.
      const linked = found.rows.find((p) => p.external_id) || product;
      const claim = await claimProductOwnership(client, warehouseId, companyId,
        { productExternalId: linked.external_id || undefined, sku: linked.sku });
      if (claim.status === 'conflict' || claim.status === 'missing') {
        line.note = 'товар принадлежит другому продавцу — не тронут';
        continue;
      }
      product = (await client.query('SELECT id, sku, name, company_id, active FROM products WHERE id = $1',
        [claim.productId])).rows[0];
      line.owner = 'привязан';
    } else if (product.company_id && product.company_id !== companyId) {
      line.note = 'сейчас у другого продавца — при записи будет проверено';
    }
    if (apply && !product.active) {
      await client.query('UPDATE products SET active = true, updated_at = now() WHERE id = $1', [product.id]);
    }
    // Артикул документа — артикул продавца на WB: связь заводится сама.
    if (apply && rec.article && rec.article.toUpperCase() !== product.sku.toUpperCase()) {
      await mapping.save(client, warehouseId, {
        companyId, marketplace: 'wb', sku: product.sku, mpArticle: rec.article, mpBarcode: rec.barcode || null,
      }).catch(() => null);
    }

    const cells = await cellsOf(client, companyId, product.sku);
    const current = cells.reduce((sum, c) => sum + Number(c.qty), 0);
    const staged = stagedBySku.get(product.sku) || 0;
    const target = Math.max(0, rec.qty - staged);
    line.inCells = current;
    line.staged = staged;
    line.change = target - current;
    if (line.change === 0) continue;
    const label = (c) => formatBlockLabel(c.row_num, c);
    if (line.change > 0) {
      if (cells.length) {
        line.note = `+${line.change} в ${label(cells[0])}`;
        if (apply) {
          await client.query('UPDATE cell_stock SET qty = qty + $2, updated_at = now() WHERE id = $1', [cells[0].id, line.change]);
          touched.add(cells[0].cell_block_id);
        }
      } else if (!placeNew) {
        line.note = 'нет ни в одной ячейке — не тронуто: разложите приёмкой или загрузкой по ячейкам';
        line.change = 0;
        continue;
      } else {
        const options = await kladovshchik.suggestCells(client, warehouseId, product.sku, companyId, 20);
        const place = options.find((o) => !usedCells.has(o.blockId));
        if (!place) { line.note = 'нет свободной ячейки'; continue; }
        usedCells.add(place.blockId);
        line.note = `${target} шт. в свободную ${place.label} — проверьте на полке`;
        if (apply) {
          await client.query(
            `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty) VALUES ($1, $2, $3, $4, $5)`,
            [place.blockId, warehouseId, companyId, product.sku, target]);
          touched.add(place.blockId);
        }
      }
      added += line.change;
    } else {
      let left = -line.change;
      const from = [];
      for (const c of cells) {
        if (!left) break;
        const take = Math.min(left, Number(c.qty));
        from.push(`${label(c)} −${take}`);
        if (apply) {
          if (take === Number(c.qty)) await client.query('DELETE FROM cell_stock WHERE id = $1', [c.id]);
          else await client.query('UPDATE cell_stock SET qty = qty - $2, updated_at = now() WHERE id = $1', [c.id, take]);
          touched.add(c.cell_block_id);
        }
        left -= take;
      }
      line.note = from.join(', ');
      removed += -line.change;
    }
    if (apply) {
      await client.query(
        `INSERT INTO stock_operations (warehouse_id, company_id, kind, sku, qty, details)
         VALUES ($1, $2, 'document_align', $3, $4, $5)`,
        [warehouseId, companyId, product.sku, Math.abs(line.change),
          JSON.stringify({ source, before: current, after: target, document: rec.qty, staged })]);
    }
  }

  const summary = {
    company: company.name,
    records: records.length,
    documentTotal: records.reduce((s, r) => s + r.qty, 0),
    cellsTotal: lines.reduce((s, l) => s + l.inCells, 0),
    changed: lines.filter((l) => l.change !== 0 && l.sku).length,
    added,
    removed,
    notFound: lines.filter((l) => !l.sku).length,
  };
  if (apply) {
    for (const cell of touched) await refreshCellFill(client, cell);
    await journal.createEntry(client, {
      warehouseId, agent: 'Кладовщик',
      actionText: `Остатки «${company.name}» сверены с документом «${source}»: товаров ${records.length}, `
        + `изменено ${summary.changed} (+${added} / −${removed} шт.), не найдено в каталоге ${summary.notFound}. В 1С ничего не отправлялось.`,
      entityType: 'company', entityId: companyId,
      actorType: actor.type || 'owner', actorId: actor.id || null,
    });
  }
  return { applied: apply, summary, lines };
}

module.exports = { parseStockSheet, run };
