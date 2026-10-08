// Виртуальные склады продавца (схема одобрена владельцем 02.10.2026,
// argus-product/docs/Виртуальные склады — схема.md).
//
// Виртуальный склад — часть товара продавца на живом складе под своё
// назначение (площадка, юрлицо, «иное»). Товар лежит в тех же ячейках, у
// строки остатка — отметка склада (cell_stock.virtual_warehouse_id).
// Владелец 03.10.2026: «Основной» — ВЕСЬ товар продавца (без брака), склады
// продавца — его части; то, что ни к одному складу не отнесено, — «Остальной
// товар» (NULL в учёте).
//
// Здесь — склады (завести, переименовать, убрать), перенос товара между
// ними, заявки продавца на перенос, «права склада» продавца и уведомления
// продавцу.
const { HttpError } = require('../middleware/errorHandler');
const { requireQty } = require('../middleware/qty');
const journal = require('../journal/repository');
const { nextNumber, productName } = require('../defects/service');
const separate = require('./separate');

const MAIN_NAME = 'Остальной товар';
// «Основной» — весь товар продавца: склад так назвать нельзя.
const TOTAL_NAME = 'Основной';
const DEFECT_NAME = 'Склад брака';
const MARKETPLACES = { wb: 'WB', ozon: 'Озон', yandex: 'Яндекс Маркет', other: 'иное' };
// «Права склада» (вопрос 14): что склад может делать с товаром продавца без
// его согласия. Нет ключа в ff_rights — право есть.
// Одно право (владелец 02.10.2026): решать без продавца спорные ситуации с
// количеством — переносы между его складами, недостачу и излишки пересчёта,
// расхождения приёмки по складам, брак с полки, где лежит товар разных
// складов. Составлять поставки, приёмку и отгрузку склад ведёт всегда сам.
const RIGHTS = {
  decide: 'решать без него спорные ситуации с количеством (переносы между складами, недостачи, излишки, расхождения, брак)',
};
// Хвост уведомления, когда склад решил сам: продавец должен заметить.
const DECIDED_SELF = ' Обратите внимание: склад решил это сам. Запретить складу решать такое без вас можно в «Правах склада».';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const view = (r) => ({
  id: r.id, name: r.name, marketplace: r.marketplace, marketplaceName: MARKETPLACES[r.marketplace],
  keepSeparate: r.keep_separate, defectSeparate: r.defect_separate, archivedAt: r.archived_at || null, createdAt: r.created_at,
});

async function list(client, companyId, { withArchived = false } = {}) {
  return (await client.query(
    `SELECT * FROM virtual_warehouses WHERE company_id = $1 AND ($2 OR archived_at IS NULL)
      ORDER BY archived_at NULLS FIRST, created_at`, [companyId, withArchived])).rows.map(view);
}

const nameOf = (rows, id) => (id ? (rows.find((r) => r.id === id) || {}).name || 'склад' : MAIN_NAME);

// Склад продавца по id: null — «Основной». Чужой или убранный — 404.
async function requireVw(client, companyId, vwId, { forWb = false } = {}) {
  if (vwId === null || vwId === undefined || vwId === '') return null;
  if (!UUID.test(String(vwId))) throw new HttpError(400, 'Склад не найден');
  const r = (await client.query(
    'SELECT * FROM virtual_warehouses WHERE id = $1 AND company_id = $2 AND archived_at IS NULL',
    [vwId, companyId])).rows[0];
  if (!r) throw new HttpError(404, 'Склад не найден — возможно, его убрали');
  if (forWb && r.marketplace !== 'wb') {
    throw new HttpError(400, `Поставку на WB собирают с «${MAIN_NAME}» или со склада WB, а «${r.name}» — ${MARKETPLACES[r.marketplace]}`);
  }
  return view(r);
}

// Склады, с которых можно собрать поставку на WB: «Основной» и склады WB.
async function wbChoices(client, companyId) {
  return [{ id: null, name: MAIN_NAME }].concat(
    (await list(client, companyId)).filter((w) => w.marketplace === 'wb').map((w) => ({ id: w.id, name: w.name })));
}

function cleanName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw new HttpError(400, 'Назовите склад, например «Озон» или «ООО Ромашка»');
  if (name.length > 100) throw new HttpError(400, 'Название склада — не длиннее 100 знаков');
  if ([MAIN_NAME, TOTAL_NAME, DEFECT_NAME].some((n) => n.toLowerCase() === name.toLowerCase())) {
    throw new HttpError(400, `«${name}» — так называется часть учёта продавца, назовите склад иначе`);
  }
  return name;
}
function cleanMarketplace(value) {
  if (!Object.prototype.hasOwnProperty.call(MARKETPLACES, value)) {
    throw new HttpError(400, 'Площадка склада — WB, Озон, Яндекс Маркет или «иное»');
  }
  return value;
}
const cleanNote = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);

async function companyRow(client, warehouseId, companyId) {
  const c = (await client.query(
    'SELECT id, name, ff_rights FROM companies WHERE id = $1 AND warehouse_id = $2 AND archived_at IS NULL',
    [companyId, warehouseId])).rows[0];
  if (!c) throw new HttpError(404, 'Продавец не найден');
  return c;
}

function rightsOf(company) {
  const r = company.ff_rights || {};
  return Object.fromEntries(Object.keys(RIGHTS).map((k) => [k, r[k] !== false]));
}

async function notifySeller(client, { warehouseId, companyId, kind, text, entityId = null }) {
  await client.query(
    `INSERT INTO seller_notifications (warehouse_id, company_id, kind, text, entity_id) VALUES ($1, $2, $3, $4, $5)`,
    [warehouseId, companyId, kind, text.slice(0, 1000), entityId]);
}

const ACTOR_NAME = { owner: 'Руководитель склада', seller: 'Продавец' };
const actorType = (role) => (role === 'seller' ? 'seller' : role);

