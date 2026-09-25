// Атака 13. Одновременные «Отправить на склад» (POST /api/sellers/inbound,
// apply: true, 25.09).
//
// Номер прихода ПР-ДДММ-N считается как «первый свободный» чтением таблицы и
// вставляется без повтора при столкновении (у номера поставки такой повтор
// есть — supplies/service.js insertWithNumber). Два продавца, отправившие
// привоз в одну секунду, получают один номер; второй — отказ «Такая запись
// уже существует», хотя ничего такого он не делал.
const { startApp, warehouse, assert } = require('./attack-helpers');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  const { api, ok, stop } = await startApp();
  try {
    const w = await warehouse(ok, 'inboundrace');
    const sellers = [];
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const id = await w.company(`Продавец ${n} (синтетика)`);
      await w.run((c) => c.query(
        `INSERT INTO products (warehouse_id, company_id, sku, name, barcode) VALUES ($1, $2, $3, 'Товар', $4)`,
        [w.warehouseId, id, `RC-${n}`, `460000000100${n}`]));
      sellers.push({ id, token: await w.sellerToken(id), barcode: `460000000100${n}` });
    }
    const results = await Promise.all(sellers.map((s) => api('POST', '/api/sellers/inbound', s.token,
      { grid: [['Баркод', 'Количество'], [s.barcode, 3]], apply: true })));
    console.log('  ответы:', results.map((r) => r.status + (r.status === 200 ? ' ' + r.body.invoice.number : ' ' + r.body.error)).join(' | '));
    check('все одновременные привозы продавцов оформлены', () => assert.ok(results.every((r) => r.status === 200),
      results.map((r) => r.status).join(',')));
  } finally { await stop(); }
  console.log(failed ? `\n${failed} FAIL` : '\nвсе проверки прошли');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exitCode = 1; });
