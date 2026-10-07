// Проверка 07.10: склад без адресного хранения и пересчёт.
//
// Адресное хранение выключено — весь товар числится в одном месте «Склад».
// Физически товар остался на тех же полках. Владелец назначает пересчёт —
// Аргус выдаёт грузчику обычные ячейки (они «числятся пустыми»). Грузчик
// честно считает 5 шт. на полке, владелец принимает пересчёт — и эти 5 шт.
// прибавляются к тем же 5 шт. в «Складе»: товар задвоен.
//
// Код выхода: 1 — ошибка Аргуса, 2 — сломался тест.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Пересчёт при выключенном адресном хранении');
  try {
    const s = await stand(app, { racks: 4, source: 'argus' });
    const shelf = s.cells[0];
    await s.receive([{ qty: 5, cell: shelf }]);
    await app.ok('PATCH', '/api/warehouses/me', s.owner, { addressStorage: false });
    const total = async () => Number((await s.q(
      `SELECT COALESCE(SUM(qty),0) AS n FROM cell_stock WHERE company_id = $1 AND sku = 'R-1' AND quality = 'good'`,
      [s.company]))[0].n);
    const before = await total();

    // Пересчёт, назначенный владельцем обычной кнопкой.
    const run = await app.ok('POST', '/api/inventory/runs', s.owner, {});
    const labels = run.cells.map((c) => c.label);
    const task = (await s.q('SELECT id, cell_block_id FROM inventory_tasks WHERE run_id = $1', [run.runId]))
      .find((t) => t.cell_block_id === shelf.id);
    v.expect('при выключенном хранении пересчёт не выдаёт обычные ячейки (весь товар — в «Складе»)',
      !task, `только «Склад»`, labels.join(', '));
    if (task) {
      const opened = await app.ok('POST', `/api/inventory/tasks/${task.id}/open`, s.worker);
      // На полке физически лежат те же 5 шт. — грузчик их и насчитал.
      await app.ok('POST', `/api/inventory/tasks/${task.id}/count`, s.worker, {
        lines: [{ sku: 'R-1', companyId: s.company, quality: 'good', qty: 5 }], snapshotId: opened.snapshotId });
      await app.ok('POST', `/api/inventory/tasks/${task.id}/resolve`, s.owner, { decision: 'apply' });
    }
    const after = await total();
    const seller = (await app.ok('GET', '/api/sellers/stock', s.seller)).rows.find((r) => r.sku === 'R-1');
    v.expect('после пересчёта на складе столько же товара, сколько было (5)', after === before,
      `${before} шт.`, `${after} шт. (у продавца «Всего» ${seller && seller.total})`);
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
