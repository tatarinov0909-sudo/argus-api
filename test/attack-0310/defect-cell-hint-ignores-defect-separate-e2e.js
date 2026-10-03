// Находка: склад продавца «хранить отдельно» + «и брак тоже отдельно».
// Грузчик отмечает брак товара этого склада («Это брак» на экране
// «Перепаковка и перестановка», «Брак» при сборке или приёмке) — экран
// грузчика спрашивает подсказку ячейки брака БЕЗ склада
// (loader.html: GET /api/defects/cells?companyId=…), и первая же подсказка —
// «здесь уже брак этого продавца» — общая ячейка брака. Грузчик нажимает её —
// сервер отказывает: «Сюда нельзя: здесь лежит товар склада «Остальной
// товар», а склад «Озон» хранится отдельно».
//
// Документ: «Виртуальные склады — схема.md», этап 3, вопрос 11 — «Брак склада
// «хранить отдельно» — вторая галочка «и брак тоже отдельно»»; вопрос 1 —
// «грузчику подсказываются отдельные ячейки».
const { startApp, stand, verdicts, fail } = require('./_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Подсказка ячейки брака и «брак тоже отдельно»');
  try {
    const s = await stand(app);
    const { ok, api } = app;
    const [A, B, , D] = s.cells;
    const ozon = await ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'Озон', marketplace: 'ozon',
      keepSeparate: true, defectSeparate: true });
    const r = await s.receive([{ vw: ozon.id, qty: 5, cell: A }, { vw: null, qty: 5, cell: B }]);
    if (r.results.some((x) => x.status !== 201)) throw Error('приёмка: ' + JSON.stringify(r.results));
    // Брак «Остального товара» уже лежит в ячейке брака D.
    await ok('POST', '/api/defects/moves', s.worker, { companyId: s.company, sku: 'R-1', fromCellBlockId: B.id, toCellBlockId: D.id,
      qty: 1, bucket: 'defective', source: 'move' });

    // Брак товара «Озона» из ячейки A — как это делает экран грузчика.
    const hints = await ok('GET', `/api/defects/cells?companyId=${s.company}`, s.worker);
    const first = hints[0];
    const res = await api('POST', '/api/defects/moves', s.worker, { companyId: s.company, sku: 'R-1', fromCellBlockId: A.id,
      toCellBlockId: first.cellBlockId, qty: 1, bucket: 'defective', source: 'move' });
    v.expect('первая подсказанная ячейка брака принимается', res.status === 201,
      '201', `подсказка ${first.label} («${first.reason}») → ${res.status} ${JSON.stringify(res.body)}`);
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
