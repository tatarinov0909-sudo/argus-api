// Атака 26.09: проверка перед архивом продавца (PATCH
// /api/sellers/companies/:id/archive) смотрит только поставки. Её смысл,
// по комментарию в коде: «Если ... товар уже снят с полок, он исчез бы из
// учёта: ни на полке, ни в отгрузке». Но заказ 1С собирают и без поставки
// (shipping/routes.js: source='1c' можно без supply_id). Такой заказ собран —
// товар снят с полки — а архив проходит, и заказ пропадает с экранов склада:
// список накладных у грузчика скрывает архивные компании.
const { startApp, warehouse, assert } = require('./attack-helpers');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  const { api, ok, stop } = await startApp();
  try {
    const w = await warehouse(ok, 'archpick');
    const company = await w.company('Продавец архив (синтетика)');
    const worker = await w.worker('Грузчик');
    const cells = await w.cells([{ rackCount: 2, tierCount: 1 }]);
    await w.run((c) => c.query(`INSERT INTO products (warehouse_id, company_id, sku, name, barcode, stock_qty_1c, stock_at)
      VALUES ($1, $2, 'AR-1', 'Товар архив', '4600000000925', 10, now())`, [w.warehouseId, company]));
    const inv = await ok('POST', '/api/invoices', w.token, { companyId: company, number: 'ПР-AR1', direction: 'in',
      items: [{ sku: 'AR-1', name: 'Товар архив', declaredQty: 10 }] });
    await ok('POST', '/api/receiving', worker, { invoiceItemId: inv.items[0].id, acceptedQty: 10, cellBlockId: cells[0].id });

    // Заказ 1С (реализация) — без поставки. Собран целиком: 6 шт. сняты с полки.
    const out = await ok('POST', '/api/invoices', w.token, { companyId: company, number: 'РЛ-AR1', direction: 'out',
      items: [{ sku: 'AR-1', name: 'Товар архив', declaredQty: 6 }] });
    await ok('POST', '/api/shipping', worker, { invoiceItemId: out.items[0].id, pickedQty: 6, cellBlockId: cells[0].id });
    const shelf = (await w.run((c) => c.query('SELECT COALESCE(SUM(qty),0)::int AS q FROM cell_stock WHERE company_id = $1', [company]))).rows[0].q;
    console.log('  на полке осталось', shelf, 'из 10; 6 шт. сняты под заказ РЛ-AR1 (status ready, поставки нет)');

    const res = await api('PATCH', `/api/sellers/companies/${company}/archive`, w.token, { archived: true });
    console.log('  архив:', res.status, JSON.stringify(res.body));
    const workerList = await ok('GET', '/api/invoices?direction=out', worker);
    console.log('  заказ в списке грузчика после архива:', workerList.some((i) => i.id === out.id));

    check('архив отказывает, пока собранный (снятый с полок) заказ не отгружен и не возвращён на полку',
      () => assert.equal(res.status, 409));
    check('собранный заказ не пропадает с экрана склада', () => assert.ok(workerList.some((i) => i.id === out.id)));
  } catch (err) { failed += 1; console.error('  FAIL  исключение:', err); }
  finally { await stop(); }
  if (failed) { console.log(`FAIL ${failed}`); process.exitCode = 1; }
})();