async function create(client, { warehouseId, companyId, name, marketplace, keepSeparate = false, defectSeparate = false, zone, actor }) {
  const company = await companyRow(client, warehouseId, companyId);
  const clean = cleanName(name);
  const mp = cleanMarketplace(marketplace);
  const dup = (await client.query(
    'SELECT 1 FROM virtual_warehouses WHERE company_id = $1 AND archived_at IS NULL AND lower(btrim(name)) = lower($2)',
    [companyId, clean])).rows[0];
  if (dup) throw new HttpError(409, `Склад «${clean}» у продавца уже есть`);
  const row = (await client.query(
    `INSERT INTO virtual_warehouses (warehouse_id, company_id, name, marketplace, keep_separate, defect_separate, created_by, created_by_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [warehouseId, companyId, clean, mp, keepSeparate === true, keepSeparate === true && defectSeparate === true,
      actor.id || null, actor.name || null])).rows[0];
  if (zone && (zone.rows?.length || zone.cells?.length)) await separate.setZone(client, warehouseId, { vwId: row.id, ...zone });
  const text = `Заведён склад «${clean}» продавца «${company.name}» (площадка — ${MARKETPLACES[mp]}`
    + `${keepSeparate === true ? ', хранить отдельно' : ''}).`;
  await journal.createEntry(client, {
    warehouseId, agent: 'Кладовщик', status: 'auto', actionText: text,
    entityType: 'virtual_warehouse', entityId: row.id, actorType: actorType(actor.role), actorId: actor.id || null,
  });
  return view(row);
}

async function update(client, {
  warehouseId, companyId, id, name, marketplace, keepSeparate, defectSeparate, zone, separateExisting, actor,
}) {
  const company = await companyRow(client, warehouseId, companyId);
  const cur = (await client.query(
    'SELECT * FROM virtual_warehouses WHERE id = $1 AND company_id = $2 AND archived_at IS NULL FOR UPDATE',
    [id, companyId])).rows[0];
  if (!cur) throw new HttpError(404, 'Склад не найден — возможно, его убрали');
  const next = {
    name: name === undefined ? cur.name : cleanName(name),
    marketplace: marketplace === undefined ? cur.marketplace : cleanMarketplace(marketplace),
    keepSeparate: keepSeparate === undefined ? cur.keep_separate : keepSeparate === true,
  };
  next.defectSeparate = next.keepSeparate && (defectSeparate === undefined ? cur.defect_separate : defectSeparate === true);
  // Включили «хранить отдельно», а товар уже лежит вместе с товаром других
  // складов (владелец 02.10.2026): склад решает — задания грузчику на
  // разделение или только новый товар.
  const turnedOn = (next.keepSeparate && !cur.keep_separate) || (next.defectSeparate && !cur.defect_separate);
  let mixed = [];
  if (turnedOn) {
    mixed = await separate.mixedCells(client, warehouseId, companyId, id, { defect: next.defectSeparate });
    if (!next.defectSeparate) mixed = mixed.filter((m) => m.quality === 'good');
    else if (cur.keep_separate) mixed = mixed.filter((m) => m.quality !== 'good');
    if (mixed.length && !['tasks', 'new'].includes(separateExisting)) {
      throw new HttpError(409, `Товар склада «${cur.name}» уже лежит вместе с товаром других складов в ${mixed.length} `
        + `${mixed.length === 1 ? 'ячейке' : 'ячейках'} — выберите: задания грузчику на разделение или разделять только новый товар`);
    }
  }
  if (next.name.toLowerCase() !== cur.name.toLowerCase()) {
    const dup = (await client.query(
      `SELECT 1 FROM virtual_warehouses WHERE company_id = $1 AND archived_at IS NULL AND id <> $2
          AND lower(btrim(name)) = lower($3)`, [companyId, id, next.name])).rows[0];
    if (dup) throw new HttpError(409, `Склад «${next.name}» у продавца уже есть`);
  }
  // Склад, с которого собирается поставка на WB, не может перестать быть
  // складом WB: поставка осталась бы собранной не с того склада.
  if (cur.marketplace === 'wb' && next.marketplace !== 'wb') {
    const busy = (await client.query(
      `SELECT number FROM supplies WHERE virtual_warehouse_id = $1 AND status <> 'shipped' LIMIT 1`, [id])).rows[0];
    if (busy) throw new HttpError(409, `С этого склада собирается поставка ${busy.number} — площадку WB поменять нельзя, пока она не уедет`);
  }
  const row = (await client.query(
    `UPDATE virtual_warehouses SET name = $2, marketplace = $3, keep_separate = $4, defect_separate = $5 WHERE id = $1 RETURNING *`,
    [id, next.name, next.marketplace, next.keepSeparate, next.defectSeparate])).rows[0];
  const changes = [];
  let tasks = 0;
  if (mixed.length && separateExisting === 'tasks') {
    tasks = await separate.createSeparateTasks(client, warehouseId, { companyId, vwId: id, list: mixed });
    changes.push(`задания грузчику на разделение — ${tasks}`);
  } else if (mixed.length) {
    changes.push(`уже лежащее вместе (${mixed.length} яч.) не разделяем — отдельно только новый товар`);
  }
  if (row.defect_separate !== cur.defect_separate) changes.push(row.defect_separate ? 'брак тоже отдельно' : 'брак — в общих ячейках брака');
  // Выключили «хранить отдельно» (или брак — снова в общих ячейках): задания
  // «переложить» по нему больше не нужны.
  if ((cur.keep_separate && !row.keep_separate) || (cur.defect_separate && !row.defect_separate)) {
    const rel = await separate.releaseSeparate(client, warehouseId, { companyId, vwId: id });
    if (rel.canceled || rel.finished) changes.push(`снято заданий «переложить» — ${rel.canceled}, переносов дописано — ${rel.finished}`);
  }
  let zoneOut = null;
  if (zone !== undefined) {
    zoneOut = await separate.setZone(client, warehouseId, { vwId: id, rows: zone?.rows || [], cells: zone?.cells || [] });
    changes.push(zoneOut.cells ? `зона: ${zoneOut.text}` : 'зона снята');
  }
  if (row.name !== cur.name) changes.push(`название «${cur.name}» → «${row.name}»`);
  if (row.marketplace !== cur.marketplace) changes.push(`площадка ${MARKETPLACES[cur.marketplace]} → ${MARKETPLACES[row.marketplace]}`);
  if (row.keep_separate !== cur.keep_separate) changes.push(row.keep_separate ? 'хранить отдельно' : 'хранить вместе с остальными');
  if (changes.length) {
    await journal.createEntry(client, {
      warehouseId, agent: 'Кладовщик', status: 'auto',
      actionText: `Изменён склад продавца «${company.name}»: ${changes.join(', ')}.`,
      entityType: 'virtual_warehouse', entityId: id, actorType: actorType(actor.role), actorId: actor.id || null,
    });
  }
  return { ...view(row), tasks, ...(zoneOut ? { zone: zoneOut } : {}) };
}

// Убрать склад (владелец 06.10.2026): товар физически никуда не переезжает —
// остаётся на тех же полках и просто числится в «Остальном товаре». Открытые
// документы и поставки этого склада — тоже; незаконченные переносы и задания
// «переложить» по нему отменяются. Продавцу — одно уведомление.
async function archive(client, { warehouseId, companyId, id, actor }) {
  const company = await companyRow(client, warehouseId, companyId);
  const cur = (await client.query(
    'SELECT * FROM virtual_warehouses WHERE id = $1 AND company_id = $2 AND archived_at IS NULL FOR UPDATE',
    [id, companyId])).rows[0];
  if (!cur) throw new HttpError(404, 'Склад не найден — возможно, его уже убрали');
  // Ждёт решение продавца, где этот склад — одна из частей (проверка 03.10.2026:
  // иначе решение записывало товар на убранный склад).
  const waiting = (await client.query(
    `SELECT 1 FROM vw_decisions d WHERE d.company_id = $1 AND d.status = 'pending'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.parts) p WHERE p->>'vw' = $2::text) LIMIT 1`,
    [companyId, id])).rows[0];
  if (waiting) throw new HttpError(409, `По складу «${cur.name}» ждёт решение продавца — убрать склад можно после его решения`);
  // Незаконченные переносы и задания «переложить» — отменить: склада больше нет.
  const canceled = (await client.query(
    `UPDATE vw_transfers SET status = 'rejected', reject_reason = 'склад убран', decided_role = COALESCE(decided_role, $2),
            decided_name = COALESCE(decided_name, $3), decided_at = COALESCE(decided_at, now())
      WHERE (from_vw = $1 OR to_vw = $1) AND status IN ('requested', 'waiting_seller', 'to_move') RETURNING number`,
    [id, actor.role, actor.name || ACTOR_NAME[actor.role] || null])).rows.map((r) => r.number);
  await client.query(
    `UPDATE vw_move_tasks SET status = 'canceled', done_at = now(), cancel_note = 'склад убран'
      WHERE (from_vw = $1 OR to_vw = $1) AND status = 'open'`, [id]);
  // Товар — на тех же полках, теперь в «Остальном товаре».
  const moved = (await client.query(
    `UPDATE cell_stock SET virtual_warehouse_id = NULL, updated_at = now() WHERE virtual_warehouse_id = $1
     RETURNING sku, qty`, [id])).rows;
  const units = moved.reduce((n, r) => n + Math.max(0, Number(r.qty)), 0);
  const bySku = new Map();
  for (const r of moved) if (Number(r.qty) > 0) bySku.set(r.sku, (bySku.get(r.sku) || 0) + Number(r.qty));
  for (const [sku, qty] of bySku) {
    await client.query(
      `INSERT INTO stock_operations (warehouse_id, company_id, kind, sku, qty, details)
       VALUES ($1, $2, 'vw_archive', $3, $4, $5::jsonb)`,
      [warehouseId, companyId, sku, qty, JSON.stringify({ fromVw: id, fromName: cur.name, toVw: null })]);
  }
  await client.query(
    `UPDATE invoice_items ii SET virtual_warehouse_id = NULL FROM invoices i
      WHERE i.id = ii.invoice_id AND ii.virtual_warehouse_id = $1 AND i.status NOT IN ('shipped', 'completed')`, [id]);
  await client.query(`UPDATE supplies SET virtual_warehouse_id = NULL WHERE virtual_warehouse_id = $1 AND status <> 'shipped'`, [id]);
  // Заказ физлицу с этого склада — теперь «весь товар продавца»: товар лежит
  // в «Остальном», и заказ собирается как обычно (проверка 08.10, Н2).
  await client.query('UPDATE direct_orders SET virtual_warehouse_id = NULL WHERE virtual_warehouse_id = $1', [id]);
  await client.query('UPDATE cell_blocks SET reserved_vw_id = NULL WHERE reserved_vw_id = $1', [id]);
  await client.query('UPDATE virtual_warehouses SET archived_at = now() WHERE id = $1', [id]);
  const tail = units ? ` Товар (${units.toLocaleString('ru-RU')} шт.) остался на тех же полках и теперь в «${MAIN_NAME}».` : ' Он был пустой.';
  await journal.createEntry(client, {
    warehouseId, agent: 'Кладовщик', status: 'auto',
    actionText: `Убран склад «${cur.name}» продавца «${company.name}».${tail}`
      + (canceled.length ? ` Отменены незаконченные переносы: ${canceled.join(', ')}.` : ''),
    entityType: 'virtual_warehouse', entityId: id, actorType: actorType(actor.role), actorId: actor.id || null,
  });
  // Продавцу — и про отменённые заявки на перенос: иначе он ждал бы их
  // выполнения (проверка 07.10, замечание 7).
  await notifySeller(client, { warehouseId, companyId, kind: 'vw_archived', entityId: id,
    text: `Склад убрал ваш склад «${cur.name}».${tail}`
      + (canceled.length ? ` Незаконченные переносы отменены: ${canceled.join(', ')}.` : '') });
  return { units, canceled };
}

// Сколько товара склада можно перенести: годное в ячейках этого склада минус
// то, что ещё предстоит собрать в поставки и отгрузки с этого склада (их
// строки уже несут склад). Заказы WB вне поставки склада не имеют — их не
// вычитаем: склад им назначится, когда менеджер составит поставку.
async function transferable(client, companyId, sku, vwId) {
  const r = (await client.query(
    `SELECT
       (SELECT COALESCE(SUM(qty), 0) FROM cell_stock
         WHERE company_id = $1 AND sku = $2 AND quality = 'good' AND qty > 0
           AND virtual_warehouse_id IS NOT DISTINCT FROM $3::uuid) AS in_cells,
       (SELECT COALESCE(SUM(GREATEST(ii.declared_qty - COALESCE(p.picked, 0), 0)), 0)
          FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
          LEFT JOIN LATERAL (SELECT SUM(sr.picked_qty) AS picked FROM shipping_records sr WHERE sr.invoice_item_id = ii.id) p ON true
         WHERE ii.company_id = $1 AND ii.sku = $2 AND i.direction = 'out'
           AND i.status IN ('open', 'in_progress') AND i.mp_closed_at IS NULL
           AND (i.supply_id IS NOT NULL OR i.source = '1c' OR (i.source = 'direct' AND ii.virtual_warehouse_id IS NOT NULL))
           AND NOT EXISTS (SELECT 1 FROM shipping_records f WHERE f.invoice_item_id = ii.id AND f.is_final)
           AND ii.virtual_warehouse_id IS NOT DISTINCT FROM $3::uuid) AS to_pick,
       -- Обещано переносу, который грузчик ещё перекладывает (проверка 03.10.2026).
       (SELECT COALESCE(SUM(t.qty - t.moved), 0) FROM vw_move_tasks t
         WHERE t.company_id = $1 AND t.sku = $2 AND t.status = 'open' AND t.kind = 'transfer'
           AND t.quality = 'good' AND t.from_vw IS NOT DISTINCT FROM $3::uuid) AS promised`,
    [companyId, sku, vwId])).rows[0];
  return {
    inCells: Number(r.in_cells), toPick: Number(r.to_pick), promised: Number(r.promised),
    free: Math.max(0, Number(r.in_cells) - Number(r.to_pick) - Number(r.promised)),
  };
}

// Сам перенос: строки годного остатка склада-источника (с самых давних)
// переходят на склад-назначение в тех же ячейках. Физически ничего не
// двигается — склады «вместе» (вопрос 7).
async function moveRows(client, warehouseId, t, staffKeyId = null) {
  const quality = t.quality || 'good';
  const rows = (await client.query(
    `SELECT id, cell_block_id, qty FROM cell_stock
      WHERE company_id = $1 AND sku = $2 AND quality::text = $4 AND qty > 0
        AND virtual_warehouse_id IS NOT DISTINCT FROM $3::uuid
      ORDER BY updated_at FOR UPDATE`, [t.company_id, t.sku, t.from_vw, quality])).rows;
  let left = Number(t.qty);
  const cells = new Map();
  for (const row of rows) {
    if (left <= 0) break;
    const take = Math.min(left, Number(row.qty));
    if (take === Number(row.qty)) {
      await client.query('UPDATE cell_stock SET virtual_warehouse_id = $2, updated_at = now() WHERE id = $1', [row.id, t.to_vw]);
    } else {
      await client.query('UPDATE cell_stock SET qty = qty - $2, updated_at = now() WHERE id = $1', [row.id, take]);
      await client.query(
        `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty, quality, virtual_warehouse_id)
         VALUES ($1, $2, $3, $4, $5, $7, $6)`, [row.cell_block_id, warehouseId, t.company_id, t.sku, take, t.to_vw, quality]);
    }
    cells.set(row.cell_block_id, (cells.get(row.cell_block_id) || 0) + take);
    left -= take;
  }
  if (left > 0) throw new HttpError(409, 'Товара на складе-источнике уже меньше — обновите экран');
  for (const [cellBlockId, qty] of cells) {
    await client.query(
      `INSERT INTO stock_operations (warehouse_id, company_id, kind, sku, qty, from_cell_block_id, to_cell_block_id, details, worker_key_id)
       VALUES ($1, $2, 'vw_transfer', $3, $4, $5, $5, $6::jsonb, $7)`,
      [warehouseId, t.company_id, t.sku, qty, cellBlockId,
        JSON.stringify({ transfer: t.number, fromVw: t.from_vw, toVw: t.to_vw, quality }), staffKeyId]);
  }
  return [...cells].map(([cellBlockId, qty]) => ({ cellBlockId, qty }));
}

function describe(t, rows) {
  return `«${t.name || t.sku}», ${Number(t.qty)} шт.: «${nameOf(rows, t.from_vw)}» → «${nameOf(rows, t.to_vw)}»`;
}

async function execute(client, warehouseId, t, actor) {
  const free = (await transferable(client, t.company_id, t.sku, t.from_vw)).free;
  if (free < Number(t.qty)) {
    throw new HttpError(409, `На складе «${nameOf(await list(client, t.company_id, { withArchived: true }), t.from_vw)}» можно перенести только ${free} шт.`
      + ' (остальное в ячейках занято поставками этого склада или его нет)');
  }
  // Склад «хранить отдельно» (владелец 02.10.2026): товар надо переложить
  // руками — задания грузчику; каждая переложенная штука сразу переходит.
  if (await separate.needsMove(client, t.company_id, t.from_vw, t.to_vw, t.quality || 'good')) {
    await separate.createTransferTasks(client, warehouseId, t);
    return (await client.query(
      `UPDATE vw_transfers SET status = 'to_move',
              decided_role = COALESCE(decided_role, $2), decided_by = COALESCE(decided_by, $3), decided_name = COALESCE(decided_name, $4),
              decided_at = COALESCE(decided_at, now())
        WHERE id = $1 RETURNING *`, [t.id, actor.role, actor.id || null, actor.name || null])).rows[0];
  }
  const cells = await moveRows(client, warehouseId, t);
  return (await client.query(
    `UPDATE vw_transfers SET status = 'done', done_at = now(), moved_cells = $2::jsonb,
            decided_role = COALESCE(decided_role, $3), decided_by = COALESCE(decided_by, $4), decided_name = COALESCE(decided_name, $5),
            decided_at = COALESCE(decided_at, now())
      WHERE id = $1 RETURNING *`,
    [t.id, JSON.stringify(cells), actor.role, actor.id || null, actor.name || null])).rows[0];
}

// Перенос. Склад (руководитель, менеджер) переносит сам — продавцу
// уведомление; если продавец отключил это право — заявка ждёт его согласия.
// Продавец переносить сам не может: заявка складу «очень важно» (вопрос 8).
async function transfer(client, { warehouseId, companyId, sku, qty, fromVw, toVw, note, actor }) {
  const company = await companyRow(client, warehouseId, companyId);
  const cleanSku = String(sku || '').trim();
  if (!cleanSku) throw new HttpError(400, 'Какой товар переносим?');
  const amount = requireQty(qty, 'Сколько переносим', { min: 1 });
  const from = await requireVw(client, companyId, fromVw);
  const to = await requireVw(client, companyId, toVw);
  if ((from ? from.id : null) === (to ? to.id : null)) throw new HttpError(400, 'Склад «откуда» и «куда» — один и тот же');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('vw-transfer:' || $1 || ':' || $2))", [companyId, cleanSku]);
  const free = (await transferable(client, companyId, cleanSku, from ? from.id : null)).free;
  if (free < amount) {
    throw new HttpError(409, `На складе «${from ? from.name : MAIN_NAME}» можно перенести только ${free} шт. этого товара`);
  }
  const name = await productName(client, companyId, cleanSku);
  const fromSeller = actor.role === 'seller';
  const rights = rightsOf(company);
  const status = fromSeller ? 'requested' : (rights.decide ? 'done' : 'waiting_seller');
  const number = await nextNumber(client, warehouseId, 'ПЕР', 'vw_transfers');
  let t = (await client.query(
    `INSERT INTO vw_transfers (warehouse_id, company_id, number, sku, name, qty, from_vw, to_vw, note, status,
                               requested_role, requested_by, requested_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
    [warehouseId, companyId, number, cleanSku, name, amount, from ? from.id : null, to ? to.id : null,
      cleanNote(note), status === 'done' ? 'waiting_seller' : status, actor.role, actor.id || null,
      actor.name || ACTOR_NAME[actor.role] || null])).rows[0];
  const rows = await list(client, companyId, { withArchived: true });
  const what = describe(t, rows);
  if (status === 'done') {
    t = await execute(client, warehouseId, t, actor);
    const byHand = t.status === 'to_move' ? ' Склад хранится отдельно — грузчик перекладывает товар, переложенное сразу на новом складе.' : '';
    await journal.createEntry(client, {
      warehouseId, agent: 'Кладовщик', status: 'auto',
      actionText: `Перенос ${number} у продавца «${company.name}»: ${what}.${t.note ? ` Комментарий: ${t.note}` : ''}${byHand}`,
      entityType: 'vw_transfer', entityId: t.id, actorType: actorType(actor.role), actorId: actor.id || null,
    });
    await notifySeller(client, { warehouseId, companyId, kind: 'ff_decided', entityId: t.id,
      text: `${actor.name || ACTOR_NAME[actor.role] || 'Склад'} перенёс ваш товар ${what}.${t.note ? ` Комментарий: ${dot(t.note)}` : ''}`
        + `${t.status === 'to_move' ? ' Остатки складов меняются по мере переноса.' : ''}${DECIDED_SELF}` });
  } else if (status === 'waiting_seller') {
    await journal.createEntry(client, {
      warehouseId, agent: 'Кладовщик', status: 'auto',
      actionText: `Перенос ${number} у продавца «${company.name}» ждёт его согласия: ${what}. Продавец отключил складу переносы без согласия.`,
      entityType: 'vw_transfer', entityId: t.id, actorType: actorType(actor.role), actorId: actor.id || null,
    });
    await notifySeller(client, { warehouseId, companyId, kind: 'vw_transfer_consent', entityId: t.id,
      text: `Склад просит перенести ваш товар ${what}. Согласитесь или откажите на странице «Товары».` });
  } else {
    // Заявка продавца — складу «очень важно», ждёт решения в журнале.
    await journal.createEntry(client, {
      warehouseId, agent: 'Кладовщик', status: 'pending', urgent: true,
      actionText: `Продавец «${company.name}» просит перенести ${what} (заявка ${number}).${t.note ? ` Комментарий: ${t.note}` : ''}`,
      entityType: 'vw_transfer', entityId: t.id, actorType: 'seller', actorId: actor.id || null,
    });
  }
  return { ...transferView(t, rows) };
}

