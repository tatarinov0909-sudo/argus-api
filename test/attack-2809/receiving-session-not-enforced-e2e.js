// Атака: приёмка и раскладка идут мимо «хода работы» (work_sessions).
//
// Требования: задание 27.09 п. 15–21 и 27.09-2 п. 4 — работа начинается только
// «Начать», у документа один живой заход, чужую работу «забирают» (это видно в
// журнале); решение владельца 26.09.2026 — «на паузе работа заперта целиком».
// 28.09 п. 1 добавило шаги раскладки /items/:id/place|move|remove — они тоже
// работа грузчика по приходу.
const { startApp, setup, verdicts } = require('./_lib');

(async () => {
  const { api, ok, stop } = await startApp();
  const v = verdicts('Приёмка без хода работы');
  try {
    const s = await setup(ok, { skus: [['A-1', 'Зефир'], ['A-2', 'Пастила'], ['A-3', 'Мармелад']], workers: ['Джоник', 'Дима'] });
    const jonik = s.staff['Джоник'];
    const dima = s.staff['Дима'];

    // 1. Приход, который никто не начинал: принять позицию можно сразу.
    const idle = await s.invoice('ПР-АТК-0', [['A-1', 'Зефир', 5], ['A-2', 'Пастила', 5]]);
    const noStart = await api('POST', '/api/receiving', jonik, { invoiceItemId: idle.items[0].id, acceptedQty: 5, cellBlockId: s.cell(1) });
    v.expect('принять позицию без «Начать» (заход не открыт) — отказ',
      noStart.status === 409, '409: сначала «Начать» (задание 27.09 п. 15, 27.09-2 п. 4)',
      `${noStart.status} ${JSON.stringify(noStart.body).slice(0, 120)}`);

    // 2. Приход ведёт Джоник (заход идёт) — Дима молча принимает и раскладывает.
    const inv = await s.invoice('ПР-АТК-1', [['A-1', 'Зефир', 10], ['A-2', 'Пастила', 10], ['A-3', 'Мармелад', 10]]);
    const [z, p, m] = inv.items.map((i) => i.id);
    await ok('POST', `/api/receiving/session/${inv.id}/start`, jonik, {}, 201);
    const foreign = await api('POST', '/api/receiving', dima, { invoiceItemId: z, acceptedQty: 10, placements: [{ cellBlockId: s.cell(1), qty: 6 }] });
    v.expect('Дима принимает позицию прихода, который ведёт Джоник, не забрав приёмку, — отказ',
      foreign.status === 409, '409 «Приход принимает Джоник… Забрать приёмку себе?» (один живой заход, забирают явно)',
      `${foreign.status} ${JSON.stringify(foreign.body).slice(0, 120)}`);
    const foreignPlace = await api('POST', `/api/receiving/items/${z}/place`, dima, { cellBlockId: s.cell(2), qty: 4 });
    v.expect('Дима раскладывает («осталось разложить») чужую приёмку — отказ',
      foreignPlace.status === 409, '409 — шаг раскладки делает тот, кто ведёт приёмку',
      `${foreignPlace.status} ${JSON.stringify(foreignPlace.body).slice(0, 120)}`);

    // 3. Джоник поставил приёмку на паузу — работа должна быть заперта.
    await ok('POST', '/api/journal/pause', jonik, { invoiceId: inv.id, reason: 'обед' });
    const state = await ok('GET', `/api/receiving/session/${inv.id}`, jonik);
    const pausedRecv = await api('POST', '/api/receiving', jonik, { invoiceItemId: p, acceptedQty: 10, cellBlockId: s.cell(3) });
    v.expect(`приёмка на паузе (заход: ${state.assembly && state.assembly.status}) — принять позицию нельзя`,
      pausedRecv.status === 409, '409 — «на паузе работа заперта целиком» (решение 26.09.2026)',
      `${pausedRecv.status} ${JSON.stringify(pausedRecv.body).slice(0, 120)}`);

    // 4. Последнюю позицию принимает Дима — заход Джоника закрывается «Джоник
    // закончил приёмку», хотя последние шаги сделал другой человек.
    const last = await api('POST', '/api/receiving', dima, { invoiceItemId: m, acceptedQty: 10, cellBlockId: s.cell(4) });
    const journal = await ok('GET', `/api/journal?invoiceId=${inv.id}`, s.token);
    const closedAs = journal.map((e) => e.action_text).find((t) => /закончил приёмку/.test(t)) || '(нет записи)';
    v.expect('журнал не приписывает Джонику работу, которую доделал Дима',
      !/^Джоник закончил приёмку/.test(closedAs),
      'конец работы — от того, кто её сделал, или Диме пришлось бы забрать приёмку (запись «забрал себе»)',
      `последнюю позицию принял Дима: ${last.status}, invoiceStatus=${last.body && last.body.invoiceStatus}; в журнале: «${closedAs}»`);
  } finally {
    v.done();
    await stop();
  }
})().catch((err) => { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; });
