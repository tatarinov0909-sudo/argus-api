// Находка: «Разобрать» поставку WB, из которой WB уже принял заказ.
//
// С 07.10 (api 8ea6f6f) заказ, посылку которого WB уже держит, «уехал» и
// остаётся в своей поставке, кто бы её ни собирал; убрать его из поставки
// нельзя («Заказ … уже уехал — WB принял его посылку», removeOrder). Но
// «Разобрать» такую поставку можно, если её собирали не в Аргусе (отборов
// нет) и на WB её создавали не через Аргус (запись в WB выключена — так у
// всех продавцов сейчас). Уехавший заказ выпадает из поставки, а журнал пишет,
// что он «вернулся в очередь».
//
// Ожидание: поставку с уехавшим заказом разобрать нельзя (как убрать из неё
// уехавший заказ) — или хотя бы уехавший заказ остаётся в ней.
const { startApp, verdicts, fail, setup } = require('./_lib');
const { reconcile } = require('../../src/marketplaces/statuses');

(async () => {
  const { ok, api, stop } = await startApp();
  const v = verdicts('Разобрать поставку с заказом, который уже принял WB');
  try {
    const w = await setup(ok, { skus: ['AC-1'], stockSource: 'argus' });
    await w.put(w.cells[0], 'AC-1', 10);
    const order = async (externalId) => {
      const inv = await ok('POST', '/api/invoices', w.token, { companyId: w.companyId, number: 'WB-' + externalId, direction: 'out',
        items: [{ sku: 'AC-1', name: 'Товар', declaredQty: 1 }] });
      await w.q(`UPDATE invoices SET source='wb', external_id=$2, mp_supplier_status='new' WHERE id=$1`, [inv.id, String(externalId)]);
      await w.q('UPDATE invoice_items SET mp_rid=$2 WHERE invoice_id=$1', [inv.id, 'rid-' + externalId]);
      return inv;
    };
    const poll = async (map) => {
      await w.q('UPDATE invoices SET mp_status_attempted_at = NULL WHERE warehouse_id = $1', [w.warehouseId]);
      return w.run((c) => reconcile(c, w.warehouseId, w.companyId, 'synthetic-token', {
        fetchStatuses: async (_, ids) => ids.filter((id) => map[id]).map((id) => ({ id: Number(id), ...map[id] })),
      }));
    };

    // Поставку составили в Аргусе; собирали и сдавали через кабинет WB.
    const d = await order(88001);
    const e = await order(88002);
    const supply = await ok('POST', '/api/supplies', w.token, { invoiceIds: [d.id, e.id], marketplace: 'wb', destination: 'СЦ Коледино' });
    await poll({ 88001: { supplierStatus: 'complete', wbStatus: 'sorted' }, 88002: { supplierStatus: 'confirm', wbStatus: 'waiting' } });
    const mid = (await w.q('SELECT id, status, supply_id FROM invoices WHERE id = ANY($1::uuid[]) ORDER BY number', [[d.id, e.id]]));
    v.expect('WB принял заказ 88001 — он уехал и остался в поставке; 88002 ждёт',
      mid[0].status === 'shipped' && mid[0].supply_id === supply.id && mid[1].supply_id === supply.id,
      '88001 shipped в поставке', JSON.stringify(mid));
    const remove = await api('POST', `/api/supplies/orders/${d.id}/remove`, w.token, {});
    v.expect('убрать уехавший заказ из поставки нельзя (так и задумано)', remove.status === 409, '409', `${remove.status}`);

    // Менеджер жмёт «Разобрать» — поставку собирали не в Аргусе.
    const disband = await api('DELETE', `/api/supplies/${supply.id}`, w.token);
    const after = (await w.q('SELECT number, status, supply_id FROM invoices WHERE id = $1', [d.id]))[0];
    const journal = (await w.q(`SELECT action_text FROM journal_entries WHERE warehouse_id = $1 AND entity_id = $2
                                 AND action_text LIKE '%разобрана%'`, [w.warehouseId, supply.id])).map((r) => r.action_text);
    v.expect('поставку, из которой WB уже принял заказ, «Разобрать» не даёт',
      disband.status === 409, '409 «… уже уехал — WB принял его посылку»', `${disband.status} ${JSON.stringify(disband.body)}`);
    v.expect('уехавший заказ остаётся в своей поставке',
      after.supply_id === supply.id, `supply_id = ${supply.id}`, `supply_id = ${after.supply_id}, статус ${after.status}`);
    v.expect('журнал не пишет, что уехавший заказ «вернулся в очередь»',
      !journal.some((t) => /2 заказа вернулись в очередь/.test(t)), 'без «2 заказа вернулись в очередь»', JSON.stringify(journal));
  } catch (err) { fail(err); } finally { v.done(); await stop(); }
})();
