// Находка: склад продавца убирают в архив, пока по нему ждёт решения продавца
// спорная ситуация (продавец поставил «Запретить складу решать без меня»).
// Продавец потом «делит по-своему» — и товар записывается на УБРАННЫЙ склад:
// его не видно ни продавцу, ни складу, перенести его нельзя («склад не
// найден»), «Всего» не сходится с суммой по складам.
//
// Документ: «Виртуальные склады — схема.md» — «Убрать склад — только пустой»;
// «Основной» = склады продавца + «Остальной товар».
const { startApp, stand, verdicts, fail } = require('./_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Убранный склад и решение продавца');
  try {
    const s = await stand(app);
    const { ok, api } = app;
    const [A] = s.cells;
    const ozon = await ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'Озон', marketplace: 'ozon' });
    // Продавец: «Запретить складу решать без меня».
    await ok('PATCH', '/api/vwarehouses/rights', s.seller, { rights: { decide: false } });

    // Привоз: 5 шт. на «Озон», 5 шт. на «Остальной товар»; на «Озон» не
    // приехало ничего — спорная ситуация ждёт продавца.
    const r = await s.receive([{ vw: ozon.id, declared: 5, qty: 0 }, { vw: null, declared: 5, qty: 5, cell: A }]);
    if (r.results.some((x) => x.status !== 201)) throw Error('приёмка: ' + JSON.stringify(r.results));
    const dec = (await ok('GET', '/api/vwarehouses/decisions?open=1', s.seller)).find((d) => d.kind === 'receiving');
    if (!dec) throw Error('решение по приёмке не появилось');

    // Склад «Озон» пустой — руководитель его убирает.
    const del = await api('DELETE', `/api/vwarehouses/${ozon.id}?companyId=${s.company}`, s.owner);
    v.expect('нельзя убрать склад, пока по нему ждёт решение продавца', del.status === 409,
      '409 — по складу ждёт решение продавца', `${del.status} ${JSON.stringify(del.body)}`);

    // Продавец решает по-своему: «на Озон приехало 5».
    const res = await api('POST', `/api/vwarehouses/decisions/${dec.id}`, s.seller,
      { chosen: dec.parts.map((x) => ({ vw: x.vw, qty: x.vw ? 5 : 0 })) });
    const archived = (await s.q('SELECT archived_at FROM virtual_warehouses WHERE id = $1', [ozon.id]))[0].archived_at;
    const onArchived = Number((await s.q(
      `SELECT COALESCE(SUM(qty), 0)::int AS n FROM cell_stock WHERE virtual_warehouse_id = $1 AND qty > 0`, [ozon.id]))[0].n);
    v.expect('товар не записывается на убранный склад', !(archived && onArchived > 0),
      'решение отклонено или склад не убран', `склад убран: ${!!archived}; на нём ${onArchived} шт.; ответ ${res.status}`);

    // Отгрузка: заказ на 5 шт. со склада «Озон», куда продавец отнёс товар.
    // (Правка при починке 03.10: заказ без склада собирается из «Остального
    // товара» — так устроены склады продавца; смысл проверки — товар не
    // потерян и его можно собрать.)
    const out = await ok('POST', '/api/invoices', s.owner, { companyId: s.company, number: 'ОТГ-1', direction: 'out',
      items: [{ sku: 'R-1', name: 'Резинки чёрные', declaredQty: 5, virtualWarehouseId: ozon.id }] });
    const sug = await ok('GET', `/api/shipping/suggest/${out.items[0].id}`, s.worker);
    const canPick = (sug.cells || []).reduce((n, c) => n + Number(c.available || 0), 0);
    v.expect('товар, который продавец «записал» на склад, можно собрать в отгрузку', canPick >= 5,
      'в подсказке сборки 5 шт.', `${canPick} шт. (${JSON.stringify(sug.cells)})`);

    // Перенести товар с убранного склада нельзя.
    if (archived && onArchived > 0) {
      const t = await api('POST', '/api/vwarehouses/transfers', s.owner, { companyId: s.company, sku: 'R-1', qty: onArchived, fromVw: ozon.id, toVw: null });
      v.expect('товар с убранного склада можно вернуть переносом', t.status === 201,
        '201', `${t.status} ${JSON.stringify(t.body)}`);
    }
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
