// Находка: перенос на склад «хранить отдельно» не держит товар. Пока грузчик
// не переложил, товар числится за старым складом и считается свободным —
// второй перенос (или поставка) забирает те же штуки, и задание грузчика
// «переложить» становится невыполнимым: «В этой ячейке нет такого товара».
//
// Документ: «Виртуальные склады — схема.md», этап 3, вопрос 3 — «Перенос на
// склад «хранить отдельно» — задание грузчику «переложить»; каждая
// переложенная штука сразу переходит на новый склад, непереложенное
// числится за старым».
const { startApp, stand, verdicts, fail } = require('./_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Перенос на склад «хранить отдельно» не держит товар');
  try {
    const s = await stand(app);
    const { ok, api } = app;
    const [A, B] = s.cells;
    const ozon = await ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'Озон', marketplace: 'ozon', keepSeparate: true });
    const ooo = await ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'ООО БББ', marketplace: 'wb' });
    const r = await s.receive([{ vw: null, qty: 10, cell: A }]);
    if (r.results[0].status !== 201) throw Error('приёмка: ' + JSON.stringify(r.results));

    // Руководитель переносит все 10 шт. на «Озон» — задание грузчику.
    const t1 = await ok('POST', '/api/vwarehouses/transfers', s.owner, { companyId: s.company, sku: 'R-1', qty: 10, fromVw: null, toVw: ozon.id });
    if (t1.status !== 'to_move') throw Error('ожидалось задание «переложить», получили ' + t1.status);

    // Менеджер, не зная об этом, переносит те же 10 шт. на «ООО БББ».
    const t2 = await api('POST', '/api/vwarehouses/transfers', s.manager, { companyId: s.company, sku: 'R-1', qty: 10, fromVw: null, toVw: ooo.id });
    v.expect('второй перенос тех же штук отклоняется (товар уже обещан переносу на «Озон»)', t2.status === 409,
      '409 — на «Остальном товаре» свободно 0 шт.', `${t2.status} ${JSON.stringify(t2.body)}`);

    // Грузчик идёт выполнять задание «переложить».
    const task = (await ok('GET', '/api/vwarehouses/move-tasks', s.worker)).find((x) => x.transfer === t1.number);
    const step = await api('POST', `/api/vwarehouses/move-tasks/${task.id}/step`, s.worker, { toCellBlockId: B.id, qty: 10 });
    v.expect('задание «переложить» выполнимо', step.status === 200,
      '200 — переложено 10 шт.', `${step.status} ${JSON.stringify(step.body)}`);
    v.expect('итог: 10 шт. на «Озоне»', ((await s.vwQty())['Озон'] || 0) === 10,
      '{ Озон: 10 }', JSON.stringify(await s.vwQty()));
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
