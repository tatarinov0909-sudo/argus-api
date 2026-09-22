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
            -- Заказ сейчас в поставке? Тогда у отметки «нет товара» есть
            -- решение «убрать заказ из поставки», а вся сборка этой поставки
            -- собирается в кабинете в одну запись вместо строки на каждый товар.
            i.supply_id AS invoice_supply_id,
            s.number AS invoice_supply_number,
            CASE WHEN cb.id IS NULL THEN NULL ELSE
              wr.row_num
              || '.' || CASE WHEN cb.rack_start = cb.rack_end THEN cb.rack_start::text
                             ELSE cb.rack_start || '–' || cb.rack_end END
              || '.' || CASE WHEN cb.tier_start = cb.tier_end THEN cb.tier_start::text
                             ELSE cb.tier_start || '–' || cb.tier_end END
            END AS cell_label
     FROM journal_entries je
     LEFT JOIN invoices i ON i.id = je.invoice_id
     LEFT JOIN supplies s ON s.id = i.supply_id
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
     ORDER BY je.created_at DESC`,
    [warehouseId, limit, cellBlockId, invoiceId, hideUrgent === true],
  );
  return result.rows;
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

  const status = resolution === 'confirm' ? 'confirmed' : 'rolled_back';
  const who = actorType === 'manager' ? 'менеджером' : 'владельцем';
  const actionText = resolution === 'confirm'
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

module.exports = { createEntry, listEntries, supplyPickProgress, resolveEntry };