const STATUS_NAME = {
  requested: 'ждёт склада', waiting_seller: 'ждёт согласия продавца', to_move: 'грузчик перекладывает',
  done: 'выполнен', rejected: 'отказано',
};
function transferView(t, rows) {
  return {
    id: t.id, number: t.number, sku: t.sku, name: t.name, qty: Number(t.qty),
    fromVw: t.from_vw, fromName: nameOf(rows, t.from_vw), toVw: t.to_vw, toName: nameOf(rows, t.to_vw),
    note: t.note, status: t.status, statusName: STATUS_NAME[t.status],
    requestedRole: t.requested_role, requestedName: t.requested_name, requestedAt: t.requested_at,
    decidedName: t.decided_name, decidedAt: t.decided_at, rejectReason: t.reject_reason, doneAt: t.done_at,
  };
}

async function listTransfers(client, companyId, { open = false, limit = 200 } = {}) {
  const rows = await list(client, companyId, { withArchived: true });
  return (await client.query(
    `SELECT * FROM vw_transfers WHERE company_id = $1
        AND (NOT $2 OR status IN ('requested', 'waiting_seller', 'to_move'))
      ORDER BY requested_at DESC LIMIT $3`, [companyId, open, limit])).rows.map((t) => transferView(t, rows));
}

