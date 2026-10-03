// Находка: руководитель выключил у склада «хранить отдельно» — а задания
// грузчику «переложить» по этому складу остаются открытыми: грузчик дальше
// разделяет товар, которого разделять уже не нужно, а перенос «Остальной
// товар → Озон» так и висит «грузчик перекладывает», хотя теперь он мог бы
// выполниться сразу (склады снова «вместе»).
//
// Документ: «Виртуальные склады — схема.md», этап 3, вопросы 2–3 — задания
// «переложить» существуют только ради «хранить отдельно».
const { startApp, stand, verdicts, fail } = require('./_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Выключили «хранить отдельно»');
  try {
    const s = await stand(app);
    const { ok } = app;
    const [A] = s.cells;
    const ozon = await ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'Озон', marketplace: 'ozon' });
    const r = await s.receive([{ vw: null, qty: 10, cell: A }, { vw: ozon.id, qty: 4, cell: A }]);
    if (r.results.some((x) => x.status !== 201)) throw Error('приёмка: ' + JSON.stringify(r.results));
    await ok('PATCH', `/api/vwarehouses/${ozon.id}`, s.owner, { companyId: s.company, keepSeparate: true, separateExisting: 'tasks' });
    const t = await ok('POST', '/api/vwarehouses/transfers', s.owner, { companyId: s.company, sku: 'R-1', qty: 3, fromVw: null, toVw: ozon.id });
    if (t.status !== 'to_move') throw Error('ожидался перенос через задание, получили ' + t.status);
    const before = (await ok('GET', '/api/vwarehouses/move-tasks', s.worker)).length;

    // Передумали: «хранить отдельно» выключено.
    await ok('PATCH', `/api/vwarehouses/${ozon.id}`, s.owner, { companyId: s.company, keepSeparate: false });
    const after = await ok('GET', '/api/vwarehouses/move-tasks', s.worker);
    v.expect('задания «переложить» по складу, который больше не хранится отдельно, сняты', after.length === 0,
      '0 открытых заданий', `было ${before}, осталось ${after.length}: ${after.map((x) => `${x.kind} ${x.left} шт. из ${x.fromLabel}`).join('; ')}`);
    const tr = (await ok('GET', `/api/vwarehouses/transfers?companyId=${s.company}`, s.owner)).find((x) => x.id === t.id);
    v.expect('перенос «Остальной товар → Озон» не висит «грузчик перекладывает»', tr.status !== 'to_move',
      'выполнен (склады снова вместе) или снят', `${tr.status} — ${tr.statusName}`);
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
