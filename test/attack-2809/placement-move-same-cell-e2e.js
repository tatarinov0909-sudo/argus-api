// Атака: «Переложить» из ячейки в ту же ячейку.
//
// Требование: задание 28.09 п. 1 — «Переложить» — забрать N шт. из ячейки и
// положить в ДРУГУЮ; сервер сам отказывает «Это та же ячейка — выберите
// другую» (src/receiving/routes.js, POST /items/:id/move). Отказ сравнивает
// строки, а не ячейки: тот же UUID заглавными буквами проходит.
const { startApp, setup, verdicts } = require('./_lib');

(async () => {
  const { api, ok, stop } = await startApp();
  const v = verdicts('«Переложить» в ту же ячейку');
  try {
    const s = await setup(ok, { skus: [['A-1', 'Зефир'], ['A-2', 'Пастила']] });
    const w = s.staff['Джоник'];
    const c1 = s.cell(1);
    const inv = await s.invoice('ПР-АТК-ТАЖЕ', [['A-1', 'Зефир', 20], ['A-2', 'Пастила', 5]]);
    const z = inv.items.find((i) => i.sku === 'A-1').id;
    await ok('POST', `/api/receiving/session/${inv.id}/start`, w, {}, 201);
    await ok('POST', '/api/receiving', w, { invoiceItemId: z, acceptedQty: 20, cellBlockId: c1 }, 201);

    const plain = await api('POST', `/api/receiving/items/${z}/move`, w, { fromCellBlockId: c1, toCellBlockId: c1, qty: 5 });
    const upper = await api('POST', `/api/receiving/items/${z}/move`, w, { fromCellBlockId: c1, toCellBlockId: c1.toUpperCase(), qty: 5 });
    const journal = await ok('GET', `/api/journal?invoiceId=${inv.id}`, s.token);
    const moved = journal.map((e) => e.action_text).find((t) => /^Переложил/.test(t));
    v.expect('та же ячейка — отказ (как написано в коде)', plain.status === 400, '400', `${plain.status}`);
    v.expect('та же ячейка, тот же UUID заглавными, — тоже отказ',
      upper.status === 400, '400 «Это та же ячейка — выберите другую»',
      `${upper.status}; в журнале: «${moved || '—'}»`);
  } finally {
    v.done();
    await stop();
  }
})().catch((err) => { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; });
