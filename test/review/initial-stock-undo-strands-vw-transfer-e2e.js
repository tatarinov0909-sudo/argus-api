// Отмена загрузки должна отказать при обещанном переносе либо согласованно
// снять задание: нельзя оставлять работнику перенос уже удалённого товара.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');
(async () => {
  const app = await startApp();
  const v = verdicts('Отмена начального остатка после задания переложить');
  try {
    const s = await stand(app);
    const [A, Z] = s.cells;
    const ozon = await app.ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'Озон', marketplace: 'ozon', keepSeparate: true });
    const rows = [{ line: 2, cell: A.label, sku: 'R-1', qty: 6, warehouse: 'Остальной товар' }];
    const plan = await app.ok('POST', '/api/cells/initial-stock', s.owner, { companyId: s.company, rows });
    const loaded = await app.ok('POST', '/api/cells/initial-stock', s.owner,
      { companyId: s.company, rows, apply: true, expect: { ok: plan.summary.ok, units: plan.summary.units } });
    if (!loaded.applied) throw Error('Загрузка не применилась');
    const transfer = await app.ok('POST', '/api/vwarehouses/transfers', s.manager,
      { companyId: s.company, sku: 'R-1', qty: 6, fromVw: null, toVw: ozon.id });
    const before = (await app.ok('GET', '/api/vwarehouses/move-tasks', s.worker)).find(t => t.transfer === transfer.number);
    if (!before) throw Error('Задание не создано');
    const undo = await app.api('POST', `/api/cells/initial-stock/batches/${loaded.batch}/undo`, s.owner, {});
    const after = (await app.ok('GET', '/api/vwarehouses/move-tasks', s.worker)).find(t => t.id === before.id);
    const stock = await s.vwQty();
    v.expect('отмена не оставляет открытое задание без товара', !(undo.status === 200 && after && Object.values(stock).reduce((a,b)=>a+b,0) === 0),
      '409 либо согласованное снятие задания', JSON.stringify({ undo: undo.status, openTask: !!after, taskLeft: after?.left, stock }));
    if (after) {
      const step = await app.api('POST', `/api/vwarehouses/move-tasks/${after.id}/step`, s.worker, { toCellBlockId: Z.id, qty: 6 });
      v.expect('оставшееся задание выполнимо', step.status === 200, '200', JSON.stringify({ status: step.status, error: step.body?.error }));
    }
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
