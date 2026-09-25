// Атака 5. «Сверить с документом» (cells/stockAlign.js, 24.09).
//
// «Ведомость по товарам на складах» 1С, построенная по нескольким складам 1С
// (основной, возвратов…), перечисляет один товар несколько раз — по строке в
// группе каждого склада. Сверка обрабатывает каждую строку отдельно и
// «ставит число из документа» по очереди: побеждает последняя строка.
// Предпросмотр при этом обещает одно, а запись делает другое, и повторная
// сверка того же документа снова находит что менять.
const { startApp, warehouse, assert } = require('./attack-helpers');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  const { ok, stop } = await startApp();
  try {
    const w = await warehouse(ok, 'aligndup');
    const seller = await w.company('Продавец (синтетика)');
    await ok('POST', '/api/products', w.token, { companyId: seller, sku: 'AD-1', name: 'Печенье синтетическое' });
    const blocks = await w.cells([{ rackCount: 2, tierCount: 1 }]);
    await w.run((c) => c.query(
      `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty) VALUES ($1, $2, $3, 'AD-1', 50), ($4, $2, $3, 'AD-1', 10)`,
      [blocks[0].id, w.warehouseId, seller, blocks[1].id]));
    const inCells = async () => Number((await w.run((c) => c.query(
      `SELECT COALESCE(SUM(qty), 0) AS q FROM cell_stock WHERE company_id = $1 AND sku = 'AD-1'`, [seller]))).rows[0].q);

    const grid = [
      [null, 'Ведомость по товарам на складах'],
      [null, 'Номенклатура.Артикул ', 'Количество'],
      [null, 'Номенклатура.Код', 'Приход', 'Расход', 'Конечный остаток'],
      [null, 'Номенклатура, Базовая единица измерения'],
      [null, 'Основной склад', null, null, 45],
      [null, 'ART-AD', null, null, 45], [null, 'AD-1', null, null, 45], [null, 'Печенье синтетическое, шт', null, null, 45],
      [null, 'Склад возвратов', null, null, 5],
      [null, 'ART-AD', null, null, 5], [null, 'AD-1', null, null, 5], [null, 'Печенье синтетическое, шт', null, null, 5],
      [null, 'Итого', null, null, 50],
    ];
    const before = await inCells();
    const preview = await ok('POST', '/api/cells/stock-align', w.token, { companyId: seller, grid });
    console.log('  в ячейках было', before, '; документ всего', preview.summary.documentTotal,
      '; предпросмотр обещает +', preview.summary.added, '/ −', preview.summary.removed);
    check('предпросмотр не обещает снять с полок больше, чем там лежит', () => assert.ok(preview.summary.removed <= before,
      `обещано снять ${preview.summary.removed}, а в ячейках ${before}`));

    await ok('POST', '/api/cells/stock-align', w.token, { companyId: seller, grid, apply: true });
    const after = await inCells();
    console.log('  после записи в ячейках', after);
    check('запись делает то, что показал предпросмотр', () => assert.equal(after, before + preview.summary.added - preview.summary.removed));
    check('в ячейках столько, сколько товара в документе (50), а не последняя строка (5)', () => assert.equal(after, 50));

    const again = await ok('POST', '/api/cells/stock-align', w.token, { companyId: seller, grid });
    check('повторная сверка того же документа — менять нечего', () => assert.equal(again.summary.changed, 0,
      JSON.stringify(again.summary)));
  } finally { await stop(); }
  console.log(failed ? `\n${failed} FAIL` : '\nвсе проверки прошли');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exitCode = 1; });
