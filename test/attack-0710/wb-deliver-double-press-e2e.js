// Проверка 07.10: «Передать в доставку WB» нажали дважды (два человека или
// нетерпеливый двойной клик — кнопка на время запроса не гаснет).
//
// Оба запроса видят «ещё не передана» и оба идут в WB. Второй WB отклоняет
// («уже в доставке»), и Аргус пишет в журнал руководителю тревогу «Поставку
// не удалось передать в доставку на WB … повторите», хотя поставка передана.
// Сеть WB подменена.
//
// Код выхода: 1 — ошибка Аргуса, 2 — сломался тест.
process.env.MARKETPLACE_KEY_SECRET = process.env.MARKETPLACE_KEY_SECRET || 'test-secret-for-local-only-000000';
const { startApp, stand, verdicts, fail, withTenantContext } = require('../attack-0310/_lib');
const credentials = require('../../src/marketplaces/credentials');
const wbWrite = require('../../src/marketplaces/wbWrite');

const calls = { deliver: 0 };
let delivered = false;
Object.assign(wbWrite, {
  createSupply: async () => 'WB-GI-0710',
  addOrders: async () => true,
  supplyOrderIds: async () => ['72001'],
  orderStickers: async (t, ids) => ids.map((id) => ({ orderId: String(id), partA: '1', partB: '2', barcode: 'S' + id, file: 'c3Zn' })),
  setShipping: async () => true,
  // WB отвечает за секунду; повторная передача — отказ, как у настоящего WB.
  deliverSupply: async () => {
    calls.deliver += 1;
    await new Promise((r) => setTimeout(r, 400));
    if (delivered) throw new Error('WB: поставка уже передана в доставку');
    delivered = true;
    return true;
  },
  supplyBarcode: async () => ({ barcode: 'WB-QR-0710', file: 'cXI=' }),
});

(async () => {
  const app = await startApp();
  const v = verdicts('Двойное «Передать в доставку WB»');
  try {
    const s = await stand(app, { racks: 1 });
    const inv = await app.ok('POST', '/api/invoices', s.owner, { companyId: s.company, number: 'WB-72001', direction: 'out',
      items: [{ sku: 'R-1', name: 'Резинки чёрные', declaredQty: 1 }] });
    await s.q(`UPDATE invoices SET source = 'wb', external_id = '72001', mp_supplier_status = 'new' WHERE id = $1`, [inv.id]);
    await s.q(`UPDATE invoice_items SET mp_rid = 'rid-72001' WHERE invoice_id = $1`, [inv.id]);
    await withTenantContext({ warehouseId: s.warehouseId }, (c) => credentials.save(c, s.warehouseId,
      { companyId: s.company, marketplace: 'wb', token: 'synthetic-write-token' }));
    await app.ok('PATCH', `/api/marketplaces/${s.company}/wb/write`, s.owner, { enabled: true });
    const supply = await app.ok('POST', '/api/supplies', s.owner, { invoiceIds: [inv.id], marketplace: 'wb',
      shippingPointId: 100, destination: 'СЦ' });
    // Собрана (как в test/stock-transit-wb-over-e2e.js).
    await s.q(`UPDATE invoices SET status = 'ready' WHERE supply_id = $1`, [supply.id]);
    await s.q(`UPDATE supplies SET status = 'ready', ready_at = now() WHERE id = $1`, [supply.id]);

    const [r1, r2] = await Promise.all([
      app.api('POST', `/api/supplies/${supply.id}/marketplace/deliver`, s.owner),
      app.api('POST', `/api/supplies/${supply.id}/marketplace/deliver`, s.owner),
    ]);
    const alarms = await s.q(`SELECT action_text FROM journal_entries WHERE warehouse_id = $1 AND entity_id = $2
      AND status = 'pending' AND action_text LIKE '%не удалось передать%'`, [s.warehouseId, supply.id]);
    v.expect('в WB поставку передают один раз', calls.deliver === 1, '1 запрос', `${calls.deliver} запроса`);
    v.expect('руководителю нет ложной тревоги «не удалось передать»', alarms.length === 0, 'нет',
      alarms.map((a) => a.action_text).join(' | '));
    v.expect('оба нажатия отвечают «передана»', [r1, r2].every((r) => r.body && (r.body.delivered || r.body.alreadyDelivered)),
      'delivered / alreadyDelivered', JSON.stringify([r1.body, r2.body]));
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
