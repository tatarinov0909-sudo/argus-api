// «Хранить отдельно» и закреплённые зоны складов продавца (владелец
// 02.10.2026, этап 3; argus-product/docs/Виртуальные склады — схема.md).
//
// Галочка «хранить отдельно»: товар такого склада никогда не лежит в одной
// ячейке с товаром других складов того же продавца. Вторая галочка — то же
// для брака. Зона — ячейки, закреплённые за складом: ничего другого туда не
// кладут; пока в зоне есть пустая ячейка — кладут туда, заполнена — рядом,
// руководителю уведомление. Перенос на такой склад и разделение уже
// смешанного — задания грузчику «переложить»: каждая переложенная штука
// сразу переходит куда нужно.
const { HttpError } = require('../middleware/errorHandler');
const { requireQty } = require('../middleware/qty');
const { formatBlockLabel, blockLabelSql } = require('../cells/label');
const { refreshCellFill } = require('../cells/fill');
const { takeFromCell } = require('../cells/move');
const journal = require('../journal/repository');

const MAIN_NAME = 'Остальной товар';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isGood = (quality) => (quality || 'good') === 'good';

// Склады продавца и их зоны — одним заходом на проверку.
async function layout(client, companyId) {
  const vws = (await client.query(
    `SELECT id, name, marketplace, keep_separate, defect_separate FROM virtual_warehouses
      WHERE company_id = $1 AND archived_at IS NULL`, [companyId])).rows;
  const zones = (await client.query(
    `SELECT cb.id, cb.reserved_vw_id FROM cell_blocks cb JOIN virtual_warehouses v ON v.id = cb.reserved_vw_id
      WHERE v.company_id = $1 AND v.archived_at IS NULL`, [companyId])).rows;
  const byId = new Map(vws.map((v) => [v.id, v]));
  const zone = new Map();
  for (const z of zones) {
    if (!zone.has(z.reserved_vw_id)) zone.set(z.reserved_vw_id, new Set());
    zone.get(z.reserved_vw_id).add(z.id);
  }
  return {
    vws, byId, zone,
    name: (vw) => (vw ? (byId.get(vw) || {}).name || 'склад' : MAIN_NAME),
    // Хранится ли товар склада отдельно в этом состоянии (годное / брак).
    separate: (vw, quality) => {
      const v = vw && byId.get(vw);
      return !!v && v.keep_separate && (isGood(quality) || v.defect_separate);
    },
    any: vws.some((v) => v.keep_separate) || zones.length > 0,
  };
}

// Почему класть сюда нельзя (или null — можно).
async function conflict(client, { cellBlockId, companyId, vw = null, quality = 'good' }, lay = null) {
  const cell = (await client.query(
    `SELECT cb.reserved_vw_id, v.company_id AS reserved_company, v.name AS reserved_name, c.name AS reserved_seller
       FROM cell_blocks cb
       LEFT JOIN virtual_warehouses v ON v.id = cb.reserved_vw_id AND v.archived_at IS NULL
       LEFT JOIN companies c ON c.id = v.company_id
      WHERE cb.id = $1`, [cellBlockId])).rows[0];
  if (!cell) return null;
  if (cell.reserved_company && (cell.reserved_company !== companyId || (vw || null) !== cell.reserved_vw_id)) {
    return `ячейка закреплена за складом «${cell.reserved_name}» продавца «${cell.reserved_seller}» — другой товар туда не кладут`;
  }
  if (!companyId) return null;
  const l = lay || await layout(client, companyId);
  if (!l.vws.some((v) => v.keep_separate)) return null;
  const present = (await client.query(
    `SELECT DISTINCT virtual_warehouse_id AS vw FROM cell_stock
      WHERE cell_block_id = $1 AND company_id = $2 AND qty > 0 AND (quality = 'good') = $3`,
    [cellBlockId, companyId, isGood(quality)])).rows.map((r) => r.vw || null);
  for (const w of present) {
    if (w === (vw || null)) continue;
    if (l.separate(vw, quality)) return `здесь лежит товар склада «${l.name(w)}», а склад «${l.name(vw)}» хранится отдельно`;
    if (l.separate(w, quality)) return `здесь лежит товар склада «${l.name(w)}» — он хранится отдельно`;
  }
  return null;
}

