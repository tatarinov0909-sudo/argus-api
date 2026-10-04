// Положительная проверка: атомарный откат позднего отказа, потеря HTTP-ответа,
// защита повтора приёмки и запрет устаревшего пересчёта. Только тестовая БД.
const http = require('http');
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');
(async () => {
  const app = await startApp(); const v = verdicts('Транзакции приёмки и обрыв клиента');
  try {
    const s = await stand(app);
    const [A, B, C, D] = s.cells;
    await app.ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'Чужая зона для раскладки', marketplace: 'wb', zone: { cells: [D.label] } });
    const inv = await app.ok('POST', '/api/invoices', s.owner, { companyId: s.company, number: 'ОТКАТ-1', items: [{ sku: 'R-1', name: 'Тест', declaredQty: 3 }] });
    await app.ok('POST', `/api/receiving/session/${inv.id}/start`, s.worker, {});
    const snapshot = async () => JSON.stringify(await s.q("SELECT (SELECT count(*) FROM receiving_records) AS records, (SELECT count(*) FROM receiving_placements) AS placements, (SELECT count(*) FROM cell_stock) AS stock, (SELECT count(*) FROM sync_outbox) AS outbox, (SELECT count(*) FROM journal_entries) AS journal, (SELECT arrived_at FROM invoices WHERE id=$1) AS arrived", [inv.id]));
    const before = await snapshot();
    const lateReject = await app.api('POST', '/api/receiving', s.worker, { invoiceItemId: inv.items[0].id, acceptedQty: 3, placements: [{ cellBlockId: A.id, qty: 1 }, { cellBlockId: D.id, qty: 2 }] });
    v.expect('вторая укладка в неподходящую зону отклонена', lateReject.status === 409, 409, lateReject.status);
    v.expect('первая укладка/приёмка/журнал/outbox/arrived откатились вместе', await snapshot() === before, 'снимок равен', 'сверка снимка');
    const good = { invoiceItemId: inv.items[0].id, acceptedQty: 3, cellBlockId: A.id };
    await app.ok('POST', '/api/receiving', s.worker, good);
    v.expect('после отказа корректная приёмка возможна', (await app.api('POST', '/api/receiving', s.worker, good)).status === 409, 'повтор409', 'перваяуспешна, повторпроверен');

    const lost = await app.ok('POST', '/api/invoices', s.owner, { companyId: s.company, number: 'ОБРЫВ-2', items: [{ sku: 'R-1', name: 'Тест', declaredQty: 4 }] });
    await app.ok('POST', `/api/receiving/session/${lost.id}/start`, s.worker, {});
    const body = { invoiceItemId: lost.items[0].id, acceptedQty: 4, cellBlockId: B.id };
    let closed;
    await s.run(async c => {
      await c.query('SELECT id FROM invoices WHERE id=$1 FOR UPDATE', [lost.id]);
      let req;
      closed = new Promise(resolve => {
        req = http.request(app.base + '/api/receiving', { method: 'POST', headers: { Authorization: 'Bearer ' + s.worker, 'Content-Type': 'application/json' } });
        req.on('error', () => resolve('disconnect')); req.on('response', res => { res.resume(); resolve('response'); });
        req.end(JSON.stringify(body));
      });
      let waiting = false;
      for (let n = 0; n < 200; n++) {
        waiting = (await s.q("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF i'"))[0].n > 0;
        if (waiting) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (!waiting) throw Error('Не пойман запрос до фиксации');
      req.destroy();
      v.expect('клиент оборвал связь до ответа', await closed === 'disconnect', 'disconnect', 'соединение уничтожено');
    });
    let received = 0;
    for (let n = 0; n < 200; n++) {
      received = (await s.q('SELECT count(*)::int AS n FROM receiving_records WHERE invoice_item_id=$1', [lost.items[0].id]))[0].n;
      if (received) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    v.expect('начатая серверная операция после потери связи целиком зафиксирована', received === 1, 1, received);
    v.expect('повтор после неизвестного клиенту исхода отвергнут', (await app.api('POST', '/api/receiving', s.worker, body)).status === 409, 409, 'проверено');
    const stock = (await app.ok('GET', '/api/sellers/stock', s.seller)).rows.find(r => r.sku === 'R-1');
    v.expect('в остатках3+4, без удвоения после обрыва', stock.total === 7, 7, stock.total);
    const eventCount = (await s.q("SELECT count(*)::int AS n FROM sync_outbox WHERE payload->'invoice'->>'id'=$1", [lost.id]))[0].n;
    v.expect('outbox после обрыва содержит одно движение', eventCount === 1, 1, eventCount);
    const runs = await app.ok('POST', '/api/inventory/runs', s.owner, {});
    const task = (await app.ok('GET', '/api/inventory/tasks', s.worker)).find(t => t.cellBlockId === A.id);
    if (!task) throw Error('Не создано задание пересчёта A');
    const opened = await app.ok('POST', `/api/inventory/tasks/${task.id}/open`, s.worker, {});
    await app.ok('POST', `/api/inventory/tasks/${task.id}/count`, s.worker, { snapshotId: opened.snapshotId, lines: [{ sku: 'R-1', companyId: s.company, quality: 'good', qty: 2 }] });
    const extra = await app.ok('POST', '/api/returns/manual', s.worker, { companyId: s.company, items: [{ sku: 'R-1', qty: 1 }] });
    const extraItem = (await app.ok('GET', `/api/invoices/${extra.id}`, s.worker)).items[0];
    await app.ok('POST', '/api/returns', s.worker, { invoiceItemId: extraItem.id, qty: 1, qualityBucket: 'good', cellBlockId: A.id });
    const resolve = await app.api('POST', `/api/inventory/tasks/${task.id}/resolve`, s.owner, { decision: 'apply' });
    v.expect('устаревший пересчёт после движения получает409', resolve.status === 409, 409, resolve.status);
    const final = (await app.ok('GET', '/api/sellers/stock', s.seller)).rows.find(r => r.sku === 'R-1');
    v.expect('отказ пересчёта сохранил3+4+1', final.total === 8, 8, final.total);
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
