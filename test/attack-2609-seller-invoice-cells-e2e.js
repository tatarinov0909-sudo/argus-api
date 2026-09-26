// Атака 26.09: карточка документа в кабинете продавца (GET /api/invoices/:id,
// её зовёт seller-cabinet.js → openDocument) отдаёт продавцу адреса ячеек
// склада (ряд, стеллаж, ярус) и причины пауз грузчиков.
//
// Правило (.business/seller-cabinet.md): «Продавцу не показываются ...
// внутренние коды склада, адреса ячеек». Так же сделано в /api/sellers/history
// (fromCell/toCell вырезаются) и в /api/supplies/:id («без адресов ячеек:
// раскладка склада его не касается и в других местах от него скрыта»).
// Здесь — нет.
const { startApp, warehouse, assert } = require('./attack-helpers');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}
const CELL_KEYS = /^(row_num|rack_start|rack_end|tier_start|tier_end|rowNum|rackStart|rackEnd|tierStart|tierEnd)$/;
function cellFields(obj, path = '') {
  const out = [];
  if (Array.isArray(obj)) obj.forEach((v, i) => out.push(...cellFields(v, `${path}[${i}]`)));
  else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (CELL_KEYS.test(k) && v !== null && v !== undefined) out.push(`${path}.${k}=${v}`);
      else out.push(...cellFields(v, `${path}.${k}`));
    }
  }
  return out;
}

(async () => {
  const { ok, stop } = await startApp();
  try {
    const w = await warehouse(ok, 'invcells');
    const company = await w.company('Продавец ячейки (синтетика)');
    const seller = await w.sellerToken(company);
    const worker = await w.worker('Грузчик Пётр');
    const cells = await w.cells([{ rackCount: 3, tierCount: 2 }]);
    await w.run((c) => c.query(`INSERT INTO products (warehouse_id, company_id, sku, name, barcode, stock_qty_1c, stock_at)
      VALUES ($1, $2, 'IC-1', 'Товар ячейки', '4600000000918', 20, now())`, [w.warehouseId, company]));

    // Приход продавца принят в ячейку; у грузчика была пауза «обед».
    const inv = await ok('POST', '/api/invoices', w.token, { companyId: company, number: 'ПР-IC1', direction: 'in',
      items: [{ sku: 'IC-1', name: 'Товар ячейки', declaredQty: 5 }] });
    await ok('POST', '/api/receiving', worker, { invoiceItemId: inv.items[0].id, acceptedQty: 5, cellBlockId: cells[4].id,
      pausedMs: 900000, pauseReasons: [{ reason: 'обед', ms: 900000 }] });
    // Заказ (1С) собран из ячейки.
    const out = await ok('POST', '/api/invoices', w.token, { companyId: company, number: 'РЛ-IC1', direction: 'out',
      items: [{ sku: 'IC-1', name: 'Товар ячейки', declaredQty: 2 }] });
    await ok('POST', '/api/shipping', worker, { invoiceItemId: out.items[0].id, pickedQty: 2, cellBlockId: cells[4].id });

    const inDoc = await ok('GET', `/api/invoices/${inv.id}`, seller);
    const outDoc = await ok('GET', `/api/invoices/${out.id}`, seller);
    const inLeak = cellFields(inDoc);
    const outLeak = cellFields(outDoc);
    console.log('  продавцу в приходе:', JSON.stringify(inDoc.items[0]));
    console.log('  продавцу в заказе:', JSON.stringify(outDoc.items[0].picks));

    check('приход: продавец не получает адрес ячейки, куда положили товар', () => assert.deepEqual(inLeak, []));
    check('приход: продавец не получает причины пауз грузчика', () => assert.ok(
      !inDoc.items.some((i) => Array.isArray(i.pause_reasons) && i.pause_reasons.length),
      JSON.stringify(inDoc.items.map((i) => i.pause_reasons))));
    check('заказ: продавец не получает адреса ячеек, откуда собирали', () => assert.deepEqual(outLeak, []));
  } catch (err) { failed += 1; console.error('  FAIL  исключение:', err); }
  finally { await stop(); }
  if (failed) { console.log(`FAIL ${failed}`); process.exitCode = 1; }
})();
