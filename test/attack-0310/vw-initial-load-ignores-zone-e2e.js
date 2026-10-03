// Находка: «Загрузить остатки» (начальные остатки из файла) не проверяет
// «хранить отдельно» и зоны складов продавца: кладёт «Остальной товар» в
// закреплённую зону «Озона» и в одну ячейку с товаром «Озона». Дальше
// товар «Озона» в его же зону не положить — сервер отказывает.
//
// Документ: «Виртуальные склады — схема.md», этап 3, вопрос 1 — «В
// закреплённую зону ничего другого класть нельзя»; вопрос 7 — начальные
// остатки из файла со столбцом «Склад».
const { startApp, stand, verdicts, fail } = require('./_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Начальные остатки и зона склада');
  try {
    const s = await stand(app);
    const { ok } = app;
    const [A, , Z, Z2] = s.cells;
    const ozon = await ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'Озон', marketplace: 'ozon',
      keepSeparate: true, zone: { cells: [Z.label, Z2.label] } });
    // В зоне уже лежит товар «Озона» (ячейка Z2).
    const r1 = await s.receive([{ vw: ozon.id, qty: 2, cell: Z2 }]);
    if (r1.results[0].status !== 201) throw Error('приёмка: ' + JSON.stringify(r1.results));

    const rows = [{ line: 2, cell: Z.label, sku: 'R-1', qty: 4, warehouse: 'Остальной товар' },
      { line: 3, cell: A.label, sku: 'R-1', qty: 3, warehouse: 'Озон' }, { line: 4, cell: A.label, sku: 'R-1', qty: 6, warehouse: 'Остальной товар' }];
    const plan = await ok('POST', '/api/cells/initial-stock', s.owner, { companyId: s.company, rows });
    const out = await ok('POST', '/api/cells/initial-stock', s.owner, { companyId: s.company, rows, apply: true,
      expect: { ok: plan.summary.ok, units: plan.summary.units } });
    v.expect('загрузка не кладёт «Остальной товар» в зону «Озона»', !(out.applied && ((await s.inCell(Z))['Остальной товар'] || 0) > 0),
      'строка 2 — ошибка «ячейка закреплена за складом «Озон»»', `загружено: ${out.applied}; в зоне ${JSON.stringify(await s.inCell(Z))}`);
    v.expect('загрузка не смешивает «Озон» с другим товаром в одной ячейке', !(out.applied && Object.keys(await s.inCell(A)).length > 1),
      'строки 3–4 — ошибка', `в ячейке ${A.label}: ${JSON.stringify(await s.inCell(A))}`);

    // Следующий привоз «Озона» — в его зону (там пусто только Z, но в ней
    // теперь чужой товар).
    const r2 = await s.receive([{ vw: ozon.id, qty: 1, cell: Z }]);
    v.expect('товар «Озона» можно положить в его зону', r2.results[0].status === 201,
      '201', `${r2.results[0].status} ${JSON.stringify(r2.results[0].body)}`);
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
