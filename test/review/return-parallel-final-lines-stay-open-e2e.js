// Две последние разные строки возврата: статус вычисляется до блокировки накладной.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');
(async () => {
  const app = await startApp(); const v = verdicts('Параллельные последние строки возврата');
  try {
    const s = await stand(app, { skus: [['R-A', 'Возврат A'], ['R-B', 'Возврат B']] });
    const ret = await app.ok('POST', '/api/returns/manual', s.worker, { companyId: s.company, items: [{ sku: 'R-A', qty: 3 }, { sku: 'R-B', qty: 4 }] });
    const doc = await app.ok('GET', `/api/invoices/${ret.id}`, s.worker);
    let pending;
    // Только управление порядком двух настоящих HTTP-транзакций. Данные не меняем:
    // NO KEY UPDATE позволяет обеим дойти до собственного UPDATE статуса,
    // сохраняя обычные FK KEY SHARE при записях журнала.
    await s.run(async c => {
      await c.query('SELECT id FROM invoices WHERE id=$1 FOR NO KEY UPDATE', [ret.id]);
      pending = Promise.all(doc.items.map((it, k) => app.api('POST', '/api/returns', s.worker,
        { invoiceItemId: it.id, qty: Number(it.declared_qty), qualityBucket: 'good', cellBlockId: s.cells[k].id })));
      let waiting = 0;
      for (let n = 0; n < 200; n++) {
        const rows = await s.q("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock' AND query LIKE 'UPDATE invoices SET status = %'");
        waiting = rows[0].n;
        if (waiting >= 2) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (waiting < 2) throw Error('Не удалось синхронизировать две транзакции на UPDATE invoices');
      console.log('Обе настоящие транзакции вычислили статус и ждут UPDATE одной накладной.');
    });
    const results = await pending;
    v.expect('обе физически разные строки приняты', results.every(r => r.status === 201), '201/201', JSON.stringify(results.map(r => r.status)));
    const after = await app.ok('GET', `/api/invoices/${ret.id}`, s.owner);
    const totals = await s.q('SELECT ii.sku, ii.declared_qty::int AS declared, SUM(rr.qty)::int AS sorted FROM invoice_items ii JOIN return_records rr ON rr.invoice_item_id=ii.id WHERE ii.invoice_id=$1 GROUP BY ii.id', [ret.id]);
    console.log('РЕЗУЛЬТАТ ' + JSON.stringify({ status: after.status, lines: totals }));
    v.expect('каждая строка целиком разобрана', totals.every(r => r.sorted === r.declared), '3/3, 4/4', JSON.stringify(totals));
    v.expect('полностью разобранный возврат завершён', after.status === 'completed', 'completed', after.status);
    const retry = await app.api('POST', '/api/returns', s.worker, { invoiceItemId: doc.items[0].id, qty: Number(doc.items[0].declared_qty), qualityBucket: 'good', cellBlockId: s.cells[0].id });
    v.expect('повтор не удваивает количество', retry.status === 409, 409, retry.status);
    const final = await app.ok('GET', `/api/invoices/${ret.id}`, s.owner);
    v.expect('после повторного открытия статус согласован', final.status === 'completed', 'completed', final.status);
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
