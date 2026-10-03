// Мелочи из проверки 03.10.2026, которых нет в тестах находок:
// продавцу не отдаём, как хранится товар; «Склад брака» — служебное имя;
// «Понятно» гасит только свой блок уведомлений; брака меньше, чем решено, —
// продавец видит «выполнено X из Y» и уведомление; штрихкод уценки не может
// быть штрихкодом обычного товара.
const assert = require('node:assert/strict');
const { startApp, stand, fail } = require('./attack-0310/_lib');

(async () => {
  const app = await startApp();
  try {
    const s = await stand(app, { skus: [['R-1', 'Резинки чёрные'], ['R-2', 'Резинки белые']] });
    const { ok, api } = app;
    const [A, , , D] = s.cells;
    await s.q('UPDATE products SET barcode = $2 WHERE company_id = $1 AND sku = $3', [s.company, '4600000000022', 'R-2']);

    const ozon = await ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'Озон', marketplace: 'ozon', keepSeparate: true });
    const mine = await ok('GET', '/api/vwarehouses', s.seller);
    assert.ok(mine.warehouses.every((w) => !('keepSeparate' in w) && !('defectSeparate' in w)), 'продавцу — без «хранить отдельно»');
    assert.ok((await ok('GET', `/api/vwarehouses?companyId=${s.company}`, s.owner)).warehouses.some((w) => w.keepSeparate));
    assert.ok((await api('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'склад брака', marketplace: 'other' })).status >= 400);

    // Два уведомления разных блоков: «Понятно» по одному гасит только его.
    await s.q(`INSERT INTO seller_notifications (warehouse_id, company_id, kind, text) VALUES ($1, $2, 'ff_decided', 'склад решил сам'), ($1, $2, 'vw_moved', 'перенос')`,
      [s.warehouseId, s.company]);
    const notes = (await ok('GET', '/api/vwarehouses/notifications', s.seller)).filter((n) => n.unseen);
    const self = notes.find((n) => n.kind === 'ff_decided');
    await ok('POST', '/api/vwarehouses/notifications/seen', s.seller, { ids: [self.id] });
    const after = await ok('GET', '/api/vwarehouses/notifications', s.seller);
    assert.equal(after.find((n) => n.id === self.id).unseen, false);
    assert.ok(after.some((n) => n.kind === 'vw_moved' && n.unseen), 'другой блок не погашен');
    assert.equal((await api('POST', '/api/vwarehouses/notifications/seen', s.seller, { ids: ['x'] })).status, 400);

    // Брака 3, решили утилизировать 3, пересчёт нашёл 1: выполнено 1 из 3.
    const r = await s.receive([{ vw: null, qty: 5, cell: A }]);
    assert.equal(r.results[0].status, 201);
    await ok('POST', '/api/defects/moves', s.worker, { companyId: s.company, sku: 'R-1', fromCellBlockId: A.id, toCellBlockId: D.id,
      qty: 3, bucket: 'defective', source: 'move' });
    const dec = await ok('POST', '/api/sellers/defects/decisions', s.seller, { sku: 'R-1', bucket: 'defective', qty: 3, action: 'dispose' });
    await s.recount(D, [{ quality: 'defective', qty: 1 }]);
    const done = await ok('POST', `/api/defects/tasks/${dec.id}/done`, s.worker, {});
    assert.deepEqual([done.qty, done.doneQty, done.total, done.status, done.short], [1, 1, 3, 'done', 2]);
    const view = await ok('GET', '/api/sellers/defects', s.seller);
    assert.equal(view.decisions.find((x) => x.id === dec.id).doneQty, 1);
    const short = (await ok('GET', '/api/vwarehouses/notifications', s.seller)).find((n) => n.kind === 'defect_short');
    assert.ok(short && /выполнено 1 из 3/.test(short.text), JSON.stringify(short));

    // Уценка со штрихкодом обычного товара продавца — отказ.
    await ok('POST', '/api/defects/moves', s.worker, { companyId: s.company, sku: 'R-1', fromCellBlockId: A.id, toCellBlockId: D.id,
      qty: 1, bucket: 'defective', source: 'move' });
    const md = await api('POST', '/api/sellers/defects/decisions', s.seller,
      { sku: 'R-1', bucket: 'defective', qty: 1, action: 'markdown', markdownBarcode: '4600000000022' });
    assert.equal(md.status, 409, JSON.stringify(md.body));
    console.log('PASS склады и брак: продавцу без хранения, «Понятно» по блоку, брак на найденное, уценка');
  } catch (e) { fail(e); } finally { await app.stop(); }
})();
