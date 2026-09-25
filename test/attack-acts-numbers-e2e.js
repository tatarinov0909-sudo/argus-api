// Атака 4. Акты (src/acts/routes.js, 24.09): юридические бумаги с неверными
// цифрами и датой.
//
//  а) «Акт отгрузки с хранения» пишет количество ПО ЗАКАЗУ (declared_qty), а не
//     сколько собрано и уехало. Позиция, закрытая с нехваткой (взяли 3 из 5,
//     «последняя ячейка»), уезжает в поставке, а акт говорит «отгружено 5».
//  б) «Акт приёмки на хранение»: дата — «последняя приёмка», но даты
//     сравниваются как текст Date.toString(): «Thu Oct 01» < «Wed Sep 30», и
//     акт за приёмку 30.09–01.10 датируется 30.09.
const { startApp, warehouse, assert } = require('./attack-helpers');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  const { ok, stop } = await startApp();
  try {
    const w = await warehouse(ok, 'acts');
    const seller = await w.company('Продавец (синтетика)');
    const worker = await w.worker();
    await ok('POST', '/api/products', w.token, { companyId: seller, sku: 'AC-1', name: 'Товар синтетический' });
    await ok('POST', '/api/products', w.token, { companyId: seller, sku: 'AC-2', name: 'Товар синтетический 2' });
    const blocks = await w.cells([{ rackCount: 2, tierCount: 1 }]);

    // ---------- а) акт отгрузки ----------
    await w.run((c) => c.query(
      `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty) VALUES ($1, $2, $3, 'AC-1', 3)`,
      [blocks[0].id, w.warehouseId, seller]));
    const out = await ok('POST', '/api/invoices', w.token, { companyId: seller, number: 'ATK-OUT-1', direction: 'out',
      items: [{ name: 'Товар синтетический', sku: 'AC-1', declaredQty: 5 }] });
    const supply = await ok('POST', '/api/supplies', w.token, { invoiceIds: [out.id] }, 201);
    // На полке только 3: грузчик берёт 3 и закрывает позицию — так велит экран.
    await ok('POST', '/api/shipping', worker,
      { invoiceItemId: out.items[0].id, pickedQty: 3, cellBlockId: blocks[0].id, isFinal: true }, 201);
    await ok('POST', `/api/supplies/${supply.id}/ship`, w.token, {});
    const shipAct = await ok('GET', `/api/acts/shipment/${supply.id}`, w.token);
    console.log('  акт отгрузки:', JSON.stringify(shipAct.items.map((i) => ({ sku: i.sku, qty: i.qty }))), 'уехало фактически 3');
    check('акт отгрузки пишет, сколько фактически уехало (3), а не сколько заказано (5)',
      () => assert.equal(shipAct.items[0].qty, 3));

    // ---------- б) дата акта приёмки ----------
    const inv = await ok('POST', '/api/invoices', w.token, { companyId: seller, number: 'ATK-IN-1', direction: 'in',
      items: [{ name: 'Товар синтетический', sku: 'AC-1', declaredQty: 2 }, { name: 'Товар синтетический 2', sku: 'AC-2', declaredQty: 2 }] });
    for (const it of inv.items) {
      await ok('POST', '/api/receiving', worker, { invoiceItemId: it.id, acceptedQty: 2, cellBlockId: blocks[1].id });
    }
    // Первая позиция принята в среду 30.09, вторая — в четверг 01.10.
    const [first, second] = inv.items.map((i) => i.id);
    await w.run((c) => c.query(`UPDATE receiving_records SET finished_at = '2026-09-30T10:00:00+03' WHERE invoice_item_id = $1`, [first]));
    await w.run((c) => c.query(`UPDATE receiving_records SET finished_at = '2026-10-01T10:00:00+03' WHERE invoice_item_id = $1`, [second]));
    const recAct = await ok('GET', `/api/acts/receipt/${inv.id}`, w.token);
    const day = new Date(recAct.date).toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
    console.log('  дата акта приёмки:', day, '(последняя приёмка — 2026-10-01)');
    check('дата акта приёмки — день последней приёмки, 01.10', () => assert.equal(day, '2026-10-01'));
  } finally { await stop(); }
  console.log(failed ? `\n${failed} FAIL` : '\nвсе проверки прошли');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exitCode = 1; });