async function labelOf(client, cellBlockId) {
  const r = (await client.query(
    `SELECT ${blockLabelSql('cb', 'wr')} AS label FROM cell_blocks cb JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
      WHERE cb.id = $1`, [cellBlockId])).rows[0];
  return r ? r.label : 'ячейка';
}

// Первая пустая ячейка зоны склада (по обходу) или null.
async function emptyZoneCell(client, zoneIds) {
  if (!zoneIds || !zoneIds.size) return null;
  return (await client.query(
    `SELECT cb.id, ${blockLabelSql('cb', 'wr')} AS label FROM cell_blocks cb JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
      WHERE cb.id = ANY($1::uuid[])
        AND NOT EXISTS (SELECT 1 FROM cell_stock cs WHERE cs.cell_block_id = cb.id AND cs.qty > 0)
      ORDER BY wr.row_num, cb.rack_start, cb.tier_start LIMIT 1`, [[...zoneIds]])).rows[0] || null;
}

// Проверка перед тем, как положить товар в ячейку: нельзя — ошибка с
// объяснением; у склада есть зона, а кладут вне её — в зоне не должно быть
// пустой ячейки, и руководителю уведомление, куда положили.
async function checkPut(client, warehouseId, { cellBlockId, companyId, vw = null, quality = 'good' }) {
  if (!cellBlockId) return;
  const lay = companyId ? await layout(client, companyId) : null;
  const why = await conflict(client, { cellBlockId, companyId, vw, quality }, lay);
  if (why) throw new HttpError(409, `Сюда нельзя: ${why}. Положите в другую ячейку.`);
  if (!lay || !vw || !isGood(quality)) return;
  const zone = lay.zone.get(vw);
  if (!zone || !zone.size || zone.has(cellBlockId)) return;
  const free = await emptyZoneCell(client, zone);
  if (free) throw new HttpError(409, `У склада «${lay.name(vw)}» своя зона, и в ней свободна ячейка ${free.label} — положите туда.`);
  const seller = (await client.query('SELECT name FROM companies WHERE id = $1', [companyId])).rows[0];
  await journal.createEntry(client, {
    warehouseId, agent: 'Кладовщик', status: 'auto',
    actionText: `Товар склада «${lay.name(vw)}» продавца «${seller ? seller.name : ''}» положили вне его зоны — в ячейку `
      + `${await labelOf(client, cellBlockId)}: в зоне нет свободных ячеек. Расширьте зону, если нужно.`,
    entityType: 'vw_zone', entityId: vw, cellBlockId, actorType: 'system',
  });
}

// ---------- Зона ----------
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

// Ячейки зоны словами: ряд целиком — «ряд 3», остальное — адресами.
async function zoneInfo(client, warehouseId, vwId) {
  const cells = (await client.query(
    `SELECT cb.id, cb.warehouse_row_id, wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end,
            EXISTS (SELECT 1 FROM cell_stock cs WHERE cs.cell_block_id = cb.id AND cs.qty > 0) AS busy
       FROM cell_blocks cb JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
      WHERE cb.warehouse_id = $1 AND cb.reserved_vw_id = $2
      ORDER BY wr.row_num, cb.rack_start, cb.tier_start`, [warehouseId, vwId])).rows;
  if (!cells.length) return { cells: 0, empty: 0, rows: [], labels: [], text: '' };
  const rowSizes = new Map((await client.query(
    `SELECT warehouse_row_id, count(*)::int AS n FROM cell_blocks WHERE warehouse_id = $1 AND warehouse_row_id = ANY($2::uuid[])
      GROUP BY 1`, [warehouseId, [...new Set(cells.map((c) => c.warehouse_row_id))]])).rows.map((r) => [r.warehouse_row_id, r.n]));
  const byRow = new Map();
  for (const c of cells) byRow.set(c.warehouse_row_id, (byRow.get(c.warehouse_row_id) || []).concat(c));
  const rows = []; const labels = [];
  for (const [rowId, list] of byRow) {
    if (list.length === rowSizes.get(rowId)) rows.push(list[0].row_num);
    else labels.push(...list.map((c) => formatBlockLabel(c.row_num, c)));
  }
  const text = [...rows.map((r) => `ряд ${r}`), ...labels].join(', ');
  return { cells: cells.length, empty: cells.filter((c) => !c.busy).length, rows, labels, text };
}