// Ответ на заявку: склад — на заявку продавца, продавец — на просьбу склада.
async function decide(client, { warehouseId, transferId, approve, reason, actor }) {
  if (!UUID.test(String(transferId || ''))) throw new HttpError(404, 'Перенос не найден');
  const t = (await client.query(
    'SELECT * FROM vw_transfers WHERE id = $1 AND warehouse_id = $2 FOR UPDATE', [transferId, warehouseId])).rows[0];
  if (!t || (actor.role === 'seller' && t.company_id !== actor.companyId)) throw new HttpError(404, 'Перенос не найден');
  const sellerTurn = t.status === 'waiting_seller';
  if (t.status !== 'requested' && !sellerTurn) throw new HttpError(409, `Перенос ${t.number} уже ${STATUS_NAME[t.status]}`);
  if (sellerTurn !== (actor.role === 'seller')) {
    throw new HttpError(403, sellerTurn ? 'Этот перенос ждёт согласия продавца' : 'Заявку продавца выполняет склад');
  }
  const company = await companyRow(client, warehouseId, t.company_id);
  const rows = await list(client, t.company_id, { withArchived: true });
  const what = describe(t, rows);
  const who = actor.name || ACTOR_NAME[actor.role] || 'Склад';
  let done;
  if (approve) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('vw-transfer:' || $1 || ':' || $2))", [t.company_id, t.sku]);
    await client.query(
      'UPDATE vw_transfers SET decided_role = $2, decided_by = $3, decided_name = $4, decided_at = now() WHERE id = $1',
      [t.id, actor.role, actor.id || null, who]);
    done = await execute(client, warehouseId, { ...t }, actor);
  } else {
    done = (await client.query(
      `UPDATE vw_transfers SET status = 'rejected', decided_role = $2, decided_by = $3, decided_name = $4,
              decided_at = now(), reject_reason = $5 WHERE id = $1 RETURNING *`,
      [t.id, actor.role, actor.id || null, who, cleanNote(reason)])).rows[0];
  }
  const verdict = !approve ? `отказано${done.reject_reason ? ` (${done.reject_reason})` : ''}`
    : done.status === 'to_move' ? 'выполняется — остатки складов меняются по мере переноса' : 'выполнен';
  const text = `Перенос ${t.number} продавца «${company.name}» ${what} — ${verdict}. Решил: ${who}.`;
  // Заявка продавца висела «очень важно» в журнале — закрываем ответом.
  const pending = (await client.query(
    `SELECT id FROM journal_entries je WHERE je.warehouse_id = $1 AND je.entity_type = 'vw_transfer' AND je.entity_id = $2
        AND je.status = 'pending' AND NOT EXISTS (SELECT 1 FROM journal_entries a WHERE a.related_entry_id = je.id)`,
    [warehouseId, t.id])).rows[0];
  if (pending) {
    await journal.resolveEntry(client, {
      warehouseId, originalEntryId: pending.id, resolution: approve ? 'confirm' : 'rollback', note: text,
      resolvedByOwnerId: actor.role === 'owner' ? actor.id : null,
      actorType: actorType(actor.role), actorId: actor.id || null,
    });
  } else {
    await journal.createEntry(client, {
      warehouseId, agent: 'Кладовщик', status: 'auto', actionText: text,
      entityType: 'vw_transfer', entityId: t.id, actorType: actorType(actor.role), actorId: actor.id || null,
    });
  }
  if (actor.role !== 'seller') {
    await notifySeller(client, { warehouseId, companyId: t.company_id, kind: approve ? 'vw_request_done' : 'vw_transfer_rejected',
      entityId: t.id, text: `Ваша заявка ${t.number}: ${what} — ${verdict}.` });
  }
  return transferView(done, rows);
}

