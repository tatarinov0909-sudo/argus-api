// Атака 26.09: «Привезти товар» (POST /api/sellers/inbound, apply) — кривой ввод.
//
// 1) Дата привоза проверяется только шаблоном \d{4}-\d{2}-\d{2}
//    (src/sellers/inbound.js), столбец source_document_date — TEXT. «31
//    февраля» и «99-99» уходят складу в приход и в журнал («Привезёт
//    31.02.2026»), а в кабинете продавца превращаются в «Invalid Date».
// 2) Сумма одного товара по строкам файла пишется через
//    jsonb_to_recordset(... qty int): 300 строк по 9 999 999 шт. (каждая
//    строка проходит проверку qtyOf) дают 3·10⁹ > int → Postgres 22003 →
//    продавец получает «Внутренняя ошибка сервера» вместо понятного отказа.
const { startApp, warehouse, assert } = require('./attack-helpers');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  const { api, ok, stop } = await startApp();
  try {
    const w = await warehouse(ok, 'inbad');
    const company = await w.company('Продавец ввод (синтетика)');
    const seller = await w.sellerToken(company);
    await w.run((c) => c.query(`INSERT INTO products (warehouse_id, company_id, sku, name, barcode)
      VALUES ($1, $2, 'IB-1', 'Товар ввод', '4600000000949')`, [w.warehouseId, company]));
    const grid = [['Баркод', 'Количество'], ['4600000000949', 3]];

    const feb31 = await api('POST', '/api/sellers/inbound', seller, { grid, apply: true, plannedDate: '2026-02-31' });
    const junk = await api('POST', '/api/sellers/inbound', seller, { grid, apply: true, plannedDate: '2026-99-99' });
    console.log('  дата 2026-02-31:', feb31.status, feb31.body.invoice ? feb31.body.invoice.number : feb31.body.error);
    console.log('  дата 2026-99-99:', junk.status, junk.body.invoice ? junk.body.invoice.number : junk.body.error);
    if (junk.body.invoice) {
      const saved = (await w.run((c) => c.query('SELECT source_document_date FROM invoices WHERE id = $1', [junk.body.invoice.id]))).rows[0];
      const text = (await w.run((c) => c.query('SELECT action_text FROM journal_entries WHERE invoice_id = $1', [junk.body.invoice.id]))).rows[0];
      console.log('  записано в приход:', saved.source_document_date, '; в журнал склада:', text.action_text);
    }
    check('несуществующая дата «2026-02-31» отклоняется (400)', () => assert.equal(feb31.status, 400));
    check('мусорная дата «2026-99-99» отклоняется (400)', () => assert.equal(junk.status, 400));

    const big = [['Баркод', 'Количество']];
    for (let i = 0; i < 300; i += 1) big.push(['4600000000949', 9999999]);
    const preview = await ok('POST', '/api/sellers/inbound', seller, { grid: big });
    const huge = await api('POST', '/api/sellers/inbound', seller, { grid: big, apply: true });
    console.log('  предпросмотр принял строк:', preview.summary.matched, 'штук:', preview.summary.units, '→ отправка:', huge.status, JSON.stringify(huge.body));
    check('переполнение суммы — понятный отказ 400, а не «Внутренняя ошибка сервера» 500',
      () => assert.equal(huge.status, 400));
  } catch (err) { failed += 1; console.error('  FAIL  исключение:', err); }
  finally { await stop(); }
  if (failed) { console.log(`FAIL ${failed}`); process.exitCode = 1; }
})();
