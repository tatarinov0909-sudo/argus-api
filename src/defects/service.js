// Склад брака продавца (владелец 02.10.2026).
//
// Остаток склада брака — строки cell_stock с состоянием «брак» или «брак
// упаковки»: брак физически лежит в ячейках, как и раньше. Этот модуль — всё,
// что вокруг остатка:
// - перемещение на склад брака (defect_moves): документ с номером на каждый
//   найденный брак — откуда, сколько, описание, фото;
// - решение по браку (defect_decisions): продавец или склад за него решает,
//   что делать с N штуками; пока склад не выполнил — это задание грузчику;
// - выполнение решения: брак уходит со склада брака — к продавцу, в
//   утилизацию, обратно в продажу или в продажу отдельным товаром «уценка».
const { HttpError } = require('../middleware/errorHandler');
const { requireQty } = require('../middleware/qty');
const journal = require('../journal/repository');
const { takeFromCell } = require('../cells/move');
const { refreshCellFill } = require('../cells/fill');
const { blockLabelSql } = require('../cells/label');
const { zoneOf, todayIn } = require('../warehouses/time');

const BUCKETS = { defective: 'брак', packaging_defect: 'брак упаковки' };
const ACTIONS = {
  return_to_seller: 'вернуть продавцу',
  dispose: 'утилизировать',
  repack: 'перепаковать и вернуть в продажу',
  markdown: 'продавать уценкой отдельным товаром',
};
const SOURCES = {
  return: 'возврат', receiving: 'приёмка', picking: 'сборка', move: 'перекладка',
  inventory: 'пересчёт ячейки', initial_load: 'загрузка остатков',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const cleanNote = (v) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, 300) : null);

function requireBucket(bucket) {
  if (!BUCKETS[bucket]) throw new HttpError(400, 'Вид брака — «брак» или «брак упаковки»');
  return bucket;
}

// Номер документа: ПРЕФИКС-ДДММГГ-N, день — по поясу склада, под замком
// склада (два грузчика отмечают брак одновременно).
async function nextNumber(client, warehouseId, prefix, table) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2))", [`defect-number-${prefix}`, warehouseId]);
  const [y, m, d] = todayIn(await zoneOf(client, warehouseId)).split('-');
  const head = `${prefix}-${d}${m}${y.slice(2)}-`;
  const last = (await client.query(
    `SELECT number FROM ${table} WHERE warehouse_id = $1 AND number LIKE $2`, [warehouseId, `${head}%`],
  )).rows.map((r) => Number(r.number.slice(head.length)) || 0);
  return head + (Math.max(0, ...last) + 1);
}

async function productName(client, companyId, sku) {
  const r = (await client.query(
    'SELECT name FROM products WHERE company_id = $1 AND sku = $2 ORDER BY active DESC LIMIT 1', [companyId, sku])).rows[0];
  return r ? r.name : sku;
}

async function staffName(client, staffKeyId) {
  if (!staffKeyId) return null;
  const r = (await client.query('SELECT name FROM staff_keys WHERE id = $1', [staffKeyId])).rows[0];
  return r ? r.name : null;
}

async function cellLabel(client, warehouseId, cellBlockId) {
  if (!UUID.test(String(cellBlockId || ''))) throw new HttpError(404, 'Ячейка не найдена');
  const r = (await client.query(
    `SELECT ${blockLabelSql('cb', 'wr')} AS label FROM cell_blocks cb JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
      WHERE cb.id = $1 AND cb.warehouse_id = $2`, [cellBlockId, warehouseId])).rows[0];
  if (!r) throw new HttpError(404, 'Ячейка не найдена');
  return r.label;
}

