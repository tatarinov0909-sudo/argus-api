// Решение закрыто на ноль найденного брака, акт обязан содержать ноль, а не заказанное количество.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');
(async () => {
  const app = await startApp(); const v = verdicts('Акт брака при нулевом выполнении');
  try {
    const s = await stand(app);
    const receipt = await s.receive([{ qty: 3, cell: s.cells[0] }]);
    if (receipt.results[0].status !== 201) throw Error('Приёмка не прошла');
    await app.ok('POST', '/api/defects/moves', s.worker, { companyId: s.company, sku: 'R-1', fromCellBlockId: s.cells[0].id, toCellBlockId: s.cells[1].id, qty: 3, bucket: 'defective' });
    const decision = await app.ok('POST', '/api/sellers/defects/decisions', s.seller, { sku: 'R-1', bucket: 'defective', qty: 3, action: 'dispose' });
    await s.recount(s.cells[1], [{ quality: 'defective', qty: 0 }]);
    const done = await app.ok('POST', `/api/defects/tasks/${decision.id}/done`, s.worker, {});
    v.expect('решение закрыто с нулевым выполнением и недостачей3', done.doneQty === 0 && done.short === 3 && done.status === 'done', 'doneQty0/short3/done', JSON.stringify(done));
    for (const [who, token] of [['продавец', s.seller], ['руководитель', s.owner]]) {
      const act = await app.ok('GET', `/api/acts/defect/${decision.id}`, token);
      console.log('АКТ ' + who + ' ' + JSON.stringify({ finished: act.finished, qty: act.items[0].qty, action: act.action }));
      v.expect(`${who}: акт не утверждает утилизацию отсутствующих единиц`, act.items[0].qty === 0, 0, act.items[0].qty);
    }
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
