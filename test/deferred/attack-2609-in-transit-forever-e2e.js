// Атака 26.09: «В пути» у продавца никогда не уменьшается.
//
// src/sellers/stock.js (in_transit) считает «в пути» всё, что уехало
// поставкой и у чего нет mp_closed_at, и обещает в комментарии: «Принятый WB
// заказ обмен статусов закрывает (mp_closed_at)». Но обмен статусов
// (src/marketplaces/statuses.js, reconcile) выбирает только заказы с
// status <> 'shipped' — уехавший заказ он больше никогда не спрашивает у WB,
// и mp_closed_at у него не появится. Больше mp_closed_at не ставит никто.
// Итог: каждая когда-либо отгруженная штука навсегда остаётся «в пути».
//
// Сценарий настоящим кодом: заказ WB → поставка → отбор → «Уехала» → обмен
// статусов получает от WB «sorted» (посылка у WB). Сеть не трогаем: вместо WB
// — заглушка fetchStatuses.
const { startApp, warehouse, assert } = require('../attack-helpers');
const statuses = require('../../src/marketplaces/statuses');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  const { ok, stop } = await startApp();
  try {
    const w = await warehouse(ok, 'transit');
    const company = await w.company('Продавец транзит (синтетика)');
    const seller = await w.sellerToken(company);
    const worker = await w.worker('Грузчик');
    const cells = await w.cells([{ rackCount: 2, tierCount: 1 }]);
    await w.run((c) => c.query(`INSERT INTO products (warehouse_id, company_id, sku, name, barcode, stock_qty_1c, stock_at)
      VALUES ($1, $2, 'TR-1', 'Товар транзит', '4600000000901', 20, now())`, [w.warehouseId, company]));
    const inv = await ok('POST', '/api/invoices', w.token, { companyId: company, number: 'ПР-T1', direction: 'in',
      items: [{ sku: 'TR-1', name: 'Товар транзит', declaredQty: 10 }] });
    await ok('POST', '/api/receiving', worker, { invoiceItemId: inv.items[0].id, acceptedQty: 10, cellBlockId: cells[0].id });

    const order = await ok('POST', '/api/invoices', w.token, { companyId: company, number: 'WB-900001', direction: 'out',
      items: [{ sku: 'TR-1', name: 'Товар транзит', declaredQty: 2 }] });
    await w.run((c) => c.query(`UPDATE invoices SET source = 'wb', external_id = '900001' WHERE id = $1`, [order.id]));
    await w.run((c) => c.query(`UPDATE invoice_items SET mp_rid = 'rid-900001' WHERE invoice_id = $1`, [order.id]));
    const supply = await ok('POST', '/api/supplies', w.token, { invoiceIds: [order.id], marketplace: 'wb', destination: 'СЦ Тест' });
    await ok('POST', '/api/shipping', worker, { invoiceItemId: order.items[0].id, pickedQty: 2, cellBlockId: cells[0].id });
    await ok('POST', `/api/supplies/${supply.id}/ship`, w.token, {});

    const before = await ok('GET', '/api/sellers/stock', seller);
    console.log('  после «Уехала»: inTransit =', before.summary.inTransit);

    // WB принял посылку на сортировочном центре. Обмен статусов — настоящий код.
    const asked = [];
    const fetchStatuses = async (_token, ids) => {
      asked.push(...ids);
      return ids.map((id) => ({ id: Number(id), supplierStatus: 'complete', wbStatus: 'sorted' }));
    };
    const result = await w.run((c) => statuses.reconcile(c, w.warehouseId, company, 'fake-token', { fetchStatuses }));
    console.log('  обмен статусов:', JSON.stringify(result), 'спросил у WB заказы:', JSON.stringify(asked));

    const after = await ok('GET', '/api/sellers/stock', seller);
    const orders = (await ok('GET', '/api/sellers/orders', seller)).rows;
    const o = orders.find((r) => r.id === order.id);
    console.log('  после ответа WB «sorted»: inTransit =', after.summary.inTransit, '; заказ: status =', o.status, 'mp_closed_at =', o.mp_closed_at);

    check('обмен статусов спрашивает WB об уехавшем заказе (иначе «в пути» не закроется никогда)',
      () => assert.ok(asked.includes('900001'), `спрошены: ${JSON.stringify(asked)}`));
    check('WB принял посылку («sorted») — у продавца «В пути» становится 0',
      () => assert.equal(after.summary.inTransit, 0));
    check('заказ, принятый WB, не висит «Отгружен, в пути на WB» (mp_closed_at проставлен)',
      () => assert.ok(o.mp_closed_at, 'mp_closed_at = null'));
  } catch (err) { failed += 1; console.error('  FAIL  исключение:', err); }
  finally { await stop(); }
  if (failed) { console.log(`FAIL ${failed}`); process.exitCode = 1; }
})();
