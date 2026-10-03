// Находка: пересчёт ячейки в зоне склада «хранить отдельно» нашёл лишнее —
// излишек записывается на «Остальной товар» прямо в этой ячейке. В зоне
// «Озона» появляется чужой товар, и дальше грузчик не может положить товар
// «Озона» в его же зону: «Сюда нельзя: здесь лежит товар склада «Остальной
// товар», а склад «Озон» хранится отдельно».
//
// Документ: «Виртуальные склады — схема.md», этап 3, вопрос 1 — «Товар
// такого склада никогда не лежит в одной ячейке с товаром других складов
// продавца… В закреплённую зону ничего другого класть нельзя».
const { startApp, stand, verdicts, fail } = require('./_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Излишек пересчёта в зоне склада «хранить отдельно»');
  try {
    const s = await stand(app);
    const [, , Z] = s.cells;
    const ozon = await app.ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'Озон', marketplace: 'ozon',
      keepSeparate: true, zone: { cells: [Z.label] } });
    const r1 = await s.receive([{ vw: ozon.id, qty: 5, cell: Z }]);
    if (r1.results[0].status !== 201) throw Error('приёмка в зону: ' + JSON.stringify(r1.results));

    // Пересчёт ячейки зоны: 7 вместо 5.
    await s.recount(Z, [{ qty: 7 }]);
    const inZone = await s.inCell(Z, 'good');
    v.expect('в зоне «Озона» — только товар «Озона»', Object.keys(inZone).every((n) => n === 'Озон'),
      '{ Озон: 7 } (или излишек вне зоны)', JSON.stringify(inZone));

    // Новый привоз на «Озон» — в его же зону.
    const r2 = await s.receive([{ vw: ozon.id, qty: 3, cell: Z }]);
    v.expect('товар «Озона» по-прежнему кладётся в зону «Озона»', r2.results[0].status === 201,
      '201', `${r2.results[0].status} ${JSON.stringify(r2.results[0].body)}`);
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
