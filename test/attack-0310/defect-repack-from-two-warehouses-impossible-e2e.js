// Находка: решение «перепаковать» (или «уценка») по браку, который пришёл с
// двух складов продавца, один из которых «хранить отдельно», выполнить
// нельзя. Грузчик указывает одну ячейку «куда кладёте для продажи», а товар
// двух складов в одну ячейку класть нельзя — сервер отказывает при ЛЮБОЙ
// ячейке. Отменить решение по браку тоже нечем — задание висит навсегда.
//
// Документ: «Виртуальные склады — схема.md» — «Брак помнит, с какого склада
// пришёл; «перепаковать» и «уценка» возвращают товар на тот же склад»;
// этап 3, вопрос 1 — склад «хранить отдельно» не лежит вместе с другими.
const { startApp, stand, verdicts, fail } = require('./_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Перепаковка брака с двух складов');
  try {
    const s = await stand(app);
    const { ok, api } = app;
    const [A, B, C, D, E, F] = s.cells;
    const ozon = await ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'Озон', marketplace: 'ozon', keepSeparate: true });
    const r = await s.receive([{ vw: ozon.id, qty: 5, cell: A }, { vw: null, qty: 5, cell: B }]);
    if (r.results.some((x) => x.status !== 201)) throw Error('приёмка: ' + JSON.stringify(r.results));
    // Брак с полки: по 1 шт. с «Озона» и с «Остального товара» — в общую ячейку брака D.
    await ok('POST', '/api/defects/moves', s.worker, { companyId: s.company, sku: 'R-1', fromCellBlockId: A.id, toCellBlockId: D.id,
      qty: 1, bucket: 'packaging_defect', source: 'move' });
    await ok('POST', '/api/defects/moves', s.worker, { companyId: s.company, sku: 'R-1', fromCellBlockId: B.id, toCellBlockId: D.id,
      qty: 1, bucket: 'packaging_defect', source: 'move' });
    // Продавец: перепаковать оба и вернуть в продажу.
    const dec = await ok('POST', '/api/sellers/defects/decisions', s.seller, { sku: 'R-1', bucket: 'packaging_defect', qty: 2, action: 'repack' });

    const tried = [];
    let done = null;
    for (const cell of [C, E, F, A, B]) {
      const res = await api('POST', `/api/defects/tasks/${dec.id}/done`, s.worker, { cellBlockId: cell.id });
      tried.push(`${cell.label}: ${res.status} ${res.body && res.body.error ? res.body.error : ''}`);
      if (res.status === 200) { done = res; break; }
    }
    v.expect('грузчик может выполнить «перепаковать» хоть в какую-то ячейку', !!done,
      '200 хотя бы для одной ячейки', tried.join(' | '));
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
