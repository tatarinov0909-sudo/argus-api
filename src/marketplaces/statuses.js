const wb = require('./wb');
const journal = require('../journal/repository');
const { refreshSupplyStatus, lockSupplyOfInvoice } = require('../supplies/state');

const CANCELED = new Set(['canceled', 'canceled_by_client', 'declined_by_client', 'defect', 'canceled_by_carrier']);
// The parcel is physically with WB: at a sorting centre, a carrier or a buyer.
const AT_WB = new Set(['sorted', 'sold', 'ready_for_pickup', 'postponed_delivery', 'accepted_by_carrier', 'sent_to_carrier']);

function closeReason(row) {
  // Missing, erroneous and unknown statuses do not imply that the order ended.
  if (!row || row.errors?.length || row.isError) return null;
  if (CANCELED.has(row.wbStatus) || ['cancel', 'cancel_carrier'].includes(row.supplierStatus)) return 'canceled';
  if (AT_WB.has(row.wbStatus) || row.supplierStatus === 'complete') return 'fulfilled';
  return null;
}

// For an order the warehouse is working on, "handed over to delivery" is the
// normal course of its supply, not its end: the truck has not left yet. Only
// a cancellation or a parcel WB already physically holds ends local work.
function endsLocalWork(row, reason) {
  return reason === 'canceled' || (reason === 'fulfilled' && AT_WB.has(row.wbStatus));
}

function statusText(row) {
  if (!row.mp_closed_at) return null;
  return row.mp_close_reason === 'canceled' ? 'Отменён на WB' : 'Передан в доставку на WB';
}

