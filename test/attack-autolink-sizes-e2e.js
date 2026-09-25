// Атака 1. Авто-связка заказов WB с товаром (mapping.autoLink, 24.09) и связка
// «артикул документа = артикул WB» в сверке с документом (stockAlign, 24.09).
//
// У WB одна карточка (один nmId, один артикул продавца) — это все размеры
// товара; у каждого размера свой штрихкод, а на складе каждый размер — своя
// позиция номенклатуры. autoLink узнаёт товар по штрихкоду, но передаёт в
// mapping.save ещё и nmId с артикулом, а save чинит заказы и стирает старые
// связи по ЛЮБОМУ из ключей. Итог: заказ на размер M собирается как размер S.
const { startApp, warehouse, withTenantContext, assert } = require('./attack-helpers');
const wb = require('../src/marketplaces/wb');
const sync = require('../src/marketplaces/sync');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

// Синтетический заказ WB в том виде, в каком его отдаёт wb.newOrders.
const order = (id, barcode) => ({
  externalId: String(id), article: 'FT-ATK-1', nmId: '5550001', barcodes: [barcode],
  rid: `rid-${id}`, createdAt: new Date().toISOString(), offices: [], requiredMeta: [],
});
const B_S = '2000000000101';
const B_M = '2000000000202';

(async () => {
  const { ok, stop } = await startApp();
  const realSellerInfo = wb.sellerInfo; const realNewOrders = wb.newOrders; const realStatuses = wb.orderStatuses;
  wb.sellerInfo = async () => ({ name: 'Синтетический продавец', inn: '0000000000', tradeMark: 'T', sellerId: 's' });
  wb.orderStatuses = async (_, ids) => ids.map((id) => ({ id: Number(id), supplierStatus: 'new', wbStatus: 'waiting' }));
  try {
    // ---------- A. Кнопка «Забрать заказы» (pullWildberries → autoLink) ----------
    const w = await warehouse(ok, 'autolink');
    const seller = await w.company('Одежда (синтетика)');
    await w.run((c) => c.query(
      `INSERT INTO products (warehouse_id, company_id, sku, name, barcode) VALUES
         ($1, $2, 'SZ-S', 'Футболка размер S', $3), ($1, $2, 'SZ-M', 'Футболка размер M', $4)`,
      [w.warehouseId, seller, B_S, B_M]));
    await ok('POST', '/api/marketplaces/credentials', w.token,
      { companyId: seller, marketplace: 'wb', token: 'synthetic-test-token-not-real' }, 201);

    wb.newOrders = async () => [order(900001, B_S), order(900002, B_M)];
    await ok('POST', '/api/marketplaces/sync', w.token, { companyId: seller });
    // Следующий обмен приносит ещё один заказ на размер S.
    wb.newOrders = async () => [order(900003, B_S)];
    await ok('POST', '/api/marketplaces/sync', w.token, { companyId: seller });

    const skuOf = async (num) => (await w.run((c) => c.query(
      `SELECT ii.sku FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
        WHERE i.warehouse_id = $1 AND i.number = $2`, [w.warehouseId, num]))).rows[0].sku;
    const got = { s1: await skuOf('WB-900001'), m: await skuOf('WB-900002'), s2: await skuOf('WB-900003') };
    console.log('  заказы после обмена:', JSON.stringify(got));
    check('A1. заказ на размер S (штрихкод S) связан с товаром SZ-S', () => assert.equal(got.s1, 'SZ-S'));
    check('A2. заказ на размер M (штрихкод M) связан с товаром SZ-M', () => assert.equal(got.m, 'SZ-M'));
    check('A3. новый заказ на размер S на следующем обмене — тоже SZ-S', () => assert.equal(got.s2, 'SZ-S'));

    // ---------- B. «Сверить с документом» (stockAlign → mapping.save) ----------
    // У размеров в 1С один артикул продавца — FT-ATK-2. Штрихкодов в карточках
    // нет, поэтому autoLink тут ни при чём: связывает только сверка.
    const w2 = await warehouse(ok, 'align-article');
    const s2 = await w2.company('Одежда-2 (синтетика)');
    await w2.run((c) => c.query(
      `INSERT INTO products (warehouse_id, company_id, sku, name) VALUES
         ($1, $2, 'AL-S', 'Шорты размер S'), ($1, $2, 'AL-M', 'Шорты размер M')`, [w2.warehouseId, s2]));
    await withTenantContext({ warehouseId: w2.warehouseId }, (c) => sync.importOrders(c, w2.warehouseId, {
      companyId: s2,
      orders: [
        { ...order(910001, '2000000000303'), article: 'FT-ATK-2', nmId: '5550002' },
        { ...order(910002, '2000000000404'), article: 'FT-ATK-2', nmId: '5550002' },
      ],
    }));
    const grid = [
      [null, 'Ведомость по товарам на складах'],
      [null, 'Номенклатура.Артикул ', 'Количество'],
      [null, 'Номенклатура.Код', 'Приход', 'Расход', 'Конечный остаток'],
      [null, 'Номенклатура, Базовая единица измерения'],
      [null, 'FT-ATK-2', null, null, 5], [null, 'AL-S', null, null, 5], [null, 'Шорты размер S, шт', null, null, 5],
      [null, 'FT-ATK-2', null, null, 7], [null, 'AL-M', null, null, 7], [null, 'Шорты размер M, шт', null, null, 7],
    ];
    await ok('POST', '/api/cells/stock-align', w2.token, { companyId: s2, grid, apply: true });
    const skus = (await w2.run((c) => c.query(
      `SELECT i.number, ii.sku FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
        WHERE i.warehouse_id = $1 ORDER BY i.number`, [w2.warehouseId]))).rows;
    console.log('  заказы после сверки:', JSON.stringify(skus));
    // Какой размер нужен заказам, по общему артикулу не понять: связывать
    // ОБА заказа с одним размером — значит один из них собрать не тем товаром.
    // Верно — связать по однозначному ключу или оставить несопоставленным,
    // но не выдать заказу чужой размер.
    const bySkuOf = Object.fromEntries(skus.map((r) => [r.number, r.sku]));
    check('B1. заказ WB-910001 (размер S) не связан с размером M',
      () => assert.notEqual(bySkuOf['WB-910001'], 'AL-M'));
    check('B2. заказ WB-910002 (размер M) не связан с размером S',
      () => assert.notEqual(bySkuOf['WB-910002'], 'AL-S'));
  } finally {
    wb.sellerInfo = realSellerInfo; wb.newOrders = realNewOrders; wb.orderStatuses = realStatuses;
    await stop();
  }
  console.log(failed ? `\n${failed} FAIL` : '\nвсе проверки прошли');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exitCode = 1; });