async function setRights(client, { warehouseId, companyId, rights }) {
  const company = await companyRow(client, warehouseId, companyId);
  const next = { ...(company.ff_rights || {}) };
  for (const [k, v] of Object.entries(rights || {})) {
    if (!Object.prototype.hasOwnProperty.call(RIGHTS, k)) throw new HttpError(400, 'Такого права нет');
    if (typeof v !== 'boolean') throw new HttpError(400, 'Право включают или выключают');
    next[k] = v;
  }
  await client.query('UPDATE companies SET ff_rights = $2::jsonb WHERE id = $1', [companyId, JSON.stringify(next)]);
  const changed = Object.keys(rights || {}).map((k) => `${next[k] ? 'разрешил' : 'запретил'} складу ${RIGHTS[k]}`);
  if (changed.length) {
    await journal.createEntry(client, {
      warehouseId, agent: 'Кладовщик', status: 'auto',
      actionText: `Продавец «${company.name}» ${changed.join('; ')}.`,
      entityType: 'company', entityId: companyId, actorType: 'seller',
    });
  }
  return rightsOf({ ff_rights: next });
}

async function notifications(client, companyId, { limit = 50 } = {}) {
  return (await client.query(
    `SELECT id, kind, text, entity_id, created_at, seen_at FROM seller_notifications WHERE company_id = $1
      ORDER BY created_at DESC LIMIT $2`, [companyId, limit])).rows.map((n) => ({
    id: n.id, kind: n.kind, text: n.text, entityId: n.entity_id, at: n.created_at, unseen: !n.seen_at,
  }));
}

// ids — только эти (кнопка «Понятно» у своего блока); без них — все.
async function markSeen(client, companyId, ids = null) {
  return (await client.query(
    `UPDATE seller_notifications SET seen_at = now() WHERE company_id = $1 AND seen_at IS NULL
        AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))`, [companyId, ids])).rowCount;
}