// Документ «Перемещение на склад брака». Остаток двигает вызывающий (сам
// брак кладёт в ячейку тот, кто его нашёл), здесь — запись и журнал.
// silent — без записи в журнал (загрузка остатков пишет свою одну).
async function createMove(client, {
  warehouseId, companyId, sku, qty, bucket, note = null, source, invoiceId = null, supplyId = null,
  cellBlockId = null, batch = null, staffKeyId = null, silent = false, vw = null,
}) {
  requireBucket(bucket);
  if (!SOURCES[source]) throw new HttpError(400, 'Неизвестно, откуда брак');
  const amount = requireQty(qty, 'Количество брака', { min: 1 });
  const name = await productName(client, companyId, sku);
  const who = await staffName(client, staffKeyId);
  const number = await nextNumber(client, warehouseId, 'БР', 'defect_moves');
  const row = (await client.query(
    `INSERT INTO defect_moves (warehouse_id, company_id, number, sku, name, qty, bucket, note, source,
                               invoice_id, supply_id, cell_block_id, batch, created_by, created_by_name, virtual_warehouse_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING id, number, created_at`,
    [warehouseId, companyId, number, sku, name, amount, bucket, cleanNote(note), source,
      invoiceId, supplyId, cellBlockId, batch, staffKeyId, who, vw || null],
  )).rows[0];
  if (!silent) {
    const where = cellBlockId ? ` в ячейку ${await cellLabel(client, warehouseId, cellBlockId)}` : '';
    await journal.createEntry(client, {
      warehouseId, agent: 'Кладовщик', status: 'auto',
      actionText: `Перемещение на склад брака ${number}: «${name}», ${amount} шт. — ${BUCKETS[bucket]}`
        + ` (${SOURCES[source]})${where}.` + (cleanNote(note) ? ` Дефект: ${cleanNote(note)}` : ''),
      entityType: 'defect_move', entityId: row.id, invoiceId, cellBlockId,
      actorType: staffKeyId ? 'worker' : 'owner', actorId: staffKeyId,
    });
  }
  return { id: row.id, number, name, qty: amount, bucket, createdAt: row.created_at };
}

// Брак, найденный на полке среди годного (сборка, перекладка): снять годное
// с ячейки и положить браком в ячейку брака — одной операцией, количество не
// появляется и не исчезает.
async function markFromShelf(client, {
  warehouseId, companyId, sku, fromCellBlockId, toCellBlockId, qty, bucket, note, source, supplyId = null,
  invoiceId = null, staffKeyId,
  // Виртуальный склад годного, которое отмечаем браком: undefined — любой
  // (снятые строки несут свой склад), null — «Основной».
  vw,
}) {
  requireBucket(bucket);
  const amount = requireQty(qty, 'Количество брака', { min: 1 });
  const fromLabel = await cellLabel(client, warehouseId, fromCellBlockId);
  const target = toCellBlockId || fromCellBlockId;
  await cellLabel(client, warehouseId, target);
  // Склад не назван, а в ячейке годное разных складов продавца — с какого
  // склада брак, решено по правилу; это спорная ситуация (владелец 02.10.2026).
  const had = vw !== undefined ? [] : (await client.query(
    `SELECT virtual_warehouse_id AS vw, SUM(qty)::int AS qty FROM cell_stock
      WHERE cell_block_id = $1 AND company_id = $2 AND sku = $3 AND quality = 'good' AND qty > 0
      GROUP BY virtual_warehouse_id`, [fromCellBlockId, companyId, sku])).rows;
  // Только годное этого продавца: takeFromCell ограничен продавцом.
  const parts = await takeFromCell(client, warehouseId, {
    cellBlockId: fromCellBlockId, sku, companyId, quality: 'good', qty: amount, verb: 'отметить браком', vw,
  });
  for (const part of parts) {
    await client.query(
      `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty, quality, virtual_warehouse_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`, [target, warehouseId, companyId, sku, part.qty, bucket, part.vw]);
  }
  await client.query(
    `INSERT INTO stock_operations (warehouse_id, company_id, kind, sku, qty, from_cell_block_id, to_cell_block_id, details, worker_key_id)
     VALUES ($1, $2, 'defect_in', $3, $4, $5, $6, $7::jsonb, $8)`,
    [warehouseId, companyId, sku, amount, fromCellBlockId, target,
      JSON.stringify({ fromQuality: 'good', toQuality: bucket, source }), staffKeyId || null]);
  await refreshCellFill(client, fromCellBlockId);
  if (target !== fromCellBlockId) await refreshCellFill(client, target);
  // Один документ на склад: брак разных складов — разные решения продавца.
  const moves = [];
  for (const part of parts) {
    moves.push(await createMove(client, {
      warehouseId, companyId, sku, qty: part.qty, bucket, note, source, supplyId, invoiceId,
      cellBlockId: target, staffKeyId, vw: part.vw,
    }));
  }
  if (had.length > 1) {
    const taken = (v) => parts.filter((p) => (p.vw || null) === (v || null)).reduce((n, p) => n + p.qty, 0);
    const name = await productName(client, companyId, sku);
    // Позднее подключение: склады продавца сами берут номера документов отсюда.
    await require('../vwarehouses/service').splitSituation(client, {
      warehouseId, companyId, kind: 'defect', sku, name, quality: bucket,
      title: `Брак ${amount} шт. «${name}» в ячейке ${fromLabel}`,
      parts: had.map((h) => ({ vw: h.vw, before: h.qty, value: taken(h.vw), min: 0, max: Math.min(h.qty, amount) })),
    });
  }
  return moves.length === 1 ? moves[0] : { ...moves[0], qty: amount, moves };
}

