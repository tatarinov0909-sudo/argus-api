// Атака 26.09: вкладка «Брак» продавца (GET /api/sellers/defects).
//
// «Сейчас на складе» берётся из cell_stock (весь негодный товар), а «Когда
// признан браком» — только из возвратов, перепаковок и пересчётов. Брак,
// положенный загрузкой начальных остатков (окно «Загрузить остатки»,
// состояние «брак» — src/cells/initialStock.js), в «случаи» не попадает.
// Продавец видит «Брак 5 шт.» и тут же «Склад ещё не признавал ваш товар
// браком» (seller-cabinet.js, renderDefects) — откуда брак, узнать не из чего.
const { startApp, warehouse, assert } = require('../attack-helpers');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  const { ok, stop } = await startApp();
  try {
    const w = await warehouse(ok, 'definit');
    const company = await w.company('Продавец брак (синтетика)');
    const seller = await w.sellerToken(company);
    await w.cells([{ rackCount: 2, tierCount: 1 }]);
    await w.run((c) => c.query(`INSERT INTO products (warehouse_id, company_id, sku, name, barcode, stock_qty_1c, stock_at)
      VALUES ($1, $2, 'DF-1', 'Товар брак', '4600000000932', 10, now())`, [w.warehouseId, company]));
    const rows = [{ cell: '1.1.1', sku: 'DF-1', qty: 5, quality: 'брак' }, { cell: '1.1.2', sku: 'DF-1', qty: 3, quality: 'годный' }];
    const plan = await ok('POST', '/api/cells/initial-stock', w.token, { companyId: company, rows });
    const done = await ok('POST', '/api/cells/initial-stock', w.token, { companyId: company, rows, apply: true,
      expect: { ok: plan.summary.ok, units: plan.summary.units } });
    console.log('  загрузка остатков:', done.applied, JSON.stringify(done.summary));

    const d = await ok('GET', '/api/sellers/defects', seller);
    const nowQty = d.now.reduce((s, r) => s + r.defective + r.packaging, 0);
    const eventsQty = d.events.filter((e) => e.sku === 'DF-1').reduce((s, e) => s + e.qty, 0);
    console.log('  «Сейчас на складе»:', JSON.stringify(d.now), '; «Когда признан браком»:', JSON.stringify(d.events));
    check('у брака, который лежит на складе, есть «случай» — откуда он взялся',
      () => assert.ok(eventsQty >= nowQty, `сейчас брака ${nowQty} шт., в случаях ${eventsQty} шт.`));
  } catch (err) { failed += 1; console.error('  FAIL  исключение:', err); }
  finally { await stop(); }
  if (failed) { console.log(`FAIL ${failed}`); process.exitCode = 1; }
})();
