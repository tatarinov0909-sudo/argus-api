// Атака 6. «Не хватит товара» при составлении поставки (supplies/service.js
// stockCover и pendingOrders, 24.09).
//
// Оценка «хватит ли товара на полках» считает потребность как «заказано
// минус собрано» и не смотрит, закрыта ли позиция. Позиция, закрытая с
// нехваткой (взяли 3 из 5), и заказ, уже полностью собранный (но не уехавший),
// всё равно «едят» остаток на полке. Итог — ложные «Не хватит товара» у
// поставки и «на полке не хватает» у заказов, которые склад соберёт целиком.
const { startApp, warehouse, assert } = require('./attack-helpers');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  const { ok, stop } = await startApp();
  try {
    const w = await warehouse(ok, 'cover');
    const seller = await w.company('Продавец (синтетика)');
    const worker = await w.worker();
    for (const sku of ['SC-1', 'SC-2', 'SC-3', 'SC-4']) {
      await ok('POST', '/api/products', w.token, { companyId: seller, sku, name: `Товар ${sku}` });
    }
    const blocks = await w.cells([{ rackCount: 4, tierCount: 1 }]);
    const put = (i, sku, qty) => w.run((c) => c.query(
      `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty) VALUES ($1, $2, $3, $4, $5)`,
      [blocks[i].id, w.warehouseId, seller, sku, qty]));
    await put(0, 'SC-1', 3); await put(1, 'SC-2', 1); await put(2, 'SC-3', 6); await put(3, 'SC-4', 8);
    const mk = async (number, sku, qty) => ok('POST', '/api/invoices', w.token, { companyId: seller, number, direction: 'out',
      items: [{ name: `Товар ${sku}`, sku, declaredQty: qty }] });
    const pick = (inv, qty, block) => ok('POST', '/api/shipping', worker,
      { invoiceItemId: inv.items[0].id, pickedQty: qty, cellBlockId: blocks[block].id, isFinal: true }, 201);

    // Поставка (собирается): I1 SC-1×5 и I3 SC-4×5 закрыты с нехваткой (3 из 5),
    // I2 SC-2×1 ещё не собран — для него на полке есть 1 шт.
    const i1 = await mk('ATK-C-1', 'SC-1', 5);
    const i2 = await mk('ATK-C-2', 'SC-2', 1);
    const i3 = await mk('ATK-C-3', 'SC-4', 5);
    const supply = await ok('POST', '/api/supplies', w.token, { invoiceIds: [i1.id, i2.id, i3.id] }, 201);
    await pick(i1, 3, 0);
    await pick(i3, 3, 3);
    // Накладная 1С без поставки: собрана целиком (2 из 2), ещё не уехала.
    const r = await mk('ATK-C-4', 'SC-3', 2);
    await pick(r, 2, 2);
    // Новые заказы в очереди. На полках сейчас: SC-4 — 5 шт., SC-3 — 4 шт.
    await mk('ATK-C-5', 'SC-4', 5);
    await mk('ATK-C-6', 'SC-3', 4);

    const s = (await ok('GET', '/api/supplies', w.token)).find((x) => x.id === supply.id);
    console.log('  поставка:', s.status, '; «Не хватит товара»:', s.stockShort, '(открыт только I2, и на него товар есть)');
    check('у поставки нет ложной отметки «Не хватит товара»', () => assert.equal(s.stockShort, 0));

    const queue = await ok('GET', `/api/supplies/pending/${seller}`, w.token);
    const short = Object.fromEntries(queue.map((o) => [o.number, o.stockShort]));
    console.log('  очередь, «на полке не хватает»:', JSON.stringify(short));
    check('заказ ATK-C-5 (SC-4 × 5, на полке 5) не помечен «не хватает»', () => assert.equal(short['ATK-C-5'], false));
    check('заказ ATK-C-6 (SC-3 × 4, на полке 4) не помечен «не хватает»', () => assert.equal(short['ATK-C-6'], false));
  } finally { await stop(); }
  console.log(failed ? `\n${failed} FAIL` : '\nвсе проверки прошли');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exitCode = 1; });
