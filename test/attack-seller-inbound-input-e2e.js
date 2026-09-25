// Атака 8. Привоз товара продавцом файлом (POST /api/sellers/inbound, 25.09).
//
// Количество из таблицы продавца читается Number() без проверок, которые
// стоят на любом другом входе склада (middleware/qty.js: целое, больше нуля):
//   * «1,5» → в приход уходит 1,5 шт. — склад такое принять не может
//     (приёмка требует целое), расхождение гарантировано;
//   * «0x10» → 16 шт.;
//   * «12 шт» → строка молча исчезает: её нет ни среди узнанных, ни среди
//     «не узнали», хотя модуль обещает «что нет — показываем строкой».
const { startApp, warehouse, assert } = require('./attack-helpers');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  const { api, ok, stop } = await startApp();
  try {
    const w = await warehouse(ok, 'inboundqty');
    const seller = await w.company('Продавец (синтетика)');
    const st = await w.sellerToken(seller);
    await w.run((c) => c.query(
      `INSERT INTO products (warehouse_id, company_id, sku, name, barcode) VALUES
         ($1, $2, 'IQ-1', 'Товар один', '4600000000011'),
         ($1, $2, 'IQ-2', 'Товар два', '4600000000028'),
         ($1, $2, 'IQ-3', 'Товар три', '4600000000035')`, [w.warehouseId, seller]));

    const grid = [['Баркод', 'Количество'], ['4600000000011', '1,5'], ['4600000000028', '0x10'], ['4600000000035', '12 шт']];
    const preview = await ok('POST', '/api/sellers/inbound', st, { grid });
    console.log('  предпросмотр:', JSON.stringify(preview.lines.map((l) => [l.barcode, l.qty])), JSON.stringify(preview.summary));
    const line = (bc) => preview.lines.find((l) => l.barcode === bc);
    check('«1,5» шт. не принимается как количество штучного товара', () => assert.ok(!line('4600000000011')
      || Number.isInteger(line('4600000000011').qty), `qty=${line('4600000000011') && line('4600000000011').qty}`));
    check('«0x10» не превращается в 16 шт.', () => assert.notEqual(line('4600000000028') && line('4600000000028').qty, 16));
    check('строка «12 шт» не пропадает молча — продавец её видит', () => assert.ok(line('4600000000035'),
      'строки с товаром IQ-3 нет в ответе вообще'));

    const applied = await api('POST', '/api/sellers/inbound', st, { grid, apply: true });
    if (applied.status === 200) {
      const items = (await w.run((c) => c.query(
        'SELECT sku, declared_qty FROM invoice_items WHERE invoice_id = $1 ORDER BY sku', [applied.body.invoice.id]))).rows;
      console.log('  в приход склада записано:', JSON.stringify(items));
      check('в приходе склада нет дробных штук', () => assert.ok(items.every((i) => Number.isInteger(Number(i.declared_qty))),
        JSON.stringify(items)));
    } else {
      console.log('  запись отклонена:', applied.status, applied.body.error);
    }
  } finally { await stop(); }
  console.log(failed ? `\n${failed} FAIL` : '\nвсе проверки прошли');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exitCode = 1; });