// Заказ ушёл из поставки (убрали, разобрали поставку): склад его строк
// снимается — у заказа вне поставки склада нет, он появится со следующей
// поставкой. Строки, по которым уже отбирали, остаются со своим складом:
// взятое с полки числится за ним. Отгрузки из 1С и заказы физлицам склад
// держат свой — его выбрали в самом заказе.
async function releaseOrders(client, warehouseId, invoiceIds) {
  if (!invoiceIds || !invoiceIds.length) return;
  await client.query(
    `UPDATE invoice_items ii SET virtual_warehouse_id = NULL
      WHERE ii.warehouse_id = $1 AND ii.invoice_id = ANY($2::uuid[]) AND ii.virtual_warehouse_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM shipping_records sr WHERE sr.invoice_item_id = ii.id)
        AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = ii.invoice_id AND i.source NOT IN ('1c', 'direct'))`,
    [warehouseId, invoiceIds]);
}

// Склад поставки — на все строки её заказов: грузчик собирает строку только
// с этого склада (вопрос 3). Заказ, который уже собирали с другого склада, в
// поставку с другого склада не берём: взятое числится за прежним складом.
async function assignOrders(client, warehouseId, invoiceIds, vwId) {
  const mixed = (await client.query(
    `SELECT i.number FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
      WHERE ii.warehouse_id = $1 AND ii.invoice_id = ANY($2::uuid[])
        AND ii.virtual_warehouse_id IS DISTINCT FROM $3::uuid
        AND EXISTS (SELECT 1 FROM shipping_records sr WHERE sr.invoice_item_id = ii.id)
      LIMIT 1`, [warehouseId, invoiceIds, vwId])).rows[0];
  if (mixed) throw new HttpError(409, `Заказ «${mixed.number}» уже собирали с другого склада — его поставка только с того же склада`);
  await client.query(
    `UPDATE invoice_items SET virtual_warehouse_id = $3 WHERE warehouse_id = $1 AND invoice_id = ANY($2::uuid[])`,
    [warehouseId, invoiceIds, vwId]);
}

// Раскладка пересчитанного количества по складам (вопрос 13, владелец
// 02.10.2026). parts — сколько числилось на каждом складе ([{ vw, qty }],
// vw null — «Основной»), counted — сколько насчитали. Излишек — на
// «Основной» (чей он — неизвестно); недостача — сначала с «Основного», потом
// с самого большого склада. Возвращает итог по складам и что списано.
// home — чья это ячейка: зона склада или ячейка склада «хранить отдельно»;
// лишнее записывается на него, иначе — на «Остальной товар» (проверка
// 03.10.2026: лишнее «Остального товара» в зоне «Озона» ломало зону).
function allocateCount(parts, counted, home = null) {
  const rows = parts.map((p) => ({ vw: p.vw || null, qty: Number(p.qty) })).filter((p) => p.qty > 0);
  const total = rows.reduce((n, p) => n + p.qty, 0);
  const cut = [];
  if (counted >= total) {
    if (counted > total) {
      const to = rows.find((p) => p.vw === (home || null));
      if (to) to.qty += counted - total; else rows.push({ vw: home || null, qty: counted - total });
    }
    return { result: rows, cut, surplus: counted - total };
  }
  let short = total - counted;
  while (short > 0) {
    const main = rows.find((p) => p.vw === null && p.qty > 0);
    const from = main || rows.filter((p) => p.qty > 0).sort((a, b) => b.qty - a.qty)[0];
    const n = main ? Math.min(main.qty, short) : Math.min(from.qty, short);
    from.qty -= n;
    short -= n;
    const c = cut.find((x) => x.vw === from.vw);
    if (c) c.qty += n; else cut.push({ vw: from.vw, qty: n });
  }
  return { result: rows.filter((p) => p.qty > 0), cut, surplus: 0 };
}

// Склад у строк документа до начала работы (схема 02.10.2026): привоз из
// 1С и заведённый складом идут на «Основной», руководитель может поменять;
// так же — отгрузка из 1С и возврат. Начатое не трогаем: принятое и взятое
// уже числится за своим складом. Строки заказа в поставке берут склад
// поставки — его меняют у поставки.
async function setItemsVw(client, { warehouseId, itemIds, vwId, actor }) {
  if (!Array.isArray(itemIds) || !itemIds.length || itemIds.length > 500 || !itemIds.every((id) => UUID.test(String(id)))) {
    throw new HttpError(400, 'Укажите строки документа');
  }
  const rows = (await client.query(
    `SELECT ii.id, ii.company_id, ii.sku, ii.name, ii.virtual_warehouse_id, i.number, i.direction, i.status,
            i.supply_id, i.source, i.source_document_type,
            (EXISTS (SELECT 1 FROM receiving_records r WHERE r.invoice_item_id = ii.id)
             OR EXISTS (SELECT 1 FROM shipping_records r WHERE r.invoice_item_id = ii.id)
             OR EXISTS (SELECT 1 FROM return_records r WHERE r.invoice_item_id = ii.id)) AS started
       FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
      WHERE ii.warehouse_id = $1 AND ii.id = ANY($2::uuid[]) FOR UPDATE OF ii`, [warehouseId, itemIds])).rows;
  if (rows.length !== new Set(itemIds).size) throw new HttpError(404, 'Часть строк не найдена');
  const companies = [...new Set(rows.map((r) => r.company_id))];
  if (companies.length > 1) throw new HttpError(400, 'Строки разных продавцов');
  const company = await companyRow(client, warehouseId, companies[0]);
  // Поменять склад у строки без продавца — то же, что перенести его товар
  // между складами (право «решать без продавца», владелец 02.10.2026).
  if (!rightsOf(company).decide) {
    throw new HttpError(409, `Продавец «${company.name}» запретил складу решать без него, на каком складе его товар. `
      + (rows.some((r) => r.source_document_type === 'seller_inbound')
        ? 'Склад у строк своего привоза он меняет сам — изменив привоз.'
        : 'Строка останется на своём складе; перенести товар можно с согласия продавца.'));
  }
  for (const r of rows) {
    if (r.started) throw new HttpError(409, `По «${r.name}» в ${r.number} уже работали — склад строки поменять нельзя`);
    if (!['open', 'in_progress'].includes(r.status)) throw new HttpError(409, `Документ ${r.number} уже закрыт`);
    if (r.supply_id) throw new HttpError(409, `Заказ ${r.number} в поставке — склад меняют у поставки`);
    if (r.direction === 'out' && ['wb', 'ozon', 'yandex'].includes(r.source)) {
      throw new HttpError(409, `У заказа ${r.number} с площадки склада нет — он появится с поставкой`);
    }
  }
  const vw = await requireVw(client, company.id, vwId);
  await client.query('UPDATE invoice_items SET virtual_warehouse_id = $2 WHERE id = ANY($1::uuid[])', [itemIds, vw ? vw.id : null]);
  const docs = [...new Set(rows.map((r) => r.number))];
  const text = `Склад у ${rows.length} ${rows.length === 1 ? 'строки' : 'строк'} документа ${docs.join(', ')} продавца «${company.name}» — `
    + `«${vw ? vw.name : MAIN_NAME}»: ${rows.slice(0, 5).map((r) => `«${r.name || r.sku}»`).join(', ')}${rows.length > 5 ? ' и другие' : ''}.`;
  await journal.createEntry(client, {
    warehouseId, agent: 'Кладовщик', status: 'auto', actionText: text,
    entityType: 'virtual_warehouse', entityId: vw ? vw.id : null, actorType: actorType(actor.role), actorId: actor.id || null,
  });
  return { updated: rows.length, vw: vw ? vw.id : null };
}

