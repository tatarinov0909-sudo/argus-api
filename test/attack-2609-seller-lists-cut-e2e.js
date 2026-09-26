// Атака 26.09: молчаливая обрезка списков продавца.
//
// /api/sellers/supplies — LIMIT 200 и голый массив: 201-я и старше поставки
// пропадают, признака «показана часть» нет (у заказов и документов он есть —
// hasMore). Кабинет пишет «Показано 200 из 200 поставок».
// /api/sellers/defects — events LIMIT 500 без признака: кабинет пишет
// «500 случаев», хотя их больше.
// Поставка в день — это 200 рабочих дней; брак по штуке с возвратов — быстрее.
const { startApp, warehouse, assert } = require('./attack-helpers');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  const { ok, stop } = await startApp();
  try {
    const w = await warehouse(ok, 'cut');
    const company = await w.company('Продавец много (синтетика)');
    const seller = await w.sellerToken(company);
    const worker = await w.worker('Грузчик');
    const cells = await w.cells([{ rackCount: 2, tierCount: 1 }]);
    await w.run((c) => c.query(`INSERT INTO products (warehouse_id, company_id, sku, name, barcode, stock_qty_1c, stock_at)
      VALUES ($1, $2, 'CU-1', 'Товар много', '4600000000956', 1000, now())`, [w.warehouseId, company]));

    // 201 заказ 1С — 201 поставка (как менеджер составляет их каждый день).
    const ids = (await w.run((c) => c.query(
      `WITH inv AS (
         INSERT INTO invoices (warehouse_id, company_id, number, direction)
         SELECT $1, $2, 'РЛ-CU-' || g, 'out' FROM generate_series(1, 201) g RETURNING id)
       INSERT INTO invoice_items (invoice_id, warehouse_id, company_id, name, sku, declared_qty)
       SELECT id, $1, $2, 'Товар много', 'CU-1', 1 FROM inv RETURNING invoice_id`, [w.warehouseId, company]))).rows.map((r) => r.invoice_id);
    for (const id of ids) await ok('POST', '/api/supplies', w.token, { invoiceIds: [id], marketplace: 'wb', destination: 'СЦ Тест' });
    const got = await ok('GET', '/api/sellers/supplies', seller);
    // Ответ с 26.09 — { rows, hasMore }, как у заказов и документов.
    const supplies = Object.assign(got.rows, { hasMore: got.hasMore });
    console.log('  поставок у продавца: 201; API отдал:', supplies.length, '; признак неполного списка:', supplies.hasMore);
    check('продавец видит все свои поставки или признак «показана часть»',
      () => assert.ok(supplies.length === 201 || supplies.hasMore === true, `отдано ${supplies.length}, признака нет`));

    // 501 случай брака: возврат 501 шт., разобран по штуке как брак.
    const ret = await ok('POST', '/api/invoices', w.token, { companyId: company, number: 'ВЗ-CU', direction: 'return',
      items: [{ sku: 'CU-1', name: 'Товар много', declaredQty: 501 }] });
    for (let i = 0; i < 501; i += 1) {
      await ok('POST', '/api/returns', worker, { invoiceItemId: ret.items[0].id, qty: 1, qualityBucket: 'defective',
        cellBlockId: cells[1].id, defectNote: `царапина ${i + 1}` });
    }
    const d = await ok('GET', '/api/sellers/defects', seller);
    const nowQty = d.now.reduce((s, r) => s + r.defective + r.packaging, 0);
    console.log('  брака сейчас:', nowQty, '; случаев отдано:', d.events.length, '; признак неполного списка:', d.hasMore);
    check('продавец видит все случаи брака или признак «показана часть»',
      () => assert.ok(d.events.length === 501 || d.hasMore === true, `отдано ${d.events.length}, признака нет`));
  } catch (err) { failed += 1; console.error('  FAIL  исключение:', err); }
  finally { await stop(); }
  if (failed) { console.log(`FAIL ${failed}`); process.exitCode = 1; }
})();
