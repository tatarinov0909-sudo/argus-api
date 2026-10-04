// Годный ручной возврат без ячейки закрывается, но не прибавляет товар в остаток.
// Только отдельная локальная БД через argus-review/run-probe.cjs.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Годный возврат без ячейки');
  try {
    const s = await stand(app);
    const { ok, api } = app;
    const [A] = s.cells;
    const received = await s.receive([{ vw: null, qty: 5, cell: A }]);
    if (received.results[0].status !== 201) throw Error('Не удалось подготовить 5 единиц');
    const row = async () => (await ok('GET', '/api/sellers/stock', s.seller)).rows.find((x) => x.sku === 'R-1');
    const before = await row();
    const ret = await ok('POST', '/api/returns/manual', s.worker, { companyId: s.company, items: [{ sku: 'R-1', qty: 3 }] });
    const inv = await ok('GET', `/api/invoices/${ret.id}`, s.worker);
    // Именно такой запрос посылает loader.html, если не выбрать рекомендацию:
    // updateReturnConfirm разрешает годное без selectedCellBlockId.
    const missing = await api('POST', '/api/returns', s.worker, {
      invoiceItemId: inv.items[0].id, qty: 3, qualityBucket: 'good', cellBlockId: null,
    });
    const after = await row();
    const card = await ok('GET', `/api/invoices/${ret.id}`, s.worker);
    const sellerReturn = (await ok('GET', '/api/sellers/documents', s.seller)).rows.find((x) => x.id === ret.id);
    const records = await s.q('SELECT qty::int, cell_block_id FROM return_records WHERE invoice_item_id = $1', [inv.items[0].id]);
    v.expect('годный возврат без места не должен необратимо закрываться',
      missing.status >= 400 || card.status !== 'completed',
      'отказ выбрать ячейку либо явное незавершённое размещение',
      JSON.stringify({ status: missing.status, invoiceStatus: card.status, returnRecords: records }));
    v.expect('принятый годный возврат отражён в учёте или остаётся незавершённым',
      missing.status >= 400 || after.total === before.total + 3 || card.status !== 'completed',
      '5 + 3 = 8 годных либо операция не завершена',
      JSON.stringify({ before: before.total, after: after.total, available: after.available, goodReturn: Number(sellerReturn.good_qty), invoiceStatus: card.status }));
    const correction = await api('POST', '/api/returns', s.worker, {
      invoiceItemId: inv.items[0].id, qty: 3, qualityBucket: 'good', cellBlockId: A.id,
    });
    v.expect('после пропуска места возврат можно закончить размещением',
      missing.status >= 400 || correction.status < 300,
      'первый запрос отклонён либо размещение 3 шт. разрешено',
      JSON.stringify({ first: missing.status, placement: correction.status, error: correction.body && correction.body.error }));
    console.log('Синтетические количества: ' + JSON.stringify({ before: before.total, after: after.total, documentGood: Number(sellerReturn.good_qty), status: card.status }));
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