// ---------- Спорные ситуации с количеством (владелец 02.10.2026) ----------
// Пересчёт нашёл меньше или больше, приняли не столько, сколько заявили на
// разные склады, брак с полки, где лежит товар разных складов. Учёт сразу
// записывается по правилу склада — полки должны быть правдой. Право
// «решать без продавца» есть — продавцу заметное уведомление; продавец его
// запретил — решение ждёт продавца: он соглашается или делит по-своему, и
// разница переносится между его складами.
//
// parts: [{ vw, before, value, min, max }]. Для пересчёта и приёмки value —
// сколько стало на складе (по правилу), для брака — сколько брака записано
// на склад; min/max — пределы, в которых продавец может поменять.
const DECISION_KINDS = ['inventory', 'receiving', 'defect'];

const dot = (t) => (t.endsWith('.') ? t : `${t}.`);

function howText(kind, parts, rows) {
  const n = (x) => `«${nameOf(rows, x.vw)}»`;
  if (kind === 'receiving') {
    return 'принято: ' + parts.map((x) => `${n(x)} — ${x.value} из ${x.before} шт.`).join(', ');
  }
  if (kind === 'defect') {
    return 'брак записан: ' + parts.filter((x) => x.value > 0).map((x) => `${n(x)} — ${x.value} шт.`).join(', ');
  }
  const cut = parts.filter((x) => x.value < x.before).map((x) => `${n(x)} — ${x.before - x.value} шт.`);
  const add = parts.filter((x) => x.value > x.before).map((x) => `${n(x)} — ${x.value - x.before} шт.`);
  return [cut.length ? 'списано: ' + cut.join(', ') : '', add.length ? 'записано: ' + add.join(', ') : '']
    .filter(Boolean).join('; ');
}

// sellerTitle — то же для продавца, без ячеек: как лежит товар, продавцу
// знать не нужно (владелец 03.10.2026); title — складу, с адресом.
async function splitSituation(client, { warehouseId, companyId, kind, sku, name, quality = 'good', title, sellerTitle, parts }) {
  const st = sellerTitle || title;
  const end = /[.!?]$/.test(st) ? ' ' : '. ';
  const company = await companyRow(client, warehouseId, companyId);
  const rows = await list(client, companyId, { withArchived: true });
  if (!rows.length) return null;
  const clean = parts.map((x) => ({
    vw: x.vw || null, before: Number(x.before), value: Number(x.value), min: Number(x.min), max: Number(x.max),
  }));
  const how = howText(kind, clean, rows);
  if (rightsOf(company).decide) {
    // Продавцу не пишем (владелец 06.10.2026) — след остаётся в журнале склада.
    await journal.createEntry(client, {
      warehouseId, agent: 'Кладовщик', status: 'auto',
      actionText: `${title} (продавец «${company.name}»). Записано по правилу склада — ${dot(how)}`,
      entityType: 'company', entityId: companyId, actorType: 'system',
    });
    return null;
  }
  const d = (await client.query(
    `INSERT INTO vw_decisions (warehouse_id, company_id, kind, sku, name, quality, title, parts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING id`,
    [warehouseId, companyId, kind, sku, name || sku, quality, st.slice(0, 500), JSON.stringify(clean)])).rows[0];
  await notifySeller(client, { warehouseId, companyId, kind: 'vw_decision', entityId: d.id,
    text: `${st}${end}Пока учёт записан по правилу склада — ${dot(how)} Вы запретили складу решать такое без вас: согласитесь или разделите по-своему на странице «Товары».` });
  await journal.createEntry(client, {
    warehouseId, agent: 'Кладовщик', status: 'auto',
    actionText: `${title} (продавец «${company.name}»). Учёт записан по правилу — ${dot(how)} Продавец запретил складу решать такое без него — решение за ним.`,
    entityType: 'vw_decision', entityId: d.id, actorType: 'system',
  });
  return d.id;
}

function decisionView(d, rows) {
  return {
    id: d.id, kind: d.kind, sku: d.sku, name: d.name, quality: d.quality, title: d.title, status: d.status,
    parts: (d.parts || []).map((x) => ({ ...x, name: nameOf(rows, x.vw) })),
    chosen: d.chosen, transfers: d.transfers, createdAt: d.created_at, decidedAt: d.decided_at,
  };
}

async function listDecisions(client, companyId, { open = false, limit = 100 } = {}) {
  const rows = await list(client, companyId, { withArchived: true });
  return (await client.query(
    `SELECT * FROM vw_decisions WHERE company_id = $1 AND (NOT $2 OR status = 'pending')
      ORDER BY created_at DESC LIMIT $3`, [companyId, open, limit])).rows.map((d) => decisionView(d, rows));
}

// Перенос по решению продавца: сразу выполнен, со своим номером.
async function retag(client, warehouseId, { companyId, sku, name, fromVw, toVw, qty, quality, note, actor }) {
  // Оба склада должны быть живыми: на убранный товар не записываем.
  await requireVw(client, companyId, fromVw);
  await requireVw(client, companyId, toVw);
  if (quality === 'good') {
    const free = (await transferable(client, companyId, sku, fromVw)).free;
    if (free < qty) {
      throw new HttpError(409, `На складе «${nameOf(await list(client, companyId, { withArchived: true }), fromVw)}» свободно только ${free} шт. `
        + 'этого товара — остальное уже в поставках. Разделите иначе.');
    }
  }
  const number = await nextNumber(client, warehouseId, 'ПЕР', 'vw_transfers');
  const byHand = await separate.needsMove(client, companyId, fromVw, toVw, quality);
  const t = (await client.query(
    `INSERT INTO vw_transfers (warehouse_id, company_id, number, sku, name, qty, from_vw, to_vw, note, status, quality,
                               requested_role, requested_by, requested_name, decided_role, decided_by, decided_name, decided_at, done_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $14, $10, $11, $12, $13, $11, $12, $13, now(),
             CASE WHEN $14 = 'done' THEN now() END) RETURNING *`,
    [warehouseId, companyId, number, sku, name, qty, fromVw, toVw, note, quality, actor.role, actor.id || null,
      actor.name || ACTOR_NAME[actor.role] || null, byHand ? 'to_move' : 'done'])).rows[0];
  // Склад «хранить отдельно» — переложить руками (задания грузчику).
  if (byHand) {
    await separate.createTransferTasks(client, warehouseId, t);
    return number;
  }
  const cells = await moveRows(client, warehouseId, t);
  await client.query('UPDATE vw_transfers SET moved_cells = $2::jsonb WHERE id = $1', [t.id, JSON.stringify(cells)]);
  return number;
}

