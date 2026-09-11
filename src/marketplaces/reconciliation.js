const { createHash } = require('node:crypto');
const { HttpError } = require('../middleware/errorHandler');
const { refreshCellFill } = require('../cells/fill');
const { formatBlockLabel } = require('../cells/label');
const journal = require('../journal/repository');

async function list(client, warehouseId, after = null) {
  const result = await client.query(`SELECT i.id, i.number, i.company_id, c.name AS company,
      i.status, i.mp_status, i.mp_supplier_status, i.mp_closed_at, i.mp_close_reason,
      i.mp_stock_returned_at, i.supply_id,
      COALESCE((SELECT sum(sr.picked_qty) FROM invoice_items ii
        JOIN shipping_records sr ON sr.invoice_item_id=ii.id WHERE ii.invoice_id=i.id),0) AS picked_qty
    FROM invoices i JOIN companies c ON c.id=i.company_id
    WHERE i.warehouse_id=$1 AND i.source='wb' AND i.mp_closed_at IS NOT NULL
      AND i.status <> 'shipped' AND i.mp_stock_returned_at IS NULL
      AND (i.mp_close_reason='fulfilled' OR i.supply_id IS NOT NULL OR EXISTS (SELECT 1 FROM invoice_items ii
        JOIN shipping_records sr ON sr.invoice_item_id=ii.id WHERE ii.invoice_id=i.id AND sr.picked_qty>0))
      AND ($2::uuid IS NULL OR i.id>$2::uuid)
    ORDER BY i.id LIMIT 51`, [warehouseId, after]);
  const rows = result.rows.slice(0, 50);
  return { rows, next: result.rows.length > 50 ? rows.at(-1).id : null };
}

async function invoice(client, warehouseId, id, lock = false) {
  const r = await client.query(`SELECT i.*, c.name AS company,
    NOT EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id=i.id
      AND (SELECT COALESCE(sum(sr.picked_qty),0) FROM shipping_records sr WHERE sr.invoice_item_id=ii.id) <> ii.declared_qty)
      AND EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id=i.id) AS fully_picked
    FROM invoices i
    JOIN companies c ON c.id=i.company_id
    WHERE i.warehouse_id=$1 AND i.id=$2 AND i.source='wb' AND i.direction='out'
    ${lock ? 'FOR UPDATE OF i' : ''}`, [warehouseId, id]);
  if (!r.rows[0]) throw new HttpError(404, 'Заказ WB не найден');
  return r.rows[0];
}

async function picks(client, warehouseId, inv) {
  const r = await client.query(`SELECT sr.id, sr.picked_qty, sr.cell_block_id, sr.finished_at, ii.sku, ii.name,
      cb.id AS existing_cell_id, cb.label, wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
    FROM shipping_records sr JOIN invoice_items ii ON ii.id=sr.invoice_item_id
    LEFT JOIN cell_blocks cb ON cb.id=sr.cell_block_id AND cb.warehouse_id=sr.warehouse_id
    LEFT JOIN warehouse_rows wr ON wr.id=cb.warehouse_row_id
    WHERE sr.warehouse_id=$1 AND sr.company_id=$2 AND ii.invoice_id=$3 AND sr.picked_qty>0
    ORDER BY sr.cell_block_id, sr.id`, [warehouseId, inv.company_id, inv.id]);
  return r.rows;
}

