// Два одновременных «назначить пересчёт» — назначается один (вариант теста
// рецензии без ручной синхронизации).
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');
(async () => {
  const app = await startApp(); const v = verdicts('Параллельные запуски пересчёта');
  try {
    const s = await stand(app, { racks: 3 });
    await s.receive([{ qty: 2, cell: s.cells[0] }]);
    const res = await Promise.all([1, 2, 3].map(() => app.api('POST', '/api/inventory/runs', s.owner, {})));
    const runs = await s.q('SELECT count(*)::int AS n FROM inventory_runs WHERE warehouse_id = $1', [s.warehouseId]);
    const open = await s.q("SELECT cell_block_id, count(*)::int AS n FROM inventory_tasks WHERE warehouse_id = $1 AND status = 'pending' GROUP BY 1", [s.warehouseId]);
    v.expect('назначен один пересчёт', runs[0].n === 1 && open.every((r) => r.n === 1),
      'один запуск, по одному заданию на ячейку', JSON.stringify({ st: res.map((r) => r.status), runs: runs[0].n, open }));
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
