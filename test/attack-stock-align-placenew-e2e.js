// Атака 12. «Сверить с документом» с галочкой «товар без ячейки класть в
// свободные ячейки» (cells/stockAlign.js, 24.09).
//
// «Свободную» ячейку сверка берёт у подсказки Кладовщика (suggestCells),
// первое правило которой — «ячейка, где уже лежит этот артикул» у ЛЮБОГО
// продавца. Если у продавца Б тот же код товара (код у двух продавцов может
// совпадать — так пишет и сам код склада), товар продавца A записывается в
// ячейку, где лежит товар Б, а в отчёте сверки она названа «свободной».
const { startApp, warehouse, assert } = require('./attack-helpers');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  const { ok, stop } = await startApp();
  try {
    const w = await warehouse(ok, 'placenew');
    const sellerA = await w.company('Продавец А (синтетика)');
    const sellerB = await w.company('Продавец Б (синтетика)');
    await ok('POST', '/api/products', w.token, { companyId: sellerA, sku: 'SAME-1', name: 'Товар А' });
    await ok('POST', '/api/products', w.token, { companyId: sellerB, sku: 'SAME-1', name: 'Товар Б' });
    const blocks = await w.cells([{ rackCount: 4, tierCount: 1 }]);
    // Ячейка 1.1.3 занята товаром продавца Б.
    const busy = blocks.find((b) => b.rack_start === 3);
    await w.run((c) => c.query(
      `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty) VALUES ($1, $2, $3, 'SAME-1', 20)`,
      [busy.id, w.warehouseId, sellerB]));
    await w.run((c) => c.query(`UPDATE cell_blocks SET state = 'occupied' WHERE id = $1`, [busy.id]));

    const grid = [
      [null, 'Ведомость по товарам на складах'],
      [null, 'Номенклатура.Код', 'Приход', 'Расход', 'Конечный остаток'],
      [null, 'Номенклатура, Базовая единица измерения'],
      [null, 'SAME-1', null, null, 7], [null, 'Товар А, шт', null, null, 7],
    ];
    const res = await ok('POST', '/api/cells/stock-align', w.token, { companyId: sellerA, grid, apply: true, placeNew: true });
    console.log('  отчёт сверки:', res.lines.map((l) => l.note).join(' | '));
    const placed = (await w.run((c) => c.query(
      `SELECT cs.cell_block_id,
              (SELECT array_agg(DISTINCT x.company_id::text) FROM cell_stock x WHERE x.cell_block_id = cs.cell_block_id) AS owners
         FROM cell_stock cs WHERE cs.company_id = $1 AND cs.sku = 'SAME-1'`, [sellerA]))).rows;
    console.log('  товар А записан в ячейку', placed[0] && (placed[0].cell_block_id === busy.id ? 'с товаром Б' : 'другую'),
      '; продавцов в ней:', placed[0] && placed[0].owners.length);
    check('товар А лёг не в ячейку, где лежит товар продавца Б', () => assert.notEqual(placed[0].cell_block_id, busy.id));
  } finally { await stop(); }
  console.log(failed ? `\n${failed} FAIL` : '\nвсе проверки прошли');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exitCode = 1; });
