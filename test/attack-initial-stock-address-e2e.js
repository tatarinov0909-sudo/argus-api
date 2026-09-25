// Атака 3. Адрес ячейки «ряд.ярус.ячейка» (решение 24.09, коммит 4634956).
//
// Все экраны и листы (лист комплектации, экран грузчика, карта, выгрузка
// «Остатки склада» из кабинета) теперь пишут адрес как ряд.ЯРУС.ячейка. А
// «Загрузить остатки» (cells/initialStock.js) по-прежнему читает адрес из
// файла как ряд.ЯЧЕЙКА.ярус. Склад пишет в файл адрес так, как видит его на
// экране, — и товар ложится в другую ячейку, без единой ошибки.
const { startApp, warehouse, assert } = require('./attack-helpers');
const { formatBlockLabel } = require('../src/cells/label');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  const { ok, stop } = await startApp();
  try {
    const w = await warehouse(ok, 'initaddr');
    const seller = await w.company('Продавец (синтетика)');
    await ok('POST', '/api/products', w.token, { companyId: seller, sku: 'IA-1', name: 'Товар синтетический' });
    const blocks = await w.cells([{ rackCount: 3, tierCount: 3 }]);
    // Ячейка: ряд 1, ярус 1, вторая ячейка вдоль ряда (rack 2).
    const target = blocks.find((b) => b.rack_start === 2 && b.tier_start === 1);
    const shown = formatBlockLabel(target.row_num, target);
    console.log('  адрес ячейки на экранах Аргуса:', shown);
    assert.equal(shown, '1.1.2');

    const rows = [{ line: 2, cell: shown, sku: 'IA-1', qty: '5' }];
    const preview = await ok('POST', '/api/cells/initial-stock', w.token, { companyId: seller, rows });
    const line = preview.lines[0];
    console.log('  проверка файла: ошибка =', line.error, '; ячейка =', line.cellLabel);
    check('проверка файла узнаёт ту же ячейку, что показана на экране', () => assert.equal(line.cellId, target.id));
    check('проверка файла называет ячейку тем же адресом, что вписан в файл', () => assert.equal(line.cellLabel, shown));

    const applied = await ok('POST', '/api/cells/initial-stock', w.token, { companyId: seller, rows, apply: true });
    const where = (await w.run((c) => c.query(
      `SELECT cs.cell_block_id, cb.rack_start, cb.tier_start FROM cell_stock cs JOIN cell_blocks cb ON cb.id = cs.cell_block_id
        WHERE cs.warehouse_id = $1 AND cs.sku = 'IA-1'`, [w.warehouseId]))).rows;
    console.log('  загружено:', applied.applied, '; товар лёг в', JSON.stringify(where));
    check('после загрузки товар лежит в ячейке «1.1.2» (ряд 1, ярус 1, ячейка 2)',
      () => assert.deepEqual(where.map((r) => r.cell_block_id), [target.id]));
  } finally { await stop(); }
  console.log(failed ? `\n${failed} FAIL` : '\nвсе проверки прошли');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exitCode = 1; });
