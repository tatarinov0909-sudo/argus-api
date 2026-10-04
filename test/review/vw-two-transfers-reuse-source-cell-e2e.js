// Новая комбинация: общей суммы хватает на два переноса, но первый уже
// обещал товар конкретной ячейки. Второе задание должно брать другой остаток.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');
(async () => {
  const app = await startApp();
  const v = verdicts('Два переноса и резерв конкретной ячейки');
  try {
    const s = await stand(app);
    const [A, B, Z, Y] = s.cells;
    const ozon = await app.ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'Озон', marketplace: 'ozon', keepSeparate: true });
    const wb = await app.ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'WB', marketplace: 'wb', keepSeparate: true });
    const received = await s.receive([{ qty: 5, cell: A }, { qty: 5, cell: B }]);
    if (received.results.some(r => r.status !== 201)) throw Error('Не удалось подготовить остаток');
    const transfer = (toVw) => app.ok('POST', '/api/vwarehouses/transfers', s.manager,
      { companyId: s.company, sku: 'R-1', qty: 5, fromVw: null, toVw });
    const first = await transfer(ozon.id);
    const second = await transfer(wb.id);
    const tasks = await app.ok('GET', '/api/vwarehouses/move-tasks', s.worker);
    const one = tasks.find(t => t.transfer === first.number);
    const two = tasks.find(t => t.transfer === second.number);
    if (!one || !two) throw Error('Два задания не созданы');
    console.log(JSON.stringify({ sources: [one.fromLabel, two.fromLabel], quantities: [one.qty, two.qty] }));
    v.expect('два задания по 5 не обещают одну исходную ячейку с 5', one.fromCellBlockId !== two.fromCellBlockId,
      'разные исходные ячейки', `${one.fromLabel}; ${two.fromLabel}`);
    const a = await app.api('POST', `/api/vwarehouses/move-tasks/${one.id}/step`, s.worker, { toCellBlockId: Z.id, qty: 5 });
    const b = await app.api('POST', `/api/vwarehouses/move-tasks/${two.id}/step`, s.worker, { toCellBlockId: Y.id, qty: 5 });
    v.expect('оба одобренных переноса выполнимы без лишней перестановки', a.status === 200 && b.status === 200,
      '[200,200]', JSON.stringify({ first: a.status, second: b.status, error: b.body?.error }));
    console.log('Остатки:', JSON.stringify(await s.vwQty()));
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
