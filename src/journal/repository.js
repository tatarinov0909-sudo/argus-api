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
}) {
  const result = await client.query(
    `INSERT INTO journal_entries
       (warehouse_id, agent, action_text, entity_type, entity_id, actor_type, actor_id,
        status, invoice_id, cell_block_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [warehouseId, agent, actionText, entityType, entityId, actorType, actorId, status,
      invoiceId, cellBlockId],
  );
  return result.rows[0];
}

async function listEntries(client, warehouseId, { limit = 200 } = {}) {
  // Номер накладной и адрес ячейки собираем здесь, а не на клиенте: иначе
  // кабинету пришлось бы держать в памяти всю карту склада только ради подписи.
  const result = await client.query(
    `SELECT je.*,
            i.number AS invoice_number,
            CASE WHEN cb.id IS NULL THEN NULL ELSE
              wr.row_num
              || '.' || CASE WHEN cb.rack_start = cb.rack_end THEN cb.rack_start::text
                             ELSE cb.rack_start || '–' || cb.rack_end END
              || '.' || CASE WHEN cb.tier_start = cb.tier_end THEN cb.tier_start::text
                             ELSE cb.tier_start || '–' || cb.tier_end END
            END AS cell_label
     FROM journal_entries je
     LEFT JOIN invoices i ON i.id = je.invoice_id
     LEFT JOIN cell_blocks cb ON cb.id = je.cell_block_id
     LEFT JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
     WHERE je.warehouse_id = $1
     ORDER BY je.created_at DESC LIMIT $2`,
    [warehouseId, limit],
  );
  return result.rows;
}

async function resolveEntry(client, {
  warehouseId, originalEntryId, resolution, resolvedByOwnerId, note,
}) {
  const originalResult = await client.query(
    `SELECT * FROM journal_entries WHERE id = $1 AND warehouse_id = $2`,
    [originalEntryId, warehouseId],
  );
  const original = originalResult.rows[0];
  if (!original) return null;

  const status = resolution === 'confirm' ? 'confirmed' : 'rolled_back';
  const actionText = resolution === 'confirm'
    ? `Подтверждено владельцем: ${note || original.action_text}`
    : `Откат правки: ${note || original.action_text}`;

  const result = await client.query(
    `INSERT INTO journal_entries
       (warehouse_id, agent, action_text, entity_type, entity_id, actor_type, actor_id,
        status, root_entry_id, related_entry_id, resolved_at, resolved_by_owner_id)
     VALUES ($1, $2, $3, $4, $5, 'owner', $6, $7, $8, $9, now(), $6)
     RETURNING *`,
    [
      warehouseId, original.agent, actionText, original.entity_type, original.entity_id,
      resolvedByOwnerId, status, original.root_entry_id || original.id, original.id,
    ],
  );
  return result.rows[0];
}

module.exports = { createEntry, listEntries, resolveEntry };