function previewData(inv, rows) {
  const resolved = inv.status === 'shipped' || Boolean(inv.mp_stock_returned_at);
  const action = resolved || !inv.mp_closed_at ? null
    : inv.mp_close_reason === 'fulfilled' ? 'confirm_departed'
      : rows.length === 0 ? (inv.supply_id ? 'remove_from_supply' : null) : 'return_to_cells';
  const missingCell = action === 'return_to_cells' && rows.some(r => !r.existing_cell_id);
  const incompletePick = action === 'confirm_departed' && !inv.fully_picked;
  const version = createHash('sha256').update(JSON.stringify({
    id: inv.id, status: inv.status, closed: inv.mp_closed_at, reason: inv.mp_close_reason,
    returned: inv.mp_stock_returned_at, supply: inv.supply_id, fullyPicked: inv.fully_picked,
    rows: rows.map(r => [r.id, String(r.picked_qty), r.existing_cell_id]),
  })).digest('hex');
  return {
    id: inv.id, number: inv.number, company: inv.company, status: inv.status,
    marketplaceStatus: inv.mp_status, reason: inv.mp_close_reason, closedAt: inv.mp_closed_at,
    returnedAt: inv.mp_stock_returned_at, supplyId: inv.supply_id,
    earliestDepartureAt: rows.reduce((last,r) => r.finished_at && (!last || new Date(r.finished_at)>new Date(last)) ? r.finished_at : last, null),
    action, resolved, version, canResolve: Boolean(action) && !missingCell && !incompletePick,
    blocked: missingCell ? 'Исходная ячейка удалена. Возврат в неё невозможен; сначала восстановите её в карте склада.'
      : incompletePick ? 'WB сообщает о доставке, но полный отбор в Аргусе не записан. Проверьте фактический остаток и движение товара со складом. Резерв сохранён; подтвердить отъезд без полного отбора нельзя.' : null,
    lines: rows.map(r => ({ shippingRecordId: r.id, sku: r.sku, name: r.name,
      qty: Number(r.picked_qty), cellBlockId: r.cell_block_id,
      cell: r.existing_cell_id ? formatBlockLabel(r.row_num, r) : 'Ячейка удалена' })),
  };
}

async function preview(client, warehouseId, id) {
  const inv = await invoice(client, warehouseId, id);
  return previewData(inv, await picks(client, warehouseId, inv));
}

function departureTime(value, rows, now = Date.now()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new HttpError(400, 'Укажите фактическую дату и время отъезда товара');
  }
  const time = Date.parse(value);
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (!Number.isFinite(time) || new Date(time).toISOString() !== canonical) {
    throw new HttpError(400, 'Укажите существующую дату и время отъезда товара');
  }
  const lastPick = Math.max(0,...rows.map(row => row.finished_at ? new Date(row.finished_at).getTime() : 0));
  if (time>now || time<lastPick) {
    throw new HttpError(400, 'Время отъезда должно быть после записанного отбора и не позднее текущего времени');
  }
  return new Date(time).toISOString();
}

