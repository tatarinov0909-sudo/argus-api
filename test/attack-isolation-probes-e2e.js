// Пробы, которые НЕ сломали систему (ожидается зелёный прогон): изоляция
// продавцов и складов на новых ручках 24–25.09 и ответы на мусорный ввод.
const { startApp, warehouse, assert } = require('./attack-helpers');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  const { api, ok, stop } = await startApp();
  try {
    const w1 = await warehouse(ok, 'probe1');
    const w2 = await warehouse(ok, 'probe2');
    const a = await w1.company('Продавец А (синтетика)');
    const b = await w1.company('Продавец Б (синтетика)');
    const sa = await w1.sellerToken(a);
    const sb = await w1.sellerToken(b);
    const worker1 = await w1.worker();
    const worker2 = await w2.worker();
    await w1.run((c) => c.query(
      `INSERT INTO products (warehouse_id, company_id, sku, name, barcode) VALUES ($1, $2, 'PA-1', 'Товар А', '4600000009991'),
         ($1, $3, 'PB-1', 'Товар Б', '4600000009992')`, [w1.warehouseId, a, b]));
    const blocks = await w1.cells([{ rackCount: 2, tierCount: 1 }]);
    await w1.run((c) => c.query(`INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty) VALUES ($1, $2, $3, 'PB-1', 5)`,
      [blocks[0].id, w1.warehouseId, b]));
    const inB = await ok('POST', '/api/sellers/inbound', sb, { grid: [['Баркод', 'Количество'], ['4600000009992', 2]], apply: true });
    const outB = await ok('POST', '/api/invoices', w1.token, { companyId: b, number: 'PRB-1', direction: 'out',
      items: [{ name: 'Товар Б', sku: 'PB-1', declaredQty: 1 }] });
    const supB = await ok('POST', '/api/supplies', w1.token, { invoiceIds: [outB.id] }, 201);

    const r = {};
    r.inboundForeign = await api('POST', '/api/sellers/inbound', sa, { companyId: b, grid: [['Баркод', 'Количество'], ['4600000009992', 2]] });
    r.actForeignSeller = await api('GET', `/api/acts/receipt/${inB.invoice.id}`, sa);
    r.actShipSeller = await api('GET', `/api/acts/shipment/${supB.id}`, sb);
    r.inboundWorker = await api('POST', '/api/sellers/inbound', worker1, { grid: [['Баркод', 'Количество'], ['1', 1]] });
    r.actOtherWh = await api('GET', `/api/acts/receipt/${inB.invoice.id}`, w2.token);
    r.shipActOtherWh = await api('GET', `/api/acts/shipment/${supB.id}`, w2.token);
    r.suppliesOtherWh = await api('GET', `/api/sellers/supplies?companyId=${b}`, w2.token);
    r.inboundOtherWh = await api('POST', '/api/sellers/inbound', w2.token, { companyId: b, grid: [['Баркод', 'Количество'], ['4600000009992', 2]] });
    r.alignOtherWh = await api('POST', '/api/cells/stock-align', w2.token, { companyId: b, grid: [['Конечный остаток']] });
    r.productOtherWh = await api('POST', '/api/shipping/product', worker2, { supplyId: supB.id, sku: 'PB-1', cellBlockId: blocks[0].id, pickedQty: 1 });
    r.suppliesA = await api('GET', '/api/sellers/supplies', sa);
    r.supplyContentsA = await api('GET', `/api/supplies/${supB.id}`, sa);
    r.productBadId = await api('POST', '/api/shipping/product', worker1, { supplyId: 'x', sku: 'PB-1', cellBlockId: 'y', pickedQty: 1 });
    r.actBadId = await api('GET', '/api/acts/receipt/not-a-uuid', w1.token);
    r.inboundString = await api('POST', '/api/sellers/inbound', sa, { grid: 'abc' });
    r.inboundObj = await api('POST', '/api/sellers/inbound', sa, { grid: [{ a: 1 }, null, 5] });
    r.alignGarbage = await api('POST', '/api/cells/stock-align', w1.token, { companyId: a, grid: [[{}], ['Конечный остаток', null]] });
    r.pointsBadId = await api('GET', '/api/supplies/shipping-points/not-a-uuid?q=a', w1.token);
    for (const [k, v] of Object.entries(r)) console.log(`  ${k}: ${v.status}${v.body && v.body.error ? ' ' + v.body.error : ''}`);

    check('продавец не оформляет привоз на чужую компанию: companyId из тела игнорируется',
      () => assert.equal(r.inboundForeign.body.summary.matched, 0));
    check('акт приёмки чужого продавца — 404', () => assert.equal(r.actForeignSeller.status, 404));
    check('акт отгрузки продавцу закрыт — 403', () => assert.equal(r.actShipSeller.status, 403));
    check('работник не оформляет привоз — 403', () => assert.equal(r.inboundWorker.status, 403));
    check('чужой склад: акты, поставки продавца, привоз, сверка — 404', () => assert.deepEqual(
      [r.actOtherWh.status, r.shipActOtherWh.status, r.suppliesOtherWh.status, r.inboundOtherWh.status, r.alignOtherWh.status],
      [404, 404, 404, 404, 404]));
    check('грузчик чужого склада не собирает поставку — отказ', () => assert.ok(r.productOtherWh.status >= 400 && r.productOtherWh.status < 500));
    check('продавец А не видит поставок Б', () => assert.deepEqual(r.suppliesA.body, []));
    check('продавец А не открывает поставку Б', () => assert.equal(r.supplyContentsA.status, 404));
    check('мусорные id и таблицы — 400, не 500', () => assert.deepEqual(
      [r.productBadId.status, r.actBadId.status, r.inboundString.status, r.inboundObj.status, r.alignGarbage.status],
      [400, 400, 400, 400, 400]));
    const leftB = Number((await w1.run((c) => c.query(`SELECT SUM(qty) q FROM cell_stock WHERE company_id = $1`, [b]))).rows[0].q);
    check('остаток Б не тронут чужим грузчиком', () => assert.equal(leftB, 5));
  } finally { await stop(); }
  console.log(failed ? `\n${failed} FAIL` : '\nвсе проверки прошли');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exitCode = 1; });