// Задать зону склада: ряды целиком и отдельные ячейки (адреса как на карте).
// Пусто — зоны нет.
async function setZone(client, warehouseId, { vwId, rows = [], cells = [] }) {
  if (!Array.isArray(rows) || !Array.isArray(cells) || rows.length > 200 || cells.length > 2000) {
    throw new HttpError(400, 'Зона — номера рядов и адреса ячеек');
  }
  const all = (await client.query(
    `SELECT cb.id, wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end, cb.reserved_vw_id, v.name AS reserved_name
       FROM cell_blocks cb JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
       LEFT JOIN virtual_warehouses v ON v.id = cb.reserved_vw_id AND v.archived_at IS NULL
      WHERE cb.warehouse_id = $1`, [warehouseId])).rows;
  const byLabel = new Map(all.map((c) => [norm(formatBlockLabel(c.row_num, c)), c]));
  const picked = new Map();
  const badRows = [];
  for (const r of rows) {
    const n = Number(String(r).replace(/^ряд/i, '').trim());
    const hit = all.filter((c) => Number(c.row_num) === n);
    if (!Number.isInteger(n) || !hit.length) badRows.push(String(r)); else hit.forEach((c) => picked.set(c.id, c));
  }
  const badCells = [];
  for (const l of cells) {
    const c = byLabel.get(norm(l));
    if (!c) badCells.push(String(l)); else picked.set(c.id, c);
  }
  if (badRows.length || badCells.length) {
    throw new HttpError(400, [badRows.length ? `рядов ${badRows.slice(0, 5).join(', ')} на складе нет` : '',
      badCells.length ? `ячеек ${badCells.slice(0, 5).join(', ')} на складе нет` : ''].filter(Boolean).join('; '));
  }
  const taken = [...picked.values()].find((c) => c.reserved_vw_id && c.reserved_vw_id !== vwId && c.reserved_name);
  if (taken) {
    throw new HttpError(409, `Ячейка ${formatBlockLabel(taken.row_num, taken)} уже в зоне склада «${taken.reserved_name}»`);
  }
  await client.query('UPDATE cell_blocks SET reserved_vw_id = NULL WHERE warehouse_id = $1 AND reserved_vw_id = $2', [warehouseId, vwId]);
  if (picked.size) {
    await client.query('UPDATE cell_blocks SET reserved_vw_id = $2 WHERE warehouse_id = $1 AND id = ANY($3::uuid[])',
      [warehouseId, vwId, [...picked.keys()]]);
  }
  // Чужой товар, уже лежащий в зоне, — сказать сразу: его надо будет убрать.
  const foreign = Number((await client.query(
    `SELECT count(DISTINCT cs.cell_block_id)::int AS n FROM cell_stock cs
      WHERE cs.cell_block_id = ANY($1::uuid[]) AND cs.qty > 0 AND cs.virtual_warehouse_id IS DISTINCT FROM $2::uuid`,
    [[...picked.keys()], vwId])).rows[0].n);
  return { ...(await zoneInfo(client, warehouseId, vwId)), foreign };
}

// ---------- Смешанные ячейки и задания «переложить» ----------
// Где товар склада лежит вместе с товаром других складов продавца.
async function mixedCells(client, warehouseId, companyId, vwId, { defect = false } = {}) {
  return (await client.query(
    `SELECT cs.cell_block_id, cs.sku, cs.quality::text AS quality, SUM(cs.qty)::int AS qty,
            ${blockLabelSql('cb', 'wr')} AS label, COALESCE(MAX(p.name), cs.sku) AS name
       FROM cell_stock cs
       JOIN cell_blocks cb ON cb.id = cs.cell_block_id JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
       LEFT JOIN products p ON p.company_id = cs.company_id AND p.sku = cs.sku
      WHERE cs.warehouse_id = $1 AND cs.company_id = $2 AND cs.virtual_warehouse_id = $3 AND cs.qty > 0
        AND ($4 OR cs.quality = 'good')
        AND EXISTS (SELECT 1 FROM cell_stock o WHERE o.cell_block_id = cs.cell_block_id AND o.company_id = cs.company_id
                     AND o.qty > 0 AND o.virtual_warehouse_id IS DISTINCT FROM cs.virtual_warehouse_id
                     AND (o.quality = 'good') = (cs.quality = 'good'))
      GROUP BY cs.cell_block_id, cs.sku, cs.quality, cb.id, wr.row_num
      ORDER BY wr.row_num, cb.rack_start, cb.tier_start`, [warehouseId, companyId, vwId, defect])).rows;
}

