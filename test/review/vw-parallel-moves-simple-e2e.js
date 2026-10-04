// Два грузчика одновременно кладут товар двух складов «хранить отдельно» в
// одну пустую ячейку — проходит только один (вариант теста рецензии без
// ручной синхронизации: после починки второй ждёт на блокировке ячейки).
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');
(async () => {
  const app = await startApp();
  const v = verdicts('Два параллельных переноса в пустую ячейку');
  try {
    const s = await stand(app, { racks: 12 });
    const mk = (name) => app.ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name, marketplace: 'wb', keepSeparate: true });
    const a = await mk('Первый'); const b = await mk('Второй');
    for (let round = 0; round < 5; round += 1) {
      const src = s.cells[round]; const dst = s.cells[6 + round];
      const r0 = await s.receive([{ qty: 10, cell: src }]);
      if (r0.results[0].status !== 201) throw Error('Остаток не принят');
      const t1 = await app.ok('POST', '/api/vwarehouses/transfers', s.manager, { companyId: s.company, sku: 'R-1', qty: 5, fromVw: null, toVw: a.id });
      const t2 = await app.ok('POST', '/api/vwarehouses/transfers', s.manager, { companyId: s.company, sku: 'R-1', qty: 5, fromVw: null, toVw: b.id });
      const tasks = await app.ok('GET', '/api/vwarehouses/move-tasks', s.worker);
      const one = tasks.find((t) => t.transfer === t1.number); const two = tasks.find((t) => t.transfer === t2.number);
      const res = await Promise.all([one, two].map((t) => app.api('POST', `/api/vwarehouses/move-tasks/${t.id}/step`, s.worker, { toCellBlockId: dst.id, qty: 5 })));
      const inDst = await s.inCell(dst);
      v.expect(`заход ${round + 1}: в ячейке товар одного склада`, Object.keys(inDst).length <= 1,
        'один запрос отклонён', JSON.stringify({ st: res.map((r) => r.status), inDst }));
      for (const t of [one, two]) await app.api('POST', `/api/vwarehouses/move-tasks/${t.id}/cancel`, s.owner, {});
    }
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