// Only an explicit status closes marketplace work. Absence from /orders/new is never a
// cancellation: adding an order to a WB supply also removes it from that queue.
// One batch per seller/tick bounds network and DB work; attempted_at gives old
// and missing orders fair rotation instead of starving them behind new orders.
//
// A closed order leaves its local supply in the same transaction, so a supply
// never waits on an order that is no longer going anywhere and the rest of it
// ships. A delivered order the warehouse never picked is not polled again: a
// later cancellation of a parcel we never touched changes nothing here, and
// re-asking WB about every such order forever pushed live ones down the queue.
async function reconcile(client, warehouseId, companyId, token, { fetchStatuses = wb.orderStatuses } = {}) {
  const selected = await client.query(
    `SELECT i.id, i.external_id FROM invoices i
     WHERE i.warehouse_id=$1 AND i.company_id=$2 AND i.source='wb' AND i.direction='out'
       AND i.status <> 'shipped' AND i.mp_stock_returned_at IS NULL
       AND (i.mp_closed_at IS NULL OR (i.mp_close_reason='fulfilled' AND EXISTS (
         SELECT 1 FROM invoice_items ii JOIN shipping_records sr ON sr.invoice_item_id=ii.id
         WHERE ii.invoice_id=i.id AND sr.picked_qty>0)))
       AND (i.mp_status_attempted_at IS NULL OR i.mp_status_attempted_at < now()-interval '4 minutes')
       AND i.external_id ~ '^[0-9]{1,15}$'
     ORDER BY i.mp_status_attempted_at NULLS FIRST, i.id LIMIT 1000`,
    [warehouseId, companyId],
  );
  if (!selected.rows.length) return { checked: 0, closed: 0, missing: 0, conflicts: 0 };
  const wanted = new Set(selected.rows.map(r => r.external_id));
  let statuses;
  try { statuses = await fetchStatuses(token, [...wanted]); }
  catch (err) {
    // A status API outage must not roll back successfully imported new orders.
    // No status/attempt timestamps are advanced; the next tick retries.
    const messages = {401:'Ключ WB не принят. Проверьте подключение.',403:'Ключ WB не даёт доступ к статусам заказов.',429:'WB ограничил частоту запросов. Проверка повторится автоматически.'};
    return { checked: 0, closed: 0, missing: wanted.size, conflicts: 0,
      error: messages[err.status] || 'Не удалось проверить статусы WB. Проверка повторится автоматически.' };
  }
  const byId = new Map();
  const duplicates = new Set();
  for (const row of statuses) {
    const id = String(row?.id);
    if (!wanted.has(id)) continue;
    if (byId.has(id)) duplicates.add(id);
    byId.set(id, row);
  }
  let checked = 0; let closed = 0; let conflicts = 0;
  for (const candidate of selected.rows) {
    const row = byId.get(candidate.external_id);
    const valid = row && !duplicates.has(candidate.external_id) && !row.errors?.length && !row.isError
      && typeof row.supplierStatus === 'string' && typeof row.wbStatus === 'string'
      && row.supplierStatus.length > 0 && row.wbStatus.length > 0;
    if (!valid) {
      await client.query(`UPDATE invoices SET mp_status_attempted_at=now()
        WHERE warehouse_id=$1 AND company_id=$2 AND id=$3`, [warehouseId, companyId, candidate.id]);
      continue;
    }
    // Supply head before the order: the same lock order as shipping a supply.
    const supplyBefore = await lockSupplyOfInvoice(client, warehouseId, candidate.id);
    const locked = await client.query(`SELECT i.id, i.number, i.status, i.mp_closed_at, i.mp_close_reason,
        i.mp_stock_returned_at, i.supply_id, s.number AS supply_number,
        EXISTS (SELECT 1 FROM invoice_items ii JOIN shipping_records sr ON sr.invoice_item_id=ii.id
                WHERE ii.invoice_id=i.id AND sr.picked_qty>0) AS has_picks
      FROM invoices i LEFT JOIN supplies s ON s.id=i.supply_id
      WHERE i.warehouse_id=$1 AND i.company_id=$2 AND i.id=$3 FOR UPDATE OF i`,
    [warehouseId, companyId, candidate.id]);
    const inv = locked.rows[0];
    if (!inv || inv.status === 'shipped' || inv.mp_stock_returned_at || inv.mp_close_reason === 'canceled') continue;
    if ((inv.supply_id || null) !== supplyBefore) continue; // moved between supplies meanwhile; next tick
    const reason = closeReason(row);
    const localWork = inv.has_picks || Boolean(inv.supply_id);
    const closes = Boolean(reason) && (!localWork || endsLocalWork(row, reason));
    await client.query(`UPDATE invoices SET mp_supplier_status=$4, mp_status=$5,
        mp_status_checked_at=now(), mp_status_attempted_at=now(),
        mp_closed_at=CASE WHEN $7 THEN COALESCE(mp_closed_at,now()) ELSE mp_closed_at END,
        mp_close_reason=CASE WHEN NOT $7 THEN mp_close_reason
          WHEN mp_close_reason='fulfilled' AND $6='canceled' THEN 'canceled'
          ELSE COALESCE(mp_close_reason,$6) END,
        supply_id=CASE WHEN $7 THEN NULL ELSE supply_id END
      WHERE warehouse_id=$1 AND company_id=$2 AND id=$3`,
    [warehouseId, companyId, candidate.id, row.supplierStatus, row.wbStatus, reason, closes]);
    checked++;
    // Delivery can later be canceled. Keep unresolved delivery conflicts under
    // observation and change the required human action without moving stock.
    const becameCanceled = inv.mp_close_reason === 'fulfilled' && reason === 'canceled';
    if (closes && (!inv.mp_closed_at || becameCanceled)) {
      if (!inv.mp_closed_at) closed++;
      if (inv.supply_id) await refreshSupplyStatus(client, warehouseId, inv.supply_id);
      // Only a recorded pick is physical work a person must undo or confirm.
      // An order nobody picked simply leaves the queue or its supply.
      const conflict = inv.has_picks;
      if (conflict) conflicts++;
      const event = reason === 'canceled' ? 'отменён на WB' : 'посылку уже принял WB';
      const fromSupply = inv.supply_id ? ` Убран из поставки «${inv.supply_number}».` : '';
      await journal.createEntry(client, { warehouseId, agent: 'Обмен с WB', actorType: 'system',
        entityType: 'invoice', entityId: inv.id, invoiceId: inv.id, status: conflict ? 'pending' : 'auto',
        actionText: `Заказ «${inv.number}»: ${event}.${fromSupply}`
          + (conflict ? ' Товар по нему уже отобран: склад должен '
              + (reason === 'canceled' ? 'вернуть его в ячейку' : 'подтвердить, что он уехал')
              + ' в разделе «Сверка заказов WB». Автоматического списания или возврата нет.'
            : ' Товар по нему не отбирали, физический остаток не изменён.'),
      });
    }
  }
  return { checked, closed, missing: selected.rows.length - checked, conflicts };
}

module.exports = { reconcile, closeReason, statusText };
