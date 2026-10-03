// Находка: акт утилизации (и выдачи) брака, который продавец открывает в
// своём кабинете, печатает «Из ячеек брака: 1.4.1 — 2 шт» — адреса ячеек
// склада. Сервер отдаёт продавцу адреса ячеек в ответе акта.
//
// Документ: «Виртуальные склады — схема.md», уточнение 03.10 — «Как и где
// лежит товар (ячейки…) — продавцу не показываем»; «Отложено.md» → «Сделано»
// 26.09 — «продавцу больше не приходят адреса ячеек… в карточке документа».
const { startApp, stand, verdicts, fail } = require('./_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Акт по браку у продавца');
  try {
    const s = await stand(app);
    const { ok } = app;
    const [A, , , D] = s.cells;
    const r = await s.receive([{ vw: null, qty: 5, cell: A }]);
    if (r.results[0].status !== 201) throw Error('приёмка: ' + JSON.stringify(r.results));
    await ok('POST', '/api/defects/moves', s.worker, { companyId: s.company, sku: 'R-1', fromCellBlockId: A.id, toCellBlockId: D.id,
      qty: 2, bucket: 'defective', source: 'move' });
    const dec = await ok('POST', '/api/sellers/defects/decisions', s.seller, { sku: 'R-1', bucket: 'defective', qty: 2, action: 'dispose' });
    await ok('POST', `/api/defects/tasks/${dec.id}/done`, s.worker, {});
    const act = await ok('GET', `/api/acts/defect/${dec.id}`, s.seller);
    const text = JSON.stringify(act);
    v.expect('в акте, который видит продавец, нет адресов ячеек', !(act.cells || []).length && !text.includes(D.label),
      'без ячеек', `cells: ${JSON.stringify(act.cells)}`);
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
