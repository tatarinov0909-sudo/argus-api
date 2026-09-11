const wb = require('./wb');
const journal = require('../journal/repository');

const CANCELED = new Set(['canceled', 'canceled_by_client', 'declined_by_client', 'defect', 'canceled_by_carrier']);
const FULFILLED = new Set(['sorted', 'sold', 'ready_for_pickup', 'postponed_delivery', 'accepted_by_carrier', 'sent_to_carrier']);

function closeReason(row) {
  // Missing, erroneous and unknown statuses do not imply that the order ended.
  if (!row || row.errors?.length || row.isError) return null;
  if (CANCELED.has(row.wbStatus) || ['cancel', 'cancel_carrier'].includes(row.supplierStatus)) return 'canceled';
  if (FULFILLED.has(row.wbStatus) || row.supplierStatus === 'complete') return 'fulfilled';
  return null;
}

function statusText(row) {
  if (!row.mp_closed_at) return null;
  return row.mp_close_reason === 'canceled' ? 'Отменён на WB' : 'Передан в доставку на WB';
}

// Only an explicit status closes marketplace work. Absence from /orders/new is never a
// cancellation: adding an order to a WB supply also removes it from that queue.
// One batch per seller/tick bounds network and DB work; attempted_at gives old
// and missing orders fair rotation instead of starving them behind new orders.
async function reconcile(client, warehouseId, companyId, token, { fetchStatuses = wb.orderStatuses } = {}) {
  const selected = await client.query(
    `SELECT id, external_id FROM invoices
     WHERE warehouse_id=$1 AND company_id=$2 AND source='wb' AND direction='out'
       AND status <> 'shipped' AND mp_stock_returned_at IS NULL
       AND (mp_closed_at IS NULL OR mp_close_reason='fulfilled')
       AND (mp_status_attempted_at IS NULL OR mp_status_attempted_at < now()-interval '4 minutes')
       AND external_id ~ '^[0-9]{1,15}$'
     ORDER BY mp_status_attempted_at NULLS FIRST, id LIMIT 1000`,
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
    // Lock the same invoice before any worker pick or physical reconciliation.
    const locked = await client.query(`SELECT i.id, i.number, i.status, i.mp_closed_at, i.mp_close_reason,
        i.mp_stock_returned_at, i.supply_id,
        EXISTS (SELECT 1 FROM invoice_items ii JOIN shipping_records sr ON sr.invoice_item_id=ii.id
                WHERE ii.invoice_id=i.id AND sr.picked_qty>0) AS has_picks
      FROM invoices i WHERE i.warehouse_id=$1 AND i.company_id=$2 AND i.id=$3 FOR UPDATE OF i`,
    [warehouseId, companyId, candidate.id]);
    const inv = locked.rows[0];
    if (!inv || inv.status === 'shipped' || inv.mp_stock_returned_at || inv.mp_close_reason === 'canceled') continue;
    const reason = closeReason(row);
    await client.query(`UPDATE invoices SET mp_supplier_status=$4, mp_status=$5,
        mp_status_checked_at=now(), mp_status_attempted_at=now(),
        mp_closed_at=CASE WHEN $6::text IS NOT NULL THEN COALESCE(mp_closed_at,now()) ELSE mp_closed_at END,
        mp_close_reason=CASE WHEN mp_close_reason='fulfilled' AND $6='canceled' THEN 'canceled'
          ELSE COALESCE(mp_close_reason,$6) END
      WHERE warehouse_id=$1 AND company_id=$2 AND id=$3`,
    [warehouseId, companyId, candidate.id, row.supplierStatus, row.wbStatus, reason]);
    checked++;
    // Delivery can later be canceled. Keep unresolved delivery conflicts under
    // observation and change the required human action without moving stock.
    const becameCanceled = inv.mp_close_reason === 'fulfilled' && reason === 'canceled';
    if (reason && (!inv.mp_closed_at || becameCanceled)) {
      if (!inv.mp_closed_at) closed++;
      const conflict = inv.status !== 'shipped' && (reason === 'fulfilled' || inv.has_picks || Boolean(inv.supply_id));
      if (conflict) conflicts++;
      await journal.createEntry(client, { warehouseId, agent: 'Обмен с WB', actorType: 'system',
        entityType: 'invoice', entityId: inv.id, invoiceId: inv.id, status: conflict ? 'pending' : 'auto',
        actionText: `Заказ «${inv.number}»: ${reason === 'canceled' ? 'отмена на WB' : 'передан в доставку на WB'}.`
          + (conflict ? ' Склад должен проверить физический товар в разделе «Сверка заказов WB». Автоматического списания или возврата нет.'
            : ' Исключён из очереди сборки. Физический остаток не изменён.'),
      });
    }
  }
  return { checked, closed, missing: selected.rows.length - checked, conflicts };
}

module.exports = { reconcile, closeReason, statusText };
