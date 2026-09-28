const { blockLabelSql } = require('../cells/label');
const { categoryOf, CATEGORIES } = require('./category');

// Append-only by construction: this module exports no update/delete
// function, the DB grants for the argus_app role REVOKE UPDATE/DELETE on
// journal_entries (see setup-app-role.sql), and confirm()/rollback() below
// both work by INSERTing a new row that points back at the original via
// related_entry_id/root_entry_id — the original row is never touched.

// root_entry_id is left NULL for a freshly created entry — NULL means
// "this row is its own root" everywhere in this module, specifically so
// that creating an entry never needs an UPDATE (argus_app has no UPDATE
// grant on this table at all, see setup-app-role.sql — insert-only is
// enforced by Postgres, not just by this file not exporting an update fn).
async function createEntry(client, {
  warehouseId, agent, actionText, entityType = null, entityId = null,
  actorType, actorId = null, status = 'auto',
  // Документ и место события. Необязательны — но без них запись остаётся
  // текстом, из которого никуда нельзя перейти.
  invoiceId = null, cellBlockId = null,
  // «Очень важно»: отметка, по которой стоит работа (грузчик не нашёл товар).
  urgent = false,
}) {
  const result = await client.query(
    `INSERT INTO journal_entries
       (warehouse_id, agent, action_text, entity_type, entity_id, actor_type, actor_id,
        status, invoice_id, cell_block_id, urgent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [warehouseId, agent, actionText, entityType, entityId, actorType, actorId, status,
      invoiceId, cellBlockId, urgent === true],
  );
  return result.rows[0];
}

// cellBlockId / invoiceId — обратный ход: «что происходило в этой ячейке» и
// «что происходило с этой накладной». Из записи уже можно уйти к месту и к
// документу; отсюда можно вернуться и посмотреть всю их историю.
//
// answered — есть ли уже ответ (запись с related_entry_id на эту). Решение
// не меняет исходную запись — журнал только дописывается, — и без этого
// признака кабинет держал уже решённое «ждёт решения» навсегда.
//
// hideUrgent — менеджеру без права «отметки о нехватке» срочные отметки не
// показываются. Неотвеченные срочные попадают в ленту всегда, даже старше
// двухсот последних записей: по ним стоит поставка.
async function listEntries(client, warehouseId, {
  limit = 200, cellBlockId = null, invoiceId = null, hideUrgent = false,
} = {}) {
  // Номер накладной и адрес ячейки собираем здесь, а не на клиенте: иначе
  // кабинету пришлось бы держать в памяти всю карту склада только ради подписи.
  const result = await client.query(
    `SELECT je.*,
            EXISTS (SELECT 1 FROM journal_entries a WHERE a.related_entry_id = je.id) AS answered,
            i.number AS invoice_number,
            i.direction AS invoice_direction,
            -- Документ, на который запись ссылается как на сущность («отменил
            -- привоз» пишется без invoice_id) — для категории (journal/category.js).
            ei.direction AS entity_direction,
            -- Кто именно работал: в кабинете работа грузчика — одна строка с
            -- его именем, а не «Кладовщик» на каждый товар.
            sk.name AS actor_name,
            -- Заказ сейчас в поставке? Тогда у отметки «нет товара» есть
            -- решение «убрать заказ из поставки», а вся сборка этой поставки
            -- собирается в кабинете в одну запись вместо строки на каждый товар.
            i.supply_id AS invoice_supply_id,
            s.number AS invoice_supply_number,
            -- «ряд.стеллаж.ярус», как на карте склада (см. cells/label.js).
            CASE WHEN cb.id IS NULL THEN NULL ELSE ${blockLabelSql('cb', 'wr')} END AS cell_label,
            -- Чья это работа (третье задание 27.09.2026): всё, что грузчик
            -- сделал по одному приходу или одной поставке, — и ответы
            -- руководителя на его записи — кабинет собирает в одну строку.
            -- «supply:…» — сборка поставки (у заказов поставки и у записей
            -- самого захода), «in:…» — приёмка прихода, «return:…»/«out:…» —
            -- возврат и заказ без поставки.
            CASE WHEN COALESCE(o.actor_type, je.actor_type) <> 'worker' THEN NULL
                 WHEN COALESCE(wsup.id, wi.supply_id) IS NOT NULL THEN 'supply:' || COALESCE(wsup.id, wi.supply_id)
                 WHEN wi.id IS NOT NULL THEN wi.direction || ':' || wi.id END AS work_key
     FROM journal_entries je
     LEFT JOIN invoices i ON i.id = je.invoice_id
     LEFT JOIN invoices ei ON je.entity_type = 'invoice' AND ei.id = je.entity_id
     LEFT JOIN supplies s ON s.id = i.supply_id
     LEFT JOIN journal_entries o ON o.id = je.related_entry_id
     LEFT JOIN invoices wi ON wi.id = COALESCE(je.invoice_id, o.invoice_id)
     LEFT JOIN supplies wsup ON wsup.warehouse_id = je.warehouse_id
      AND COALESCE(je.invoice_id, o.invoice_id) IS NULL
      AND COALESCE(o.entity_type, je.entity_type) IN ('supply_assembly', 'paper_pick', 'worker_pause')
      AND wsup.id = COALESCE(o.entity_id, je.entity_id)
     LEFT JOIN staff_keys sk ON sk.id = je.actor_id AND je.actor_type IN ('worker', 'manager')
     LEFT JOIN cell_blocks cb ON cb.id = je.cell_block_id
     LEFT JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
     WHERE je.warehouse_id = $1
       AND ($3::uuid IS NULL OR je.cell_block_id = $3::uuid)
       AND ($4::uuid IS NULL OR je.invoice_id = $4::uuid)
       AND ($5::boolean IS NOT TRUE OR NOT je.urgent)
       AND (je.id IN (SELECT j2.id FROM journal_entries j2
                       WHERE j2.warehouse_id = $1
                         AND ($3::uuid IS NULL OR j2.cell_block_id = $3::uuid)
                         AND ($4::uuid IS NULL OR j2.invoice_id = $4::uuid)
                         AND ($5::boolean IS NOT TRUE OR NOT j2.urgent)
                       ORDER BY j2.created_at DESC LIMIT $2)
            OR (je.urgent AND je.status = 'pending'
                AND NOT EXISTS (SELECT 1 FROM journal_entries a2 WHERE a2.related_entry_id = je.id)))
       -- История ячейки — за последний год: трёхлетний хвост никому не
       -- нужен на экране (владелец 26.09.2026).
       AND ($3::uuid IS NULL OR je.created_at > now() - interval '${CELL_HISTORY}')
     -- Записи одной транзакции до 27.09.2026 имели одно время (now()); из
     -- них «закончил приёмку» — последний шаг работы, а не первый.
     ORDER BY je.created_at DESC,
              (je.entity_type IN ('receiving_session', 'supply_assembly', 'paper_pick')) DESC`,
    [warehouseId, limit, cellBlockId, invoiceId, hideUrgent === true],
  );
  if (!cellBlockId) return withCategory(result.rows);
  const ops = await cellOperations(client, warehouseId, cellBlockId);
  return withCategory([...result.rows, ...ops]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit));
}

const CATEGORY_LABEL = new Map(CATEGORIES);
function withCategory(rows) {
  rows.forEach((row) => {
    row.category = categoryOf(row);
    row.category_label = CATEGORY_LABEL.get(row.category);
  });
  return rows;
}

const CELL_HISTORY = '1 year';

// Движения, которые журнал не привязывает к ячейке: загрузка остатков пишет
// одну запись на весь файл, сборка набора — без места, перестановка —
// только на ячейку, куда положили. Без них «Что здесь происходило» молчало
// о том, откуда в ячейке товар и куда он ушёл. Показываем их в истории
// ячейки такими же строками, как записи журнала.
async function cellOperations(client, warehouseId, cellBlockId) {
  const r = await client.query(
    `SELECT op.id, op.kind, op.sku, op.qty, op.created_at, op.worker_key_id,
            op.from_cell_block_id, op.to_cell_block_id,
            p.name, sk.name AS actor_name,
            ${blockLabelSql('cb', 'wr')} AS to_label
       FROM stock_operations op
       LEFT JOIN products p ON p.warehouse_id = op.warehouse_id AND p.company_id = op.company_id AND p.sku = op.sku
       LEFT JOIN staff_keys sk ON sk.id = op.worker_key_id
       LEFT JOIN cell_blocks cb ON cb.id = op.to_cell_block_id
       LEFT JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
      WHERE op.warehouse_id = $1
        AND op.created_at > now() - interval '${CELL_HISTORY}'
        AND ((op.kind IN ('initial_load', 'kit_assemble') AND op.to_cell_block_id = $2)
          OR (op.kind = 'initial_load_undo' AND op.from_cell_block_id = $2)
          OR (op.kind IN ('move', 'repack') AND op.from_cell_block_id = $2
              AND op.to_cell_block_id IS DISTINCT FROM $2))
      ORDER BY op.created_at DESC LIMIT 200`,
    [warehouseId, cellBlockId],
  );
  const qty = (n) => `${Number(n)} шт.`;
  // Приёмка в несколько ячеек: запись журнала о позиции ведёт на ячейку
  // первой укладки, а в остальные товар тоже лёг — и их история должна это
  // показывать (владелец 27.09.2026, третье задание).
  const placed = await client.query(
    `SELECT rp.id, rp.qty, rp.placed_at, rp.placed_by, rp.sku, ii.name, i.id AS invoice_id, i.number,
            rr.accepted_qty, sk.name AS actor_name,
            (SELECT count(*)::int FROM receiving_placements x WHERE x.receiving_record_id = rp.receiving_record_id) AS cells
       FROM receiving_placements rp
       JOIN receiving_records rr ON rr.id = rp.receiving_record_id
       JOIN invoice_items ii ON ii.id = rp.invoice_item_id
       JOIN invoices i ON i.id = ii.invoice_id
       LEFT JOIN staff_keys sk ON sk.id = rp.placed_by
      WHERE rp.warehouse_id = $1 AND rp.cell_block_id = $2
        AND rr.cell_block_id IS DISTINCT FROM $2
        AND rp.placed_at > now() - interval '${CELL_HISTORY}'
      ORDER BY rp.placed_at DESC LIMIT 200`,
    [warehouseId, cellBlockId],
  );
  const placements = placed.rows.map((p) => ({
    id: `rp-${p.id}`,
    warehouse_id: warehouseId,
    agent: 'Кладовщик',
    action_text: `Приёмка «${p.number}»: положено ${qty(p.qty)} «${p.name}» (${p.sku}) — часть принятых `
      + `${qty(p.accepted_qty)}, разложенных по ${p.cells} ячейкам.`,
    entity_type: 'receiving_placement',
    entity_id: p.id,
    actor_type: p.placed_by ? 'worker' : 'owner',
    actor_id: p.placed_by,
    actor_name: p.actor_name,
    status: 'auto',
    urgent: false,
    answered: false,
    invoice_id: p.invoice_id,
    invoice_number: p.number,
    invoice_direction: 'in',
    cell_block_id: cellBlockId,
    created_at: p.placed_at,
  }));
  return placements.concat(r.rows.map((op) => {
    const what = `«${op.name || op.sku}» (${op.sku})`;
    const text = {
      initial_load: `Загрузка остатков: положено ${qty(op.qty)} ${what}.`,
      initial_load_undo: `Загрузка остатков отменена: снято ${qty(op.qty)} ${what}.`,
      kit_assemble: `Собран набор ${what} — ${qty(op.qty)}.`,
      move: `Переложено ${qty(op.qty)} ${what} в ячейку ${op.to_label || '—'}.`,
      repack: `Перепаковано ${qty(op.qty)} ${what}, положено в ячейку ${op.to_label || '—'}.`,
    }[op.kind];
    return {
      id: `op-${op.id}`,
      warehouse_id: warehouseId,
      agent: 'Кладовщик',
      action_text: text,
      entity_type: 'stock_operation',
      entity_id: op.id,
      actor_type: op.worker_key_id ? 'worker' : 'owner',
      actor_id: op.worker_key_id,
      actor_name: op.actor_name,
      status: 'auto',
      urgent: false,
      answered: false,
      cell_block_id: cellBlockId,
      created_at: op.created_at,
    };
  }));
}

// Сколько позиций поставки уже собрано. Кабинет показывает сборку поставки
// одной записью с полосой «собрано N из M», а не строкой на каждый товар:
// с поставки из сорока заказов владельцу падало сорок одинаковых уведомлений.
async function supplyPickProgress(client, warehouseId, supplyIds) {
  if (!supplyIds.length) return new Map();
  const result = await client.query(
    `SELECT i.supply_id,
            COUNT(ii.id)::int AS total,
            COUNT(ii.id) FILTER (WHERE EXISTS (
              SELECT 1 FROM shipping_records sr
               WHERE sr.invoice_item_id = ii.id AND sr.is_final
            ))::int AS done
       FROM invoices i
       JOIN invoice_items ii ON ii.invoice_id = i.id
      WHERE i.warehouse_id = $1 AND i.supply_id = ANY($2::uuid[])
      GROUP BY i.supply_id`,
    [warehouseId, supplyIds],
  );
  return new Map(result.rows.map((row) => [row.supply_id, row]));
}

// Состояние работ, на которые ссылаются записи журнала (work_key выше), —
// для строки «Джоник принимает ПР-… · принято 5 из 8» → «Джоник принял
// ПР-… · 8 из 8, расхождений нет». receiving и assembly — ход работы из
// work/sessions.js (receiving/session.js и shipping/assembly.js).
async function workStates(client, warehouseId, keys, { receiving, assembly }) {
  const ids = (prefix) => [...new Set(keys.filter((k) => k && k.startsWith(prefix)).map((k) => k.slice(prefix.length)))];
  const invoiceIds = ids('in:');
  const supplyIds = ids('supply:');
  const out = new Map();
  const workers = async (col, list) => new Map((await client.query(
    `SELECT ${col} AS id, array_agg(worker_name ORDER BY started_at) AS names FROM work_sessions
      WHERE warehouse_id = $1 AND ${col} = ANY($2::uuid[]) GROUP BY ${col}`, [warehouseId, list],
  )).rows.map((r) => [r.id, [...new Set(r.names)]]));
  const session = (a) => (a ? {
    status: a.status, workerName: a.workerName, startedAt: a.startedAt, pausedAt: a.pausedAt,
    pauseReason: a.pauseReason, endedAt: a.endedAt,
  } : null);
  if (invoiceIds.length) {
    const docs = await client.query(
      `SELECT i.id, i.number, i.status,
              count(*) FILTER (WHERE rr.id IS NOT NULL AND rr.accepted_qty <> ii.declared_qty)::int AS diffs
         FROM invoices i
         JOIN invoice_items ii ON ii.invoice_id = i.id
         LEFT JOIN receiving_records rr ON rr.invoice_item_id = ii.id
        WHERE i.warehouse_id = $1 AND i.id = ANY($2::uuid[])
        GROUP BY i.id`,
      [warehouseId, invoiceIds],
    );
    const st = await receiving.statesFor(client, warehouseId, invoiceIds);
    const names = await workers('invoice_id', invoiceIds);
    for (const d of docs.rows) {
      const w = st.get(d.id) || {};
      out.set(`in:${d.id}`, {
        kind: 'receiving', id: d.id, number: d.number, status: d.status, done: d.status === 'completed',
        taken: w.taken || 0, total: w.total || 0, diffs: d.diffs,
        session: session(w.assembly), workers: names.get(d.id) || [],
      });
    }
  }
  if (supplyIds.length) {
    const docs = await client.query(
      'SELECT id, number, status FROM supplies WHERE warehouse_id = $1 AND id = ANY($2::uuid[])', [warehouseId, supplyIds],
    );
    const st = await assembly.statesFor(client, warehouseId, supplyIds);
    const names = await workers('supply_id', supplyIds);
    for (const d of docs.rows) {
      const w = st.get(d.id) || {};
      out.set(`supply:${d.id}`, {
        kind: 'assembly', id: d.id, number: d.number, status: d.status, done: d.status !== 'collecting',
        taken: w.taken || 0, total: w.total || 0,
        session: session(w.assembly), workers: names.get(d.id) || [],
      });
    }
  }
  return out;
}

// Кто закрыл расхождение — владелец или менеджер. Журнал неизменяем и служит
// следом действий: записывать решение менеджера как решение владельца значит
// терять автора ровно там, где он и нужен — в споре о недостаче.
async function resolveEntry(client, {
  warehouseId, originalEntryId, resolution, resolvedByOwnerId, note,
  actorType = 'owner', actorId = null,
}) {
  const originalResult = await client.query(
    `SELECT * FROM journal_entries WHERE id = $1 AND warehouse_id = $2`,
    [originalEntryId, warehouseId],
  );
  const original = originalResult.rows[0];
  if (!original) return null;

  // 'ack' — «Принял к сведению» записку грузчика о товаре.
  const status = resolution === 'rollback' ? 'rolled_back' : 'confirmed';
  const who = actorType === 'manager' ? 'менеджером' : 'владельцем';
  const actionText = resolution === 'ack'
    ? `Принято к сведению ${who}: ${note || original.action_text}`
    : resolution === 'confirm'
      ? `Подтверждено ${who}: ${note || original.action_text}`
      : `Отклонено ${who}: ${note || original.action_text}`;

  const result = await client.query(
    `INSERT INTO journal_entries
       (warehouse_id, agent, action_text, entity_type, entity_id, actor_type, actor_id,
        status, root_entry_id, related_entry_id, resolved_at, resolved_by_owner_id)
     VALUES ($1, $2, $3, $4, $5, $10, $6, $7, $8, $9, now(), $11)
     RETURNING *`,
    [
      warehouseId, original.agent, actionText, original.entity_type, original.entity_id,
      actorId || resolvedByOwnerId, status, original.root_entry_id || original.id, original.id,
      actorType, actorType === 'owner' ? resolvedByOwnerId : null,
    ],
  );
  return result.rows[0];
}

// Записки грузчиков о товаре (entity_type 'item_note') — для карточки
// прихода (invoiceId) или поставки (supplyId): и ждущие ответа, и уже
// отмеченные «Принял к сведению» — кем и когда.
async function itemNotes(client, warehouseId, { invoiceId = null, supplyId = null }) {
  const r = await client.query(
    `SELECT je.id, je.action_text, je.created_at, sk.name AS worker_name, ii.sku, ii.name AS product_name,
            i.number AS doc_number, a.created_at AS answered_at, a.actor_type AS answered_type,
            ask.name AS answered_name
       FROM journal_entries je
       JOIN invoices i ON i.id = je.invoice_id
       LEFT JOIN invoice_items ii ON ii.id = je.entity_id
       LEFT JOIN staff_keys sk ON sk.id = je.actor_id
       LEFT JOIN LATERAL (SELECT x.created_at, x.actor_type, x.actor_id FROM journal_entries x
                           WHERE x.related_entry_id = je.id ORDER BY x.created_at LIMIT 1) a ON true
       LEFT JOIN staff_keys ask ON ask.id = a.actor_id AND a.actor_type = 'manager'
      WHERE je.warehouse_id = $1 AND je.entity_type = 'item_note'
        AND (($2::uuid IS NOT NULL AND je.invoice_id = $2::uuid) OR ($3::uuid IS NOT NULL AND i.supply_id = $3::uuid))
      ORDER BY je.created_at DESC LIMIT 100`,
    [warehouseId, invoiceId, supplyId],
  );
  return r.rows.map((n) => ({
    entryId: n.id,
    text: (/: «([\s\S]*)»$/.exec(n.action_text) || [])[1] || n.action_text,
    actionText: n.action_text,
    at: n.created_at,
    workerName: n.worker_name,
    sku: n.sku,
    productName: n.product_name,
    docNumber: n.doc_number,
    answered: n.answered_at
      ? { at: n.answered_at, by: n.answered_type === 'manager' ? (n.answered_name || 'менеджер') : 'руководитель' }
      : null,
  }));
}

module.exports = { createEntry, listEntries, supplyPickProgress, resolveEntry, itemNotes, workStates };