// Куда класть брак: сначала ячейки, где уже лежит брак этого продавца, потом
// отмеченные руководителем ячейки брака, потом пустые.
async function suggestCells(client, warehouseId, companyId, limit = 6) {
  const rows = (await client.query(
    `WITH own AS (
       SELECT cs.cell_block_id AS id, 1 AS rank, 'здесь уже брак этого продавца' AS reason
         FROM cell_stock cs WHERE cs.warehouse_id = $1 AND cs.company_id = $2 AND cs.quality <> 'good' AND cs.qty > 0
        GROUP BY cs.cell_block_id),
     zone AS (
       SELECT cb.id, 2, 'ячейка брака' FROM cell_blocks cb WHERE cb.warehouse_id = $1 AND cb.defect_zone),
     empty AS (
       SELECT cb.id, 3, 'свободная ячейка' FROM cell_blocks cb
        WHERE cb.warehouse_id = $1 AND NOT EXISTS (SELECT 1 FROM cell_stock cs WHERE cs.cell_block_id = cb.id AND cs.qty > 0)),
     pick AS (
       SELECT DISTINCT ON (x.id) x.id, x.rank, x.reason FROM (SELECT * FROM own UNION ALL SELECT * FROM zone UNION ALL SELECT * FROM empty) x
        ORDER BY x.id, x.rank)
     SELECT p.id, p.reason, ${blockLabelSql('cb', 'wr')} AS label
       FROM pick p JOIN cell_blocks cb ON cb.id = p.id JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
      ORDER BY p.rank, wr.row_num, cb.rack_start, cb.tier_start
      LIMIT $3`, [warehouseId, companyId, limit])).rows;
  return rows.map((r) => ({ cellBlockId: r.id, label: r.label, reason: r.reason }));
}

// Склад брака продавца: что лежит (по товару и виду брака), сколько уже
// решено, сколько ждёт решения и с какого времени.
async function balances(client, companyId) {
  const onHand = (await client.query(
    `SELECT cs.sku, cs.quality AS bucket, SUM(cs.qty)::int AS qty, COALESCE(MAX(p.name), cs.sku) AS name
       FROM cell_stock cs LEFT JOIN products p ON p.company_id = cs.company_id AND p.sku = cs.sku
      WHERE cs.company_id = $1 AND cs.quality <> 'good' AND cs.qty > 0
      GROUP BY cs.sku, cs.quality`, [companyId])).rows;
  const pending = (await client.query(
    `SELECT sku, bucket, SUM(qty)::int AS qty FROM defect_decisions
      WHERE company_id = $1 AND status = 'pending' GROUP BY sku, bucket`, [companyId])).rows;
  const since = (await client.query(
    `SELECT sku, bucket, MIN(created_at) AS at FROM defect_moves WHERE company_id = $1 GROUP BY sku, bucket`,
    [companyId])).rows;
  const key = (r) => `${r.sku}\u0000${r.bucket}`;
  const pend = new Map(pending.map((r) => [key(r), r.qty]));
  const first = new Map(since.map((r) => [key(r), r.at]));
  return onHand.map((r) => {
    const decided = Math.min(r.qty, pend.get(key(r)) || 0);
    return {
      sku: r.sku, name: r.name, bucket: r.bucket, qty: r.qty,
      decided, undecided: r.qty - decided, since: first.get(key(r)) || null,
    };
  }).sort((a, b) => b.undecided - a.undecided || a.name.localeCompare(b.name, 'ru'));
}