async function createSeparateTasks(client, warehouseId, { companyId, vwId, defect, list = null }) {
  const mixed = list || await mixedCells(client, warehouseId, companyId, vwId, { defect });
  for (const m of mixed) {
    await client.query(
      `INSERT INTO vw_move_tasks (warehouse_id, company_id, kind, sku, name, quality, from_cell_block_id, from_vw, to_vw, qty)
       VALUES ($1, $2, 'separate', $3, $4, $5, $6, $7, $7, $8)`,
      [warehouseId, companyId, m.sku, m.name, m.quality, m.cell_block_id, vwId, m.qty]);
  }
  return mixed.length;
}

// Перенос на склад «хранить отдельно» (или с него): задания по ячейкам, где
// лежит товар склада-источника, — с самых давних строк.
async function createTransferTasks(client, warehouseId, t) {
  const rows = (await client.query(
    `SELECT cell_block_id, SUM(qty)::int AS qty, MIN(updated_at) AS at FROM cell_stock
      WHERE company_id = $1 AND sku = $2 AND quality::text = $4 AND qty > 0
        AND virtual_warehouse_id IS NOT DISTINCT FROM $3::uuid
      GROUP BY cell_block_id ORDER BY at`, [t.company_id, t.sku, t.from_vw, t.quality || 'good'])).rows;
  let left = Number(t.qty);
  for (const r of rows) {
    if (left <= 0) break;
    const q = Math.min(left, r.qty);
    await client.query(
      `INSERT INTO vw_move_tasks (warehouse_id, company_id, kind, transfer_id, sku, name, quality, from_cell_block_id, from_vw, to_vw, qty)
       VALUES ($1, $2, 'transfer', $3, $4, $5, $6, $7, $8, $9, $10)`,
      [warehouseId, t.company_id, t.id, t.sku, t.name, t.quality || 'good', r.cell_block_id, t.from_vw, t.to_vw, q]);
    left -= q;
  }
  if (left > 0) throw new HttpError(409, 'Товара на складе-источнике уже меньше — обновите экран');
}

// Нужен ли перенос руками: один из складов хранится отдельно.
async function needsMove(client, companyId, fromVw, toVw, quality = 'good') {
  const lay = await layout(client, companyId);
  return lay.separate(fromVw, quality) || lay.separate(toVw, quality);
}

function taskView(t, names) {
  return {
    id: t.id, kind: t.kind, sku: t.sku, name: t.name, quality: t.quality, companyId: t.company_id, seller: t.seller,
    fromCellBlockId: t.from_cell_block_id, fromLabel: t.from_label,
    fromVw: t.from_vw, fromName: names(t.from_vw), toVw: t.to_vw, toName: names(t.to_vw),
    qty: t.qty, moved: t.moved, left: t.qty - t.moved, status: t.status, transfer: t.transfer_number || null,
    createdAt: t.created_at,
  };
}

async function listTasks(client, warehouseId, { open = true, companyId = null, id = null } = {}) {
  const rows = (await client.query(
    `SELECT t.*, c.name AS seller, tr.number AS transfer_number,
            ${blockLabelSql('cb', 'wr')} AS from_label
       FROM vw_move_tasks t
       JOIN companies c ON c.id = t.company_id
       JOIN cell_blocks cb ON cb.id = t.from_cell_block_id JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
       LEFT JOIN vw_transfers tr ON tr.id = t.transfer_id
      WHERE t.warehouse_id = $1 AND (NOT $2 OR t.status = 'open') AND ($3::uuid IS NULL OR t.company_id = $3)
        AND ($4::uuid IS NULL OR t.id = $4)
      ORDER BY t.created_at, wr.row_num, cb.rack_start
      LIMIT 300`, [warehouseId, open, companyId, id])).rows;
  const vwNames = new Map((await client.query(
    'SELECT id, name FROM virtual_warehouses WHERE id = ANY($1::uuid[])',
    [[...new Set(rows.flatMap((r) => [r.from_vw, r.to_vw]).filter(Boolean))]])).rows.map((r) => [r.id, r.name]));
  const names = (id) => (id ? vwNames.get(id) || 'склад' : MAIN_NAME);
  return rows.map((t) => taskView(t, names));
}

