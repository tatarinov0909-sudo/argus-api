// Проверка 07.10: адресное хранение включили снова.
//
// Владелец 06.10: выключили — весь товар в «Складе»; включат снова, когда
// будет схема, и «товар снова кладут в ячейки» (так пишет и журнал). Но
// подсказка приёмки первым местом предлагает «Склад» («тот же товар уже
// здесь»): грузчик по подсказке кладёт новый приход обратно в общую кучу,
// и разложить склад по ячейкам не получается.
//
// Код выхода: 1 — ошибка Аргуса, 2 — сломался тест.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Подсказка приёмки после обратного включения адресного хранения');
  try {
    const s = await stand(app, { racks: 4 });
    await s.receive([{ qty: 5, cell: s.cells[0] }]);
    await app.ok('PATCH', '/api/warehouses/me', s.owner, { addressStorage: false });
    await app.ok('PATCH', '/api/warehouses/me', s.owner, { addressStorage: true });
    const hint = await app.ok('GET', `/api/agents/kladovshchik/suggest-cell?sku=R-1&companyId=${s.company}`, s.worker);
    const labels = hint.options.map((o) => `${o.label} (${o.reason})`);
    v.expect('хранение включено — приёмка предлагает ячейки, а не общее место «Склад»',
      !hint.options.some((o) => o.label === 'Склад'), 'ячейки 1.x.x', labels.join(', '));
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
