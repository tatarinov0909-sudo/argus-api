// Две вкладки одного грузчика отправляют одну и ту же часть возврата.
// Ограничение общей суммы защищает только последнюю часть, но не промежуточную.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Повтор частичной сортировки возврата');
  try {
    const s = await stand(app); const { ok, api } = app;
    const [A, D] = s.cells;
    const ret = await ok('POST', '/api/returns/manual', s.worker, { companyId: s.company, items: [{ sku: 'R-1', qty: 10 }] });
    // Обе вкладки открыли одну и ту же ещё не разобранную позицию: 10 шт.
    const [leftTab, rightTab] = await Promise.all([ok('GET', `/api/invoices/${ret.id}`, s.worker), ok('GET', `/api/invoices/${ret.id}`, s.worker)]);
    if (leftTab.items[0].id !== rightTab.items[0].id) throw Error('Вкладки смотрят разные позиции');
    // Физически годны 3, бракованы 7. Повторяем один запрос из устаревшей вкладки.
    // Экран грузчика отправляет, сколько уже разобрано по его данным (seenQty).
    const body = { invoiceItemId: leftTab.items[0].id, qty: 3, qualityBucket: 'good', cellBlockId: A.id, seenQty: Number(leftTab.items[0].returned_qty || 0) };
    const two = await Promise.all([api('POST', '/api/returns', s.worker, body), api('POST', '/api/returns', s.worker, body)]);
    const records = await s.q('SELECT quality_bucket, qty::int FROM return_records WHERE invoice_item_id = $1', [body.invoiceItemId]);
    const goodQty = records.filter((r) => r.quality_bucket === 'good').reduce((n, r) => n + r.qty, 0);
    const stock = (await ok('GET', '/api/sellers/stock', s.seller)).rows.find((r) => r.sku === 'R-1');
    v.expect('одна часть возврата из двух вкладок не записывается дважды', goodQty === 3,
      '3 годных, повтор отклонён или возвращает прежний результат', JSON.stringify({ statuses: two.map((r) => r.status), goodQty, sellerTotal: stock && stock.total }));
    const rest = await api('POST', '/api/returns', s.worker, { invoiceItemId: body.invoiceItemId, qty: 7, qualityBucket: 'defective', cellBlockId: D.id, seenQty: 3 });
    v.expect('после повтора можно разобрать реальные оставшиеся 7 шт.', rest.status === 201,
      '3 годных + 7 брака = 10', JSON.stringify({ status: rest.status, error: rest.body && rest.body.error }));
    console.log('Факты: ' + JSON.stringify({ totalDeclared: 10, actualGood: 3, duplicateGoodInSystem: goodQty, statusPair: two.map((r) => r.status), actualDefectRejected: rest.status }));
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