// Решение по браку. actor — { role: 'seller'|'owner'|'manager', id, name }.
async function decide(client, {
  warehouseId, companyId, sku, bucket, qty, action, markdownBarcode, note, actor,
}) {
  requireBucket(bucket);
  if (!ACTIONS[action]) throw new HttpError(400, 'Решение — вернуть, утилизировать, перепаковать или уценка');
  const amount = requireQty(qty, 'Сколько штук', { min: 1 });
  let barcode = null;
  if (action === 'markdown') {
    barcode = typeof markdownBarcode === 'string' ? markdownBarcode.replace(/\s+/g, '') : '';
    if (!/^[0-9A-Za-z-]{4,64}$/.test(barcode)) {
      throw new HttpError(400, 'Для уценки впишите штрихкод уценённой карточки на WB — цифры, от 4 знаков');
    }
  }
  // Решения по одному продавцу — по очереди: два решения сразу не должны
  // вдвоём раздать больше брака, чем лежит.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('defect-decide:' || $1))", [companyId]);
  const row = (await balances(client, companyId)).find((b) => b.sku === sku && b.bucket === bucket);
  if (!row || row.undecided <= 0) throw new HttpError(409, 'По этому браку решать уже нечего');
  if (amount > row.undecided) {
    throw new HttpError(409, `Ждёт решения ${row.undecided} шт. — решить больше нельзя`);
  }
  const number = await nextNumber(client, warehouseId, 'РБ', 'defect_decisions');
  const byWarehouse = actor.role !== 'seller';
  const inserted = (await client.query(
    `INSERT INTO defect_decisions (warehouse_id, company_id, number, sku, name, bucket, qty, action,
                                   markdown_barcode, note, decided_role, decided_by, decided_name, seller_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id, number, decided_at`,
    [warehouseId, companyId, number, sku, row.name, bucket, amount, action, barcode, cleanNote(note),
      actor.role, actor.id || null, actor.name || null, byWarehouse ? null : new Date()],
  )).rows[0];
  const company = (await client.query('SELECT name FROM companies WHERE id = $1', [companyId])).rows[0];
  await journal.createEntry(client, {
    warehouseId, agent: 'Кладовщик', status: 'auto',
    actionText: `${byWarehouse ? `${actor.name || 'Склад'} решил за продавца «${company.name}»` : `Продавец «${company.name}» решил`}`
      + ` по браку ${number}: «${row.name}», ${amount} шт. (${BUCKETS[bucket]}) — ${ACTIONS[action]}`
      + (barcode ? `, штрихкод уценки ${barcode}` : '') + '.'
      + (cleanNote(note) ? ` Комментарий: ${cleanNote(note)}` : '') + ' Задание грузчику создано.',
    entityType: 'defect_decision', entityId: inserted.id,
    actorType: actor.role, actorId: actor.id || null,
  });
  return { id: inserted.id, number, decidedAt: inserted.decided_at };
}

// Где лежит брак этого товара — для задания грузчику (сначала самый давний).
async function defectCells(client, warehouseId, companyId, sku, bucket) {
  return (await client.query(
    `SELECT cs.cell_block_id AS id, SUM(cs.qty)::int AS qty, MIN(cs.updated_at) AS oldest, ${blockLabelSql('cb', 'wr')} AS label
       FROM cell_stock cs JOIN cell_blocks cb ON cb.id = cs.cell_block_id JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
      WHERE cs.warehouse_id = $1 AND cs.company_id = $2 AND cs.sku = $3 AND cs.quality = $4 AND cs.qty > 0
      GROUP BY cs.cell_block_id, cb.id, wr.id
      ORDER BY MIN(cs.updated_at)`, [warehouseId, companyId, sku, bucket])).rows
    .map((r) => ({ cellBlockId: r.id, label: r.label, qty: r.qty }));
}