// Пары «откуда → куда»: кто отдаёт и кто получает, жадно.
function pairs(givers, takers) {
  const out = [];
  const g = givers.map((x) => ({ ...x })); const t = takers.map((x) => ({ ...x }));
  let i = 0; let j = 0;
  while (i < g.length && j < t.length) {
    const q = Math.min(g[i].qty, t[j].qty);
    out.push({ from: g[i].vw, to: t[j].vw, qty: q });
    g[i].qty -= q; t[j].qty -= q;
    if (!g[i].qty) i += 1;
    if (!t[j].qty) j += 1;
  }
  return out;
}

async function resolveDecision(client, { warehouseId, decisionId, chosen, confirm, actor }) {
  if (!UUID.test(String(decisionId || ''))) throw new HttpError(404, 'Решение не найдено');
  const d = (await client.query('SELECT * FROM vw_decisions WHERE id = $1 AND warehouse_id = $2 FOR UPDATE',
    [decisionId, warehouseId])).rows[0];
  if (!d || d.company_id !== actor.companyId) throw new HttpError(404, 'Решение не найдено');
  if (d.status !== 'pending') throw new HttpError(409, 'По этому случаю вы уже решили');
  const rows = await list(client, d.company_id, { withArchived: true });
  const parts = d.parts.map((x) => ({ ...x, vw: x.vw || null }));
  const key = (vw) => vw || '';
  let status = 'confirmed';
  let picked = parts.map((x) => ({ vw: x.vw, qty: x.value }));
  const numbers = [];
  if (!confirm) {
    if (!Array.isArray(chosen)) throw new HttpError(400, 'Укажите, сколько на каждом складе');
    const byVw = new Map(chosen.map((c) => [key(c.vw), c.qty]));
    picked = parts.map((x) => {
      const q = byVw.has(key(x.vw)) ? Number(byVw.get(key(x.vw))) : x.value;
      if (!Number.isInteger(q) || q < x.min || q > x.max) {
        throw new HttpError(400, `«${nameOf(rows, x.vw)}»: можно от ${x.min} до ${x.max} шт.`);
      }
      return { vw: x.vw, qty: q };
    });
    const total = parts.reduce((n, x) => n + x.value, 0);
    const sum = picked.reduce((n, x) => n + x.qty, 0);
    if (sum !== total) throw new HttpError(400, `Всего должно получиться ${total} шт., а сейчас ${sum}`);
    const diff = parts.map((x, k) => ({ vw: x.vw, d: picked[k].qty - x.value }));
    const up = diff.filter((x) => x.d > 0).map((x) => ({ vw: x.vw, qty: x.d }));
    const down = diff.filter((x) => x.d < 0).map((x) => ({ vw: x.vw, qty: -x.d }));
    if (up.length) {
      status = 'changed';
      const note = `Решение продавца: ${d.title}`.slice(0, 300);
      const one = (from, to, qty, quality) => retag(client, warehouseId, {
        companyId: d.company_id, sku: d.sku, name: d.name, fromVw: from, toVw: to, qty, quality, note, actor,
      });
      if (d.kind === 'defect') {
        // Больше брака на склад — у него меньше годного: годное уходит туда,
        // где брака стало меньше, а брак — обратно.
        for (const m of pairs(up, down)) {
          numbers.push(await one(m.from, m.to, m.qty, 'good'));
          numbers.push(await one(m.to, m.from, m.qty, d.quality));
        }
      } else {
        for (const m of pairs(down, up)) numbers.push(await one(m.from, m.to, m.qty, d.quality));
      }
    }
  }
  await client.query(
    `UPDATE vw_decisions SET status = $2, chosen = $3::jsonb, transfers = $4::jsonb, decided_at = now(), decided_by = $5
      WHERE id = $1`, [d.id, status, JSON.stringify(picked), JSON.stringify(numbers), actor.id || null]);
  const company = await companyRow(client, warehouseId, d.company_id);
  const how = howText(d.kind, parts.map((x, k) => ({ ...x, value: picked[k].qty })), rows);
  await journal.createEntry(client, {
    warehouseId, agent: 'Кладовщик', status: 'auto',
    actionText: `Продавец «${company.name}» ${status === 'changed' ? 'решил по-своему' : 'согласился'}: ${d.title} — ${dot(how)}`
      + (numbers.length ? ` Переносы ${numbers.join(', ')}.` : ''),
    entityType: 'vw_decision', entityId: d.id, actorType: 'seller', actorId: actor.id || null,
  });
  const done = (await client.query('SELECT * FROM vw_decisions WHERE id = $1', [d.id])).rows[0];
  return decisionView(done, rows);
}

// Приход принят: товар одной позиции заявлен на разные склады продавца, а
// принят не столько, сколько заявлено, — какой склад получил меньше (или
// больше), решил склад, разложив принятое по строкам.
async function receivingSplits(client, { warehouseId, invoiceId }) {
  const inv = (await client.query('SELECT id, number, company_id FROM invoices WHERE id = $1', [invoiceId])).rows[0];
  if (!inv || !inv.company_id) return;
  const lines = (await client.query(
    `SELECT ii.sku, MAX(ii.name) AS name, ii.virtual_warehouse_id AS vw, SUM(ii.declared_qty)::int AS declared,
            SUM(COALESCE((SELECT SUM(rr.accepted_qty) FROM receiving_records rr WHERE rr.invoice_item_id = ii.id), 0))::int AS accepted
       FROM invoice_items ii WHERE ii.invoice_id = $1
      GROUP BY ii.sku, ii.virtual_warehouse_id ORDER BY ii.sku`, [invoiceId])).rows;
  const bySku = new Map();
  for (const l of lines) bySku.set(l.sku, (bySku.get(l.sku) || []).concat(l));
  for (const [sku, group] of bySku) {
    if (group.length < 2) continue;
    const declared = group.reduce((n, l) => n + l.declared, 0);
    const accepted = group.reduce((n, l) => n + l.accepted, 0);
    if (declared === accepted) continue;
    const short = accepted < declared;
    await splitSituation(client, {
      warehouseId, companyId: inv.company_id, kind: 'receiving', sku, name: group[0].name,
      title: `Приход ${inv.number}: «${group[0].name || sku}» — заявлено ${declared} шт., принято ${accepted} шт.`,
      parts: group.map((l) => ({
        vw: l.vw, before: l.declared, value: l.accepted,
        min: short ? 0 : Math.min(l.declared, l.accepted),
        max: short ? Math.max(l.declared, l.accepted) : accepted,
      })),
    });
  }
}

module.exports = {
  DECISION_KINDS, splitSituation, listDecisions, resolveDecision, receivingSplits,
  setItemsVw,
  allocateCount,
  releaseOrders, assignOrders,
  MAIN_NAME, MARKETPLACES, RIGHTS, list, requireVw, wbChoices, create, update, archive,
  transferable, transfer, decide, listTransfers, setRights, rightsOf, companyRow, notifySeller,
  notifications, markSeen, nameOf,
};
