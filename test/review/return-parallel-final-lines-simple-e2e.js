// Две последние строки возврата разбирают одновременно — возврат завершён.
// (Вариант теста рецензии без ручной синхронизации: после починки
// транзакции ждут друг друга на блокировке возврата, раньше UPDATE.)
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');
(async () => {
  const app = await startApp(); const v = verdicts('Параллельные последние строки возврата');
  try {
    const s = await stand(app, { skus: [['R-A', 'Возврат A'], ['R-B', 'Возврат B']] });
    for (let round = 0; round < 5; round += 1) {
      const ret = await app.ok('POST', '/api/returns/manual', s.worker, { companyId: s.company, items: [{ sku: 'R-A', qty: 3 }, { sku: 'R-B', qty: 4 }] });
      const doc = await app.ok('GET', `/api/invoices/${ret.id}`, s.worker);
      const res = await Promise.all(doc.items.map((it, k) => app.api('POST', '/api/returns', s.worker,
        { invoiceItemId: it.id, qty: Number(it.declared_qty), qualityBucket: 'good', cellBlockId: s.cells[k].id })));
      const after = await app.ok('GET', `/api/invoices/${ret.id}`, s.owner);
      v.expect(`заход ${round + 1}: обе строки приняты и возврат завершён`, res.every((r) => r.status === 201) && after.status === 'completed',
        '201/201, completed', JSON.stringify({ st: res.map((r) => r.status), status: after.status }));
    }
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