// Задания грузчику: решения, которые склад ещё не выполнил.
async function tasks(client, warehouseId) {
  const rows = (await client.query(
    `SELECT d.id, d.number, d.company_id, c.name AS company, d.sku, d.name, d.bucket, d.qty, d.action,
            d.markdown_barcode, d.note, d.decided_role, d.decided_name, d.decided_at
       FROM defect_decisions d JOIN companies c ON c.id = d.company_id AND c.archived_at IS NULL
      WHERE d.warehouse_id = $1 AND d.status = 'pending'
      ORDER BY d.decided_at`, [warehouseId])).rows;
  const out = [];
  for (const r of rows) {
    out.push({
      id: r.id, number: r.number, companyId: r.company_id, company: r.company, sku: r.sku, name: r.name,
      bucket: r.bucket, qty: Number(r.qty), action: r.action, markdownBarcode: r.markdown_barcode, note: r.note,
      decidedRole: r.decided_role, decidedName: r.decided_name, decidedAt: r.decided_at,
      cells: await defectCells(client, warehouseId, r.company_id, r.sku, r.bucket),
    });
  }
  return out;
}

// Товар «уценка»: отдельная карточка продавца со штрихкодом уценённой
// карточки WB. Если у продавца уже есть товар с этим штрихкодом — он.
async function markdownProduct(client, warehouseId, companyId, decision) {
  const found = (await client.query(
    `SELECT sku FROM products WHERE warehouse_id = $1 AND company_id = $2 AND btrim(barcode) = $3 ORDER BY active DESC LIMIT 1`,
    [warehouseId, companyId, decision.markdown_barcode])).rows[0];
  if (found) return found.sku;
  const sku = `УЦ-${decision.markdown_barcode}`.slice(0, 100);
  await client.query(
    `INSERT INTO products (warehouse_id, company_id, sku, name, barcode) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (warehouse_id, company_id, sku) DO NOTHING`,
    [warehouseId, companyId, sku, `${decision.name || decision.sku} — уценка`.slice(0, 300), decision.markdown_barcode]);
  return sku;
}