// Шаг задания: грузчик переложил qty штук в ячейку toCellBlockId. Каждая
// переложенная штука сразу на новом месте (и на новом складе у переноса).
async function step(client, warehouseId, { taskId, toCellBlockId, qty, staffKeyId = null }) {
  if (!UUID.test(String(taskId || ''))) throw new HttpError(404, 'Задание не найдено');
  if (!UUID.test(String(toCellBlockId || ''))) throw new HttpError(400, 'Куда положили — ячейка');
  const t = (await client.query('SELECT * FROM vw_move_tasks WHERE id = $1 AND warehouse_id = $2 FOR UPDATE',
    [taskId, warehouseId])).rows[0];
  if (!t) throw new HttpError(404, 'Задание не найдено');
  if (t.status !== 'open') throw new HttpError(409, 'Задание уже закрыто');
  if (toCellBlockId === t.from_cell_block_id) throw new HttpError(400, 'Переложите в другую ячейку — эта та же');
  const target = (await client.query('SELECT id FROM cell_blocks WHERE id = $1 AND warehouse_id = $2',
    [toCellBlockId, warehouseId])).rows[0];
  if (!target) throw new HttpError(404, 'Ячейка не найдена');
  const n = requireQty(qty, 'Сколько переложили', { min: 1 });
  const left = t.qty - t.moved;
  if (n > left) throw new HttpError(400, `По заданию осталось переложить ${left} шт.`);
  await checkPut(client, warehouseId, { cellBlockId: toCellBlockId, companyId: t.company_id, vw: t.to_vw, quality: t.quality });
  await takeFromCell(client, warehouseId, {
    cellBlockId: t.from_cell_block_id, sku: t.sku, companyId: t.company_id, quality: t.quality, qty: n,
    verb: 'переложить', vw: t.from_vw || null,
  });
  await client.query(
    `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty, quality, virtual_warehouse_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`, [toCellBlockId, warehouseId, t.company_id, t.sku, n, t.quality, t.to_vw]);
  await client.query(
    `INSERT INTO stock_operations (warehouse_id, company_id, kind, sku, qty, from_cell_block_id, to_cell_block_id, details, worker_key_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
    [warehouseId, t.company_id, t.kind === 'transfer' ? 'vw_transfer' : 'move', t.sku, n, t.from_cell_block_id, toCellBlockId,
      JSON.stringify({ moveTask: t.id, fromVw: t.from_vw, toVw: t.to_vw, quality: t.quality }), staffKeyId]);
  await refreshCellFill(client, t.from_cell_block_id);
  await refreshCellFill(client, toCellBlockId);
  const done = n === left;
  await client.query(
    `UPDATE vw_move_tasks SET moved = moved + $2, worker_key_id = COALESCE($3, worker_key_id),
            status = CASE WHEN $4 THEN 'done' ELSE status END, done_at = CASE WHEN $4 THEN now() ELSE done_at END
      WHERE id = $1`, [t.id, n, staffKeyId, done]);
  if (done && t.transfer_id) await finishTransferIfDone(client, warehouseId, t.transfer_id);
  return (await listTasks(client, warehouseId, { open: false, id: t.id }))[0];
}

// Перенос закрыт, когда закрыты все его задания: сколько переложили — столько
// и перенесено, остальное осталось на складе-источнике.
async function finishTransferIfDone(client, warehouseId, transferId) {
  const left = (await client.query(
    `SELECT count(*) FILTER (WHERE status = 'open')::int AS open, COALESCE(SUM(moved), 0)::int AS moved
       FROM vw_move_tasks WHERE transfer_id = $1`, [transferId])).rows[0];
  if (left.open) return;
  const t = (await client.query(
    `UPDATE vw_transfers SET status = 'done', done_at = now() WHERE id = $1 AND status = 'to_move' RETURNING *`,
    [transferId])).rows[0];
  if (!t) return;
  const lay = await layout(client, t.company_id);
  const what = `«${t.name || t.sku}»: «${lay.name(t.from_vw)}» → «${lay.name(t.to_vw)}», переложено ${left.moved} из ${Number(t.qty)} шт.`;
  await journal.createEntry(client, {
    warehouseId, agent: 'Кладовщик', status: 'auto',
    actionText: `Перенос ${t.number} закончен: ${what}`, entityType: 'vw_transfer', entityId: t.id, actorType: 'system',
  });
  await client.query(
    `INSERT INTO seller_notifications (warehouse_id, company_id, kind, text, entity_id) VALUES ($1, $2, 'vw_moved', $3, $4)`,
    [warehouseId, t.company_id, `Перенос ${t.number} закончен: «${t.name || t.sku}» — «${lay.name(t.from_vw)}» → «${lay.name(t.to_vw)}», `
      + `${left.moved} шт.${left.moved < Number(t.qty) ? ` (из ${Number(t.qty)} запрошенных)` : ''}`, t.id]);
}

// Руководитель снимает задание: непереложенное остаётся где было.
async function cancelTask(client, warehouseId, { taskId, note, actor }) {
  if (!UUID.test(String(taskId || ''))) throw new HttpError(404, 'Задание не найдено');
  const t = (await client.query(
    `UPDATE vw_move_tasks SET status = 'canceled', done_at = now(), cancel_note = $3
      WHERE id = $1 AND warehouse_id = $2 AND status = 'open' RETURNING *`,
    [taskId, warehouseId, typeof note === 'string' ? note.trim().slice(0, 300) || null : null])).rows[0];
  if (!t) throw new HttpError(409, 'Задание уже закрыто или не найдено');
  await journal.createEntry(client, {
    warehouseId, agent: 'Кладовщик', status: 'auto',
    actionText: `Снято задание «переложить» «${t.name || t.sku}»: переложено ${t.moved} из ${t.qty} шт.${t.cancel_note ? ` Причина: ${t.cancel_note}` : ''}`,
    entityType: 'vw_move_task', entityId: t.id, actorType: actor.role === 'manager' ? 'manager' : 'owner', actorId: actor.id || null,
  });
  if (t.transfer_id) await finishTransferIfDone(client, warehouseId, t.transfer_id);
  return { ok: true };
}

// Склад больше не хранится отдельно (или его брак — вместе с общим):
// задания «переложить» по нему не нужны. Разделение снимается, перенос
// дописывается на месте — склады снова «вместе» (проверка 03.10.2026).
async function releaseSeparate(client, warehouseId, { companyId, vwId }) {
  const lay = await layout(client, companyId);
  const open = (await client.query(
    `SELECT * FROM vw_move_tasks WHERE warehouse_id = $1 AND company_id = $2 AND status = 'open'
        AND (from_vw = $3 OR to_vw = $3) FOR UPDATE`, [warehouseId, companyId, vwId])).rows;
  let canceled = 0; let finished = 0;
  const transfers = new Set();
  for (const t of open) {
    if (t.kind === 'separate') {
      if (lay.separate(t.to_vw, t.quality)) continue;
      await client.query(`UPDATE vw_move_tasks SET status = 'canceled', done_at = now(), cancel_note = 'склад больше не хранится отдельно' WHERE id = $1`, [t.id]);
      canceled += 1;
      continue;
    }
    if (lay.separate(t.from_vw, t.quality) || lay.separate(t.to_vw, t.quality)) continue;
    // Перенос: остаток — учётом в той же ячейке, без перекладки (сколько
    // там ещё лежит — ячейку могли разобрать отбором).
    const have = Number((await client.query(
      `SELECT COALESCE(SUM(qty), 0) AS q FROM cell_stock WHERE cell_block_id = $1 AND company_id = $2 AND sku = $3
          AND quality = $4 AND virtual_warehouse_id IS NOT DISTINCT FROM $5::uuid`,
      [t.from_cell_block_id, t.company_id, t.sku, t.quality, t.from_vw])).rows[0].q);
    const n = Math.min(t.qty - t.moved, have);
    if (n > 0) {
      await takeFromCell(client, warehouseId, {
        cellBlockId: t.from_cell_block_id, sku: t.sku, companyId: t.company_id, quality: t.quality, qty: n,
        verb: 'перенести', vw: t.from_vw || null,
      });
      await client.query(
        `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty, quality, virtual_warehouse_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`, [t.from_cell_block_id, warehouseId, t.company_id, t.sku, n, t.quality, t.to_vw]);
      await client.query(
        `INSERT INTO stock_operations (warehouse_id, company_id, kind, sku, qty, from_cell_block_id, to_cell_block_id, details, worker_key_id)
         VALUES ($1, $2, 'vw_transfer', $3, $4, $5, $5, $6::jsonb, NULL)`,
        [warehouseId, t.company_id, t.sku, n, t.from_cell_block_id, JSON.stringify({ moveTask: t.id, fromVw: t.from_vw, toVw: t.to_vw, quality: t.quality })]);
    }
    await client.query(`UPDATE vw_move_tasks SET moved = moved + $2, status = 'done', done_at = now() WHERE id = $1`, [t.id, n]);
    finished += 1;
    if (t.transfer_id) transfers.add(t.transfer_id);
  }
  for (const id of transfers) await finishTransferIfDone(client, warehouseId, id);
  return { canceled, finished };
}

// Зоны складов, в которых нет пустой ячейки, — для предупреждений.
async function fullZones(client, warehouseId) {
  return (await client.query(
    `SELECT v.id, v.name, v.company_id, c.name AS seller, count(cb.id)::int AS cells
       FROM virtual_warehouses v
       JOIN companies c ON c.id = v.company_id AND c.archived_at IS NULL
       JOIN cell_blocks cb ON cb.reserved_vw_id = v.id
       LEFT JOIN LATERAL (SELECT 1 AS busy FROM cell_stock cs WHERE cs.cell_block_id = cb.id AND cs.qty > 0 LIMIT 1) b ON true
      WHERE v.warehouse_id = $1 AND v.archived_at IS NULL
      GROUP BY v.id, v.name, v.company_id, c.name
     HAVING count(*) FILTER (WHERE b.busy IS NULL) = 0`,
    [warehouseId])).rows;
}

// Предупредить руководителя заранее (владелец 02.10.2026): привоз на склад с
// заполненной зоной — при оформлении и ещё раз, когда машина приехала.
// Запись ждёт «Принял к сведению».
async function warnFullZones(client, warehouseId, invoiceId, when) {
  const lines = (await client.query(
    `SELECT ii.virtual_warehouse_id AS vw, SUM(ii.declared_qty)::int AS qty, i.number,
            left(i.source_document_date::text, 10) AS day, c.name AS seller
       FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id JOIN companies c ON c.id = i.company_id
      WHERE ii.invoice_id = $1 AND ii.virtual_warehouse_id IS NOT NULL
      GROUP BY ii.virtual_warehouse_id, i.number, i.source_document_date, c.name`, [invoiceId])).rows;
  if (!lines.length) return;
  const full = new Map((await fullZones(client, warehouseId)).map((z) => [z.id, z]));
  for (const l of lines) {
    const z = full.get(l.vw);
    if (!z) continue;
    await journal.createEntry(client, {
      warehouseId, agent: 'Кладовщик', status: 'pending',
      actionText: `${when === 'arrived' ? 'Машина приехала: продавец' : 'Продавец'} «${l.seller}» везёт ${l.qty} шт. на склад «${z.name}» `
        + `(привоз ${l.number}${l.day && when !== 'arrived' ? `, привезут ${l.day.slice(8, 10)}.${l.day.slice(5, 7)}` : ''}), а в зоне этого склада нет пустых ячеек. `
        + 'Расширьте зону — иначе товар положат в свободные ячейки рядом.',
      entityType: 'vw_zone', entityId: z.id, invoiceId, actorType: 'system',
    });
  }
}

module.exports = {
  layout, conflict, checkPut, zoneInfo, setZone, mixedCells, createSeparateTasks, createTransferTasks, needsMove,
  listTasks, step, cancelTask, finishTransferIfDone, fullZones, warnFullZones, emptyZoneCell, releaseSeparate,
};
