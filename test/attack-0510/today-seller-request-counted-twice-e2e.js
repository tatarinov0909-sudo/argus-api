// Находка: на «Главной» руководителя одна заявка клиента на перенос
// считается дважды — и как «расхождение», и как «заявка клиента на перенос».
// Плитка «Ждут решения» показывает 2, хотя решить надо одно.
//
// Код выхода: 1 — ошибка Аргуса, 2 — сломался тест.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('«Сегодня»: заявка клиента на перенос');
  try {
    const s = await stand(app, { racks: 2 });
    await s.receive([{ qty: 10, cell: s.cells[0] }]);
    const vw = await app.ok('POST', '/api/vwarehouses', s.owner, { companyId: s.company, name: 'Озон', marketplace: 'other' });
    const before = await app.ok('GET', '/api/alerts/today', s.owner);
    // Клиент просит склад перенести 3 шт. на свой склад «Озон».
    await app.ok('POST', '/api/vwarehouses/transfers', s.seller, { sku: 'R-1', qty: 3, fromVw: null, toVw: vw.id });
    const d = (await app.ok('GET', '/api/alerts/today', s.owner)).decide;
    const b = before.decide;
    // Как на экране: «Ждут решения» = расхождения + заявки клиентов + пересчёты.
    const tile = (x) => x.discrepancies + x.sellerRequests + x.recounts;
    v.expect('одна заявка — «Ждут решения» выросло на 1', tile(d) - tile(b) === 1,
      '+1 (1 заявка клиента на перенос, 0 расхождений)',
      `+${tile(d) - tile(b)}: расхождений ${d.discrepancies - b.discrepancies}, заявок клиентов ${d.sellerRequests - b.sellerRequests}`);
  } catch (err) { fail(err); } finally { await app.stop(); v.done(); }
})();
