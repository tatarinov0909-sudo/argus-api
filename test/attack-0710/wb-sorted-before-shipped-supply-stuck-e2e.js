// Проверка 07.10: поставка WB по шагам — «Передать в доставку WB» до отъезда.
//
// С 05–06.10 порядок такой: собрали → «Передать в доставку WB» (QR) →
// погрузили → «Уехала». Если «Уехала» нажали поздно (машина ушла вечером,
// отметили утром), а WB за ночь уже принял посылки, обмен статусов убирает
// заказы из поставки. Поставка, которая физически уехала и принята WB,
// становится «Собирается» без заказов: «Уехала» не нажать («нет ни одного
// заказа»), «Разобрать» — нельзя (она на WB). У продавца она пропадает из
// «Поставок».
// Так на проде повисли ПС-061026-05 и -06 (хендофф 05.10, раздел 06–07.10).
// Сеть WB подменена.
//
// Код выхода: 1 — ошибка Аргуса, 2 — сломался тест.
process.env.MARKETPLACE_KEY_SECRET = process.env.MARKETPLACE_KEY_SECRET || 'test-secret-for-local-only-000000';
const { startApp, stand, verdicts, fail, withTenantContext } = require('../attack-0310/_lib');
const credentials = require('../../src/marketplaces/credentials');
const wbWrite = require('../../src/marketplaces/wbWrite');
const statuses = require('../../src/marketplaces/statuses');

Object.assign(wbWrite, {
  createSupply: async () => 'WB-GI-0711',
  addOrders: async () => true,
  supplyOrderIds: async () => ['73001'],
  orderStickers: async (t, ids) => ids.map((id) => ({ orderId: String(id), partA: '1', partB: '2', barcode: 'S' + id, file: 'c3Zn' })),
  setShipping: async () => true,
  deliverSupply: async () => true,
  supplyBarcode: async () => ({ barcode: 'WB-QR-0711', file: 'cXI=' }),
});

(async () => {
  const app = await startApp();
  const v = verdicts('Поставка WB: WB принял посылки раньше, чем нажали «Уехала»');
  try {
    const s = await stand(app, { racks: 1 });
    await s.receive([{ qty: 2, cell: s.cells[0] }]);
    const inv = await app.ok('POST', '/api/invoices', s.owner, { companyId: s.company, number: 'WB-73001', direction: 'out',
      items: [{ sku: 'R-1', name: 'Резинки чёрные', declaredQty: 1 }] });
    await s.q(`UPDATE invoices SET source = 'wb', external_id = '73001', mp_supplier_status = 'new' WHERE id = $1`, [inv.id]);
    await s.q(`UPDATE invoice_items SET mp_rid = 'rid-73001' WHERE invoice_id = $1`, [inv.id]);
    await withTenantContext({ warehouseId: s.warehouseId }, (c) => credentials.save(c, s.warehouseId,
      { companyId: s.company, marketplace: 'wb', token: 'synthetic-write-token' }));
    await app.ok('PATCH', `/api/marketplaces/${s.company}/wb/write`, s.owner, { enabled: true });
    const supply = await app.ok('POST', '/api/supplies', s.owner, { invoiceIds: [inv.id], marketplace: 'wb',
      shippingPointId: 100, destination: 'СЦ Коледино' });
    await app.ok('POST', `/api/shipping/assembly/${supply.id}/start`, s.worker, {});
    await app.ok('POST', '/api/shipping', s.worker, { invoiceItemId: inv.items[0].id, pickedQty: 1, cellBlockId: s.cells[0].id });
    await app.ok('POST', `/api/supplies/${supply.id}/marketplace/deliver`, s.owner);

    // Машина ушла, «Уехала» не нажали. Ночью обмен статусов: WB отсортировал.
    await s.q('UPDATE invoices SET mp_status_attempted_at = NULL WHERE id = $1', [inv.id]);
    await withTenantContext({ warehouseId: s.warehouseId }, (c) => statuses.reconcile(c, s.warehouseId, s.company, 'x', {
      fetchStatuses: async () => [{ id: 73001, supplierStatus: 'complete', wbStatus: 'sorted' }] }));

    // Утром отмечают «Уехала».
    const shipped = await app.api('POST', `/api/supplies/${supply.id}/ship`, s.owner, {});
    const head = (await s.q('SELECT status, (SELECT count(*)::int FROM invoices WHERE supply_id = $1) AS orders FROM supplies WHERE id = $1',
      [supply.id]))[0];
    const seller = (await app.ok('GET', '/api/sellers/supplies', s.seller)).rows.find((x) => x.id === supply.id);
    v.expect('уехавшую и принятую WB поставку можно отметить «Уехала» (или она уже уехала)',
      shipped.status === 200 || (head && head.status === 'shipped'),
      '200 / «уехала»', `${shipped.status} ${JSON.stringify(shipped.body)}; в базе: ${JSON.stringify(head)}`);
    v.expect('продавец видит свою поставку уехавшей / принятой WB (а не «Собирается» и не пропавшей)',
      seller && seller.status !== 'collecting',
      'уехала / принята WB', seller ? `${seller.statusName}, заказов ${seller.orders}` : 'поставки нет в списке');
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