async function resolve(client, warehouseId, id, { action, version, confirmed, ownerId, departedAt }) {
  if (confirmed !== true || !ownerId) throw new HttpError(400, 'Нужно подтверждение владельца склада');
  // Supplies always lock their head before their orders. Respect that order
  // here to serialize against dispatch without introducing a deadlock.
  const initial = await invoice(client, warehouseId, id);
  let supply = null;
  if (initial.supply_id) {
    const r = await client.query(`SELECT id,status FROM supplies WHERE warehouse_id=$1 AND id=$2 FOR UPDATE`,
      [warehouseId, initial.supply_id]);
    supply = r.rows[0];
  }
  const inv = await invoice(client, warehouseId, id, true);
  if (inv.supply_id !== initial.supply_id) throw new HttpError(409, 'Состав поставки изменился. Обновите проверку.');
  if (inv.status === 'shipped' || inv.mp_stock_returned_at) return { id, resolved: true, repeated: true };
  if (supply?.status === 'shipped') throw new HttpError(409, 'Поставка уже уехала. Возврат товара в ячейки этим действием запрещён.');
  const rows = await picks(client, warehouseId, inv);
  const current = previewData(inv, rows);
  if (current.version !== version) throw new HttpError(409, 'Данные заказа изменились. Обновите проверку перед подтверждением.');
  if (!current.canResolve || current.action !== action) throw new HttpError(409, current.blocked || 'Для этого заказа действие недоступно');

  if (action === 'return_to_cells') {
    const cellIds = [...new Set(rows.map(r => r.existing_cell_id))].sort();
    const cells = await client.query(`SELECT id FROM cell_blocks WHERE warehouse_id=$1 AND id=ANY($2::uuid[])
      ORDER BY id FOR KEY SHARE`, [warehouseId, cellIds]);
    if (cells.rows.length !== cellIds.length) throw new HttpError(409, 'Одна из ячеек удалена. Обновите проверку.');
    for (const row of rows) {
      // These are the recorded picks, returned only after physical confirmation
      // by the owner. source=NULL is a warehouse observation, never an inference
      // from accounting stock or a marketplace cancellation.
      await client.query(`INSERT INTO cell_stock (warehouse_id,company_id,cell_block_id,sku,qty,quality,source)
        VALUES ($1,$2,$3,$4,$5,'good',NULL)`,
      [warehouseId, inv.company_id, row.existing_cell_id, row.sku, row.picked_qty]);
      await client.query(`INSERT INTO stock_operations
        (warehouse_id,company_id,kind,sku,qty,to_cell_block_id,details)
        VALUES ($1,$2,'canceled_pick_return',$3,$4,$5,$6::jsonb)`,
      [warehouseId, inv.company_id, row.sku, row.picked_qty, row.existing_cell_id,
        JSON.stringify({ invoiceId: id, shippingRecordId: row.id, quality: 'good', ownerId })]);
    }
    for (const cellId of cellIds) await refreshCellFill(client, cellId);
    await client.query(`UPDATE invoices SET mp_stock_returned_at=now() WHERE warehouse_id=$1 AND id=$2`, [warehouseId, id]);
  } else if (action === 'confirm_departed') {
    const at = departureTime(departedAt, rows);
    await client.query(`UPDATE invoices SET status='shipped',shipped_at=$3 WHERE warehouse_id=$1 AND id=$2`, [warehouseId, id, at]);
  }

  if (inv.supply_id) {
    await client.query(`UPDATE invoices SET supply_id=NULL WHERE warehouse_id=$1 AND id=$2`, [warehouseId, id]);
    // A changed manifest must be checked again before the remaining supply is sent.
    await client.query(`UPDATE supplies SET status='collecting',ready_at=NULL
      WHERE warehouse_id=$1 AND id=$2 AND status='ready'`, [warehouseId, inv.supply_id]);
  }
  await journal.createEntry(client, { warehouseId, agent: 'Сверка заказов WB',
    actorType: 'owner', actorId: ownerId, entityType: 'invoice', entityId: id, invoiceId: id,
    actionText: `По заказу «${inv.number}» владелец подтвердил: `
      + (action === 'return_to_cells' ? 'весь подобранный годный товар возвращён в указанные исходные ячейки.'
        : action === 'confirm_departed' ? `весь подобранный товар фактически уехал со склада ${departedAt}.`
          : 'заказ без отбора исключён из местной поставки.')
      + (inv.supply_id ? ' Состав местной поставки изменён и требует повторной проверки.' : ''),
  });
  const pending = await client.query(`SELECT je.id FROM journal_entries je
    WHERE je.warehouse_id=$1 AND je.invoice_id=$2 AND je.agent='Обмен с WB' AND je.status='pending'
      AND NOT EXISTS (SELECT 1 FROM journal_entries answer WHERE answer.related_entry_id=je.id)
    ORDER BY je.created_at LIMIT 10`, [warehouseId, id]);
  for (const entry of pending.rows) {
    await journal.resolveEntry(client, { warehouseId, originalEntryId: entry.id, resolution:'confirm',
      resolvedByOwnerId:ownerId, note:`Физический товар по заказу «${inv.number}» проверен в сверке WB: ${action}.` });
  }
  return { id, resolved: true, action };
}

module.exports = { list, preview, resolve, previewData, departureTime };
