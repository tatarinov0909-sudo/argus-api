// Находка: решение по браку нельзя ни выполнить, ни снять, если брака на
// полке стало меньше, чем решено (пересчёт ячейки брака нашёл меньше).
// Задание навсегда висит у грузчика («скажите руководителю, пусть
// пересчитают» — а пересчитали уже), у продавца — «Ждёт склада».
//
// Документ: «Отложено.md» → «Сделано» → «Склад брака продавца»: решение —
// задание грузчику; можно частями. Снять или поправить задание нечем.
const { startApp, stand, verdicts, fail } = require('./_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Решение по браку после пересчёта');
  try {
    const s = await stand(app);
    const { ok, api } = app;
    const [A, , , D] = s.cells;
    const r = await s.receive([{ vw: null, qty: 5, cell: A }]);
    if (r.results[0].status !== 201) throw Error('приёмка: ' + JSON.stringify(r.results));
    // Грузчик нашёл на полке 3 шт. брака и отнёс в ячейку брака D.
    await ok('POST', '/api/defects/moves', s.worker, { companyId: s.company, sku: 'R-1', fromCellBlockId: A.id, toCellBlockId: D.id,
      qty: 3, bucket: 'defective', source: 'move' });
    // Продавец решил: утилизировать 3 шт.
    const dec = await ok('POST', '/api/sellers/defects/decisions', s.seller, { sku: 'R-1', bucket: 'defective', qty: 3, action: 'dispose' });
    // Пересчёт ячейки брака: там 1 шт. (двух не нашли) — руководитель принял.
    await s.recount(D, [{ quality: 'defective', qty: 1 }]);

    const tasks = await ok('GET', '/api/defects/tasks', s.worker);
    const t = tasks.find((x) => x.id === dec.id);
    const done = await api('POST', `/api/defects/tasks/${dec.id}/done`, s.worker, {});
    // Хоть какой-то выход: выполнить на то, что есть, или снять задание.
    const cancel = await api('POST', `/api/defects/tasks/${dec.id}/cancel`, s.owner, {});
    const patch = await api('PATCH', `/api/defects/tasks/${dec.id}`, s.owner, { qty: 1 });
    v.expect('задание по браку можно выполнить на найденное или снять', [done, cancel, patch].some((x) => x.status < 300),
      'выполнить 1 шт. или снять задание', `выполнить: ${done.status} ${JSON.stringify(done.body)}; снять: ${cancel.status}; поправить: ${patch.status}`);

    const view = await ok('GET', '/api/sellers/defects', s.seller);
    const d = view.decisions.find((x) => x.id === dec.id);
    v.expect('у продавца решение не висит «Ждёт склада» без выхода', !(d.status === 'pending' && t && t.cells.reduce((n, c) => n + c.qty, 0) < t.qty),
      'решение выполнено/поправлено', `статус ${d.status}, в задании ${t && t.qty} шт., на полке ${t && t.cells.reduce((n, c) => n + c.qty, 0)} шт.`);
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
