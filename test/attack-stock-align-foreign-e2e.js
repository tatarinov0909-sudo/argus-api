// Атака 9. «Сверить с документом» продавца A забирает карточку товара у
// продавца Б (cells/stockAlign.js, 24.09).
//
// Товар из документа ищется по штрихкоду и названию среди ВСЕХ продавцов
// склада. Один и тот же заводской штрихкод у двух продавцов, перепродающих
// один товар, — обычное дело. Если карточка нашлась у продавца Б, который не
// связан с контрагентом 1С (любой продавец, заведённый в Аргусе руками), и по
// ней ещё не было движений, запись сверки молча переписывает карточку на
// продавца A. У Б товар пропадает из каталога, его связь с WB ведёт в никуда.
const { startApp, warehouse, assert } = require('./attack-helpers');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  const { ok, stop } = await startApp();
  try {
    const w = await warehouse(ok, 'alignforeign');
    const sellerA = await w.company('Продавец А (синтетика)');
    const sellerB = await w.company('Продавец Б (синтетика)');
    // У Б — своя карточка на заводской товар и связь с его карточкой WB.
    await ok('POST', '/api/products', w.token, { companyId: sellerB, sku: 'SB-1', name: 'Лимонад 330мл 2049388157683' });
    await w.run((c) => c.query(
      `INSERT INTO product_marketplace_skus (warehouse_id, company_id, sku, marketplace, mp_sku, mp_article)
       VALUES ($1, $2, 'SB-1', 'wb', '888000111', 'B-LEMON')`, [w.warehouseId, sellerB]));

    // Ведомость продавца A: тот же товар, свой код A-LEMON-1.
    const grid = [
      [null, 'Ведомость по товарам на складах'],
      [null, 'Номенклатура.Артикул ', 'Количество'],
      [null, 'Номенклатура.Код', 'Приход', 'Расход', 'Конечный остаток'],
      [null, 'Номенклатура, Базовая единица измерения'],
      [null, 'A-LEMON', null, null, 7], [null, 'A-LEMON-1', null, null, 7], [null, 'Лимонад 330мл 2049388157683, шт', null, null, 7],
    ];
    const preview = await ok('POST', '/api/cells/stock-align', w.token, { companyId: sellerA, grid });
    console.log('  предпросмотр:', JSON.stringify(preview.lines.map((l) => ({ sku: l.sku, owner: l.owner, note: l.note }))));
    await ok('POST', '/api/cells/stock-align', w.token, { companyId: sellerA, grid, apply: true });

    const card = (await w.run((c) => c.query(`SELECT company_id FROM products WHERE warehouse_id = $1 AND sku = 'SB-1'`,
      [w.warehouseId]))).rows;
    console.log('  владелец карточки SB-1 после сверки А:', card[0] && (card[0].company_id === sellerB ? 'Б' : card[0].company_id === sellerA ? 'А' : card[0].company_id));
    check('сверка документа продавца А не отбирает карточку у продавца Б', () => assert.equal(card[0].company_id, sellerB));
    // Связь Б с его карточкой WB теперь указывает на товар, которого у Б нет:
    // его заказы WB перестают сопоставляться.
    const orphan = (await w.run((c) => c.query(
      `SELECT count(*)::int AS n FROM product_marketplace_skus m
        WHERE m.company_id = $1 AND NOT EXISTS (SELECT 1 FROM products p WHERE p.company_id = m.company_id AND p.sku = m.sku)`,
      [sellerB]))).rows[0].n;
    console.log('  связей WB у Б, ведущих в никуда:', orphan);
    check('связи WB продавца Б по-прежнему ведут к его товару', () => assert.equal(orphan, 0));
  } finally { await stop(); }
  console.log(failed ? `\n${failed} FAIL` : '\nвсе проверки прошли');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exitCode = 1; });
