// Атака: категория записи журнала зависит от того, кто нажал кнопку.
//
// Требование: задание 28.09 п. 3 — «1. Приходы (привоз продавца, машина
// приехала, документы, акт приёмки)»; категорию определяет сервер одним
// правилом (src/journal/category.js). «Машина приехала» отмечает руководитель,
// менеджер или грузчик (задание 27.09-2 п. 3, маршрут POST /api/inbound/:id/arrived
// открыт грузчику).
const { startApp, setup, verdicts } = require('./_lib');

(async () => {
  const { ok, stop } = await startApp();
  const v = verdicts('Категория «машина приехала»');
  try {
    const s = await setup(ok, { skus: [['A-1', 'Зефир']] });
    const worker = s.staff['Джоник'];
    const byOwner = await s.invoice('ПР-АТК-МАШ-1', [['A-1', 'Зефир', 5]]);
    const byWorker = await s.invoice('ПР-АТК-МАШ-2', [['A-1', 'Зефир', 5]]);
    await ok('POST', `/api/inbound/${byOwner.id}/arrived`, s.token, {});
    await ok('POST', `/api/inbound/${byWorker.id}/arrived`, worker, {});

    const journal = await ok('GET', '/api/journal', s.token);
    const entry = (number) => journal.find((e) => /^Машина по приходу/.test(e.action_text) && e.action_text.includes(number));
    const o = entry('ПР-АТК-МАШ-1');
    const w = entry('ПР-АТК-МАШ-2');
    v.expect('«Машина приехала», отмеченная руководителем, — «Приходы»',
      o && o.category === 'inbound', 'inbound (Приходы)', o ? `${o.category} (${o.category_label})` : 'записи нет');
    v.expect('«Машина приехала», отмеченная грузчиком у ворот, — тоже «Приходы»',
      w && w.category === 'inbound', 'inbound (Приходы) — список владельца, п. 3.1',
      w ? `${w.category} (${w.category_label}), work_key=${w.work_key}` : 'записи нет');
  } finally {
    v.done();
    await stop();
  }
})().catch((err) => { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; });
