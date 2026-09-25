// Атака 2. Сборка поставки по товару (POST /api/shipping/product, 24.09).
//
// Состав поставки (GET /api/supplies/:id) помечает позицию с отметкой «нет
// товара» (missing: true), и экран грузчика по товару её не считает: «нужно
// ещё» = только неотмеченные позиции. Сервер же раскладывает взятое по ВСЕМ
// открытым позициям, старшим номерам первыми — в том числе в отмеченную.
// Итог: штука уходит в заказ, который руководитель собирался убрать из
// поставки; убрать его уже нельзя («уже отобрано»), а другой заказ остаётся
// несобранным, хотя грузчик взял ровно сколько просил экран.
const { startApp, warehouse, assert } = require('./attack-helpers');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  const { api, ok, stop } = await startApp();
  try {
    const w = await warehouse(ok, 'pickprod');
    const seller = await w.company('Продавец (синтетика)');
    const worker = await w.worker();
    await ok('POST', '/api/products', w.token, { companyId: seller, sku: 'PX-1', name: 'Кружка синтетическая' });
    const blocks = await w.cells([{ rackCount: 2, tierCount: 1 }]);
    // На полке две штуки на три заказа.
    await w.run((c) => c.query(
      `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty) VALUES ($1, $2, $3, 'PX-1', 2)`,
      [blocks[0].id, w.warehouseId, seller]));
    const orders = [];
    for (const n of [1, 2, 3]) {
      const inv = await ok('POST', '/api/invoices', w.token, { companyId: seller, number: `WB-ATK-${n}`, direction: 'out',
        items: [{ name: 'Кружка синтетическая', sku: 'PX-1', declaredQty: 1 }] });
      orders.push(inv);
    }
    // Заказы площадки: источник WB и номер отправления, как после обмена.
    await w.run((c) => c.query(`UPDATE invoices SET source = 'wb' WHERE warehouse_id = $1`, [w.warehouseId]));
    await w.run((c) => c.query(`UPDATE invoice_items SET mp_rid = 'rid-' || id::text WHERE warehouse_id = $1`, [w.warehouseId]));
    const supply = await ok('POST', '/api/supplies', w.token, { invoiceIds: orders.map((o) => o.id) }, 201);

    // Грузчик в заказе WB-ATK-1 не нашёл товар и отметил «нет товара».
    const item1 = orders[0].items[0].id;
    await ok('POST', '/api/shipping/missing', worker, { invoiceItemId: item1, missingQty: 1 }, 201);

    // Что видит экран «Собирать по товарам».
    const contents = await ok('GET', `/api/supplies/${supply.id}`, worker);
    const leftForScreen = contents.packing.filter((l) => l.sku === 'PX-1' && !l.missing)
      .reduce((s, l) => s + Number(l.left), 0);
    console.log('  экран грузчика: нужно ещё', leftForScreen, 'шт. (отмеченный заказ не в счёт)');
    assert.equal(leftForScreen, 2);

    // Грузчик берёт с полки ровно столько, сколько просит экран.
    await ok('POST', '/api/shipping/product', worker,
      { supplyId: supply.id, sku: 'PX-1', cellBlockId: blocks[0].id, pickedQty: leftForScreen }, 201);

    const picked = (await w.run((c) => c.query(
      `SELECT i.number, i.status, COALESCE(SUM(sr.picked_qty), 0)::int AS picked
         FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
         LEFT JOIN shipping_records sr ON sr.invoice_item_id = ii.id
        WHERE i.supply_id = $1 GROUP BY i.number, i.status ORDER BY i.number`, [supply.id]))).rows;
    console.log('  разложено сервером:', JSON.stringify(picked));
    const by = Object.fromEntries(picked.map((r) => [r.number, r]));
    check('заказ с отметкой «нет товара» (WB-ATK-1) не получил взятое по товару', () => assert.equal(by['WB-ATK-1'].picked, 0));
    check('взятые 2 шт. закрыли те два заказа, для которых их брали (WB-ATK-2, WB-ATK-3)',
      () => assert.deepEqual([by['WB-ATK-2'].status, by['WB-ATK-3'].status], ['ready', 'ready']));

    // Руководитель делает то, ради чего грузчик ставил отметку: убирает заказ.
    const removed = await api('POST', `/api/supplies/orders/${orders[0].id}/remove`, w.token, {});
    console.log('  убрать WB-ATK-1 из поставки:', removed.status, removed.body.error || '');
    check('руководитель может убрать отмеченный заказ из поставки', () => assert.equal(removed.status, 200));
  } finally { await stop(); }
  console.log(failed ? `\n${failed} FAIL` : '\nвсе проверки прошли');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exitCode = 1; });
