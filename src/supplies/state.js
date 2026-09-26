const journal = require('../journal/repository');

// Состояние поставки следует за её заказами, а не за кнопкой.
//
// «Собрана» — это когда собран каждый заказ в ней, и узнать это можно
// только из заказов. Пока статус ставили руками, поставка могла висеть
// «собирается» при полностью собранных заказах или остаться «собрана»,
// после того как из неё убрали отменённый заказ.
async function refreshSupplyStatus(client, warehouseId, supplyId) {
  await client.query(
    `UPDATE supplies s
        SET status = CASE WHEN o.n > 0 AND o.n = o.ready THEN 'ready' ELSE 'collecting' END::supply_status,
            ready_at = CASE WHEN o.n > 0 AND o.n = o.ready THEN COALESCE(s.ready_at, now()) END
       FROM (SELECT count(*) AS n, count(*) FILTER (WHERE status = 'ready') AS ready
               FROM invoices WHERE warehouse_id = $1 AND supply_id = $2) o
      WHERE s.warehouse_id = $1 AND s.id = $2 AND s.status <> 'shipped'`,
    [warehouseId, supplyId],
  );
  // Из поставки ушли все заказы (WB закрыл или отменил их, сверка исключила)
  // — пустая строка висела «собирается» навсегда, а разбирать её руками
  // было некому (владелец 26.09.2026: «разбирай автоматически»). Поставку,
  // уже заведённую на WB, не трогаем: её номер там живой.
  const dropped = await client.query(
    `DELETE FROM supplies s
      WHERE s.warehouse_id = $1 AND s.id = $2 AND s.status = 'collecting' AND s.mp_supply_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.warehouse_id = $1 AND i.supply_id = s.id)
      RETURNING s.number`,
    [warehouseId, supplyId],
  );
  if (dropped.rowCount) {
    await journal.createEntry(client, {
      warehouseId, agent: 'Кладовщик', actorType: 'system', entityType: 'supply', entityId: supplyId,
      actionText: `Поставка «${dropped.rows[0].number}» разобрана сама: в ней не осталось заказов — собирать нечего.`,
    });
  }
}

// Порядок блокировок один на всё приложение: сначала поставка, потом её
// заказы. Отгрузка поставки берёт их именно так; кто возьмёт заказ раньше
// поставки, упрётся в неё встречно, и база прервёт одну из транзакций.
async function lockSupplyOfInvoice(client, warehouseId, invoiceId) {
  const r = await client.query(
    'SELECT supply_id FROM invoices WHERE warehouse_id = $1 AND id = $2',
    [warehouseId, invoiceId],
  );
  const supplyId = r.rows[0]?.supply_id || null;
  if (supplyId) {
    await client.query('SELECT 1 FROM supplies WHERE warehouse_id = $1 AND id = $2 FOR UPDATE',
      [warehouseId, supplyId]);
  }
  return supplyId;
}

module.exports = { refreshSupplyStatus, lockSupplyOfInvoice };
