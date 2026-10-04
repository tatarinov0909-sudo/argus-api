// Один возврат можно полностью провести в независимых receiving_records и return_records.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');
(async () => {
  const app = await startApp(); const v = verdicts('Возврат через два API учёта');
  try {
    const s = await stand(app);
    const ret = await app.ok('POST', '/api/returns/manual', s.worker, { companyId: s.company, items: [{ sku: 'R-1', qty: 3 }] });
    const item = (await app.ok('GET', `/api/invoices/${ret.id}`, s.worker)).items[0];
    const receive = await app.api('POST', '/api/receiving', s.worker, { invoiceItemId: item.id, acceptedQty: 3, cellBlockId: s.cells[0].id });
    const sorted = await app.api('POST', '/api/returns', s.worker, { invoiceItemId: item.id, qty: 3, qualityBucket: 'good', cellBlockId: s.cells[0].id });
    const rows = (await app.ok('GET', '/api/sellers/stock', s.seller)).rows;
    const stock = rows.find(r => r.sku === 'R-1');
    const events = await s.q("SELECT event_type, payload->'line'->>'actualQty' AS qty FROM sync_outbox WHERE payload->'invoice'->>'id'=$1 ORDER BY id", [ret.id]);
    console.log('РЕЗУЛЬТАТ ' + JSON.stringify({ receiving: receive.status, returns: sorted.status, total: stock.total, events }));
    v.expect('одна физическая приёмка возврата не проводится дважды', [receive, sorted].filter(r => r.status === 201).length === 1, 'только один 201', `${receive.status}/${sorted.status}`);
    v.expect('остаток соответствует трём вернувшимся штукам', stock.total === 3, 3, stock.total);
    v.expect('в обмене одно движение возврата', events.length === 1 && events[0].event_type === 'return_sorted', '1 return_sorted', JSON.stringify(events));
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