// Выполнить решение: снять брак со склада брака (из ячеек, начиная с самого
// давнего) и сделать с ним то, что решили. cellBlockId — куда положить товар,
// который возвращается в продажу (перепаковка, уценка).
async function execute(client, { warehouseId, decisionId, staffKeyId, cellBlockId }) {
  if (!UUID.test(String(decisionId || ''))) throw new HttpError(404, 'Задание не найдено');
  const d = (await client.query(
    `SELECT d.*, c.name AS company FROM defect_decisions d JOIN companies c ON c.id = d.company_id
      WHERE d.id = $1 AND d.warehouse_id = $2 FOR UPDATE OF d`, [decisionId, warehouseId])).rows[0];
  if (!d) throw new HttpError(404, 'Задание не найдено');
  if (d.status !== 'pending') throw new HttpError(409, `Задание ${d.number} уже выполнено`);
  const backToSale = d.action === 'repack' || d.action === 'markdown';
  let target = null;
  if (backToSale) {
    if (!cellBlockId) throw new HttpError(400, 'Укажите ячейку, куда кладёте товар для продажи');
    target = await cellLabel(client, warehouseId, cellBlockId);
  }
  const qty = Number(d.qty);
  const cells = await defectCells(client, warehouseId, d.company_id, d.sku, d.bucket);
  const have = cells.reduce((s, c) => s + c.qty, 0);
  if (have < qty) {
    throw new HttpError(409, `На складе брака ${have} шт. «${d.name}», а в задании ${qty} — пересчитайте ячейки брака`);
  }
  let left = qty;
  const took = [];
  const byVw = new Map();
  for (const c of cells) {
    if (left <= 0) break;
    const n = Math.min(left, c.qty);
    const parts = await takeFromCell(client, warehouseId, {
      cellBlockId: c.cellBlockId, sku: d.sku, companyId: d.company_id, quality: d.bucket, qty: n, verb: 'взять',
    });
    for (const part of parts) byVw.set(part.vw || '', (byVw.get(part.vw || '') || 0) + part.qty);
    took.push({ cellBlockId: c.cellBlockId, label: c.label, qty: n });
    left -= n;
  }
  let toSku = null;
  if (backToSale) {
    toSku = d.action === 'markdown' ? await markdownProduct(client, warehouseId, d.company_id, d) : d.sku;
    for (const [vwKey, n] of byVw) {
      await client.query(
        `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty, quality, virtual_warehouse_id)
         VALUES ($1, $2, $3, $4, $5, 'good', $6)`, [cellBlockId, warehouseId, d.company_id, toSku, n, vwKey || null]);
    }
  }
  for (const t of took) {
    await client.query(
      `INSERT INTO stock_operations (warehouse_id, company_id, kind, sku, qty, from_cell_block_id, to_cell_block_id, details, worker_key_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [warehouseId, d.company_id, `defect_${d.action}`, d.sku, t.qty, t.cellBlockId, backToSale ? cellBlockId : null,
        JSON.stringify({ decision: d.number, fromQuality: d.bucket, toQuality: backToSale ? 'good' : null, toSku }), staffKeyId || null]);
    await refreshCellFill(client, t.cellBlockId);
  }
  if (backToSale) await refreshCellFill(client, cellBlockId);
  const who = await staffName(client, staffKeyId);
  await client.query(
    `UPDATE defect_decisions SET status = 'done', done_by = $2, done_name = $3, done_at = now(),
            done_cell_block_id = $4, done_cells = $5::jsonb, markdown_sku = COALESCE($6, markdown_sku)
      WHERE id = $1`,
    [d.id, staffKeyId || null, who, backToSale ? cellBlockId : null, JSON.stringify(took),
      d.action === 'markdown' ? toSku : null]);
  const from = took.map((t) => `${t.label} — ${t.qty} шт.`).join(', ');
  const what = {
    return_to_seller: 'выдал продавцу (акт выдачи брака)',
    dispose: 'утилизировал (акт утилизации)',
    repack: `перепаковал и положил в продажу в ячейку ${target}`,
    markdown: `переклеил на уценку (штрихкод ${d.markdown_barcode}) и положил в продажу в ячейку ${target}`,
  }[d.action];
  await journal.createEntry(client, {
    warehouseId, agent: 'Кладовщик', status: 'auto',
    actionText: `Выполнено решение по браку ${d.number} продавца «${d.company}»: «${d.name}», ${qty} шт. — ${what}. Взято из ${from}.`,
    entityType: 'defect_decision', entityId: d.id, cellBlockId: backToSale ? cellBlockId : took[0].cellBlockId,
    actorType: 'worker', actorId: staffKeyId || null,
  });
  return { id: d.id, number: d.number, action: d.action, qty, took, toSku };
}

// Сколько брака у каждого продавца ещё никто не решил и с какого времени
// (самый давний документ брака). olderThanDays — только брак, лежащий дольше
// (напоминание руководителю через неделю).
async function waitingBySeller(client, warehouseId, { olderThanDays = 0 } = {}) {
  const r = await client.query(
    `WITH stock AS (
       SELECT cs.company_id, cs.sku, cs.quality::text AS bucket, SUM(cs.qty) AS qty
         FROM cell_stock cs WHERE cs.warehouse_id = $1 AND cs.quality <> 'good' AND cs.qty > 0
        GROUP BY cs.company_id, cs.sku, cs.quality),
     pending AS (
       SELECT company_id, sku, bucket, SUM(qty) AS qty FROM defect_decisions
        WHERE warehouse_id = $1 AND status = 'pending' GROUP BY company_id, sku, bucket),
     waiting AS (
       SELECT s.company_id, GREATEST(s.qty - COALESCE(p.qty, 0), 0) AS qty,
              (SELECT MIN(m.created_at) FROM defect_moves m
                WHERE m.company_id = s.company_id AND m.sku = s.sku AND m.bucket = s.bucket) AS since
         FROM stock s LEFT JOIN pending p ON p.company_id = s.company_id AND p.sku = s.sku AND p.bucket = s.bucket)
     SELECT w.company_id, c.name, SUM(w.qty)::int AS qty, MIN(w.since) AS since
       FROM waiting w JOIN companies c ON c.id = w.company_id AND c.archived_at IS NULL
      WHERE w.qty > 0 AND ($2::int = 0 OR w.since < now() - ($2 || ' days')::interval)
      GROUP BY w.company_id, c.name
      ORDER BY MIN(w.since) NULLS LAST`,
    [warehouseId, olderThanDays],
  );
  return r.rows.map((x) => ({ companyId: x.company_id, seller: x.name, qty: x.qty, since: x.since }));
}

module.exports = {
  BUCKETS, ACTIONS, SOURCES, requireBucket, cleanNote, createMove, markFromShelf, suggestCells,
  balances, decide, tasks, execute, cellLabel, defectCells, waitingBySeller,
  nextNumber, productName, staffName,
};
