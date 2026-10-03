// Находка: заявка продавца на перенос между его складами пишется в журнал как
// «очень важно» — тем же флагом, что отметки грузчиков «нет товара». А такие
// записи журнал прячет от менеджера без права «получать отметки «нет товара»».
// Итог: менеджер (которому переносы разрешены) заявок продавцов в журнале не
// видит вовсе, а «Подтвердить» из журнала отвечает «Отметки «нет товара»
// решает владелец или менеджер с этим правом».
//
// Документ: «Виртуальные склады — схема.md» — «Переносить между складами
// могут руководитель и менеджер — сразу… заявки продавцов на перенос — в
// журнале «ждёт решения» с пометкой «очень важно»».
const { startApp, stand, verdicts, fail } = require('./_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Заявка продавца на перенос и менеджер');
  try {
    const s = await stand(app);
    const { ok, api } = app;
    const [A] = s.cells;
    const ozon = await ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'Озон', marketplace: 'ozon' });
    const r = await s.receive([{ vw: null, qty: 10, cell: A }]);
    if (r.results[0].status !== 201) throw Error('приёмка: ' + JSON.stringify(r.results));
    const req = await ok('POST', '/api/vwarehouses/transfers', s.seller, { sku: 'R-1', qty: 5, fromVw: null, toVw: ozon.id, note: 'под Озон' });

    const ownerJ = await ok('GET', '/api/journal', s.owner);
    const entry = ownerJ.find((e) => e.entity_type === 'vw_transfer' && e.entity_id === req.id);
    if (!entry) throw Error('у руководителя заявки в журнале нет — тест сломан');
    const mgrJ = await ok('GET', '/api/journal', s.manager);
    v.expect('менеджер видит заявку продавца в журнале', mgrJ.some((e) => e.id === entry.id),
      'запись «Продавец просит перенести…» есть', 'записи нет (журнал прячет «очень важно» от менеджера без права «нет товара»)');
    const res = await api('POST', `/api/journal/${entry.id}/resolve`, s.manager, { resolution: 'confirm' });
    v.expect('менеджер может выполнить заявку из журнала', res.status === 201,
      '201', `${res.status} ${JSON.stringify(res.body)}`);
    // Тот же менеджер через «Остатки продавцов» выполнить может — права у него есть.
    if (res.status !== 201) {
      const other = await api('POST', `/api/vwarehouses/transfers/${req.id}/decide`, s.manager, { approve: true });
      console.log(`  (контроль) «Выполнить» в «Остатках продавцов» тем же менеджером: ${other.status}`);
    }
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
