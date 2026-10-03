// Находка: продавцу в истории товара видно «Перемещение» — перекладку его
// товара из ячейки в ячейку (здесь — задание грузчику «переложить» для склада
// «хранить отдельно»). Адресов нет, но сам факт «смены ячейки» продавцу
// показываться не должен. А «Перенос между вашими складами» не говорит, с
// какого склада на какой.
//
// Документ: «Виртуальные склады — схема.md», уточнение 03.10 — «Как и где
// лежит товар (ячейки, «хранить отдельно», смена ячейки) — продавцу не
// показываем и не сообщаем; о переносе между складами — сообщаем: меняются
// остатки». Место: src/sellers/history.js — stock_operations всех видов.
const { startApp, stand, verdicts, fail } = require('./_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('История товара у продавца');
  try {
    const s = await stand(app);
    const { ok } = app;
    const [A, B] = s.cells;
    const ozon = await ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'Озон', marketplace: 'ozon' });
    const r = await s.receive([{ vw: null, qty: 10, cell: A }, { vw: ozon.id, qty: 4, cell: A }]);
    if (r.results.some((x) => x.status !== 201)) throw Error('приёмка: ' + JSON.stringify(r.results));
    // Включили «хранить отдельно» — задание грузчику разделить ячейку A.
    await ok('PATCH', `/api/vwarehouses/${ozon.id}`, s.owner, { companyId: s.company, keepSeparate: true, separateExisting: 'tasks' });
    const task = (await ok('GET', '/api/vwarehouses/move-tasks', s.worker))[0];
    await ok('POST', `/api/vwarehouses/move-tasks/${task.id}/step`, s.worker, { toCellBlockId: B.id, qty: 4 });
    // Перенос между складами (обычный склад — сразу).
    const ooo = await ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'ООО БББ', marketplace: 'wb' });
    await ok('POST', '/api/vwarehouses/transfers', s.owner, { companyId: s.company, sku: 'R-1', qty: 2, fromVw: null, toVw: ooo.id });

    const h = await ok('GET', '/api/sellers/history?sku=R-1', s.seller);
    const kinds = h.events.map((e) => e.kind);
    v.expect('в истории продавца нет перекладки между ячейками («Перемещение»)', !kinds.includes('move'),
      'только приёмка, переносы между складами и т.п.', `виды событий: ${kinds.join(', ')}`);
    const tr = h.events.find((e) => e.kind === 'vw_transfer');
    const says = tr && JSON.stringify(tr);
    v.expect('«Перенос между вашими складами» говорит, с какого склада на какой', !!tr && /ООО БББ/.test(says) && /Остальной/.test(says),
      'в событии названы склады', says || 'события нет');
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
