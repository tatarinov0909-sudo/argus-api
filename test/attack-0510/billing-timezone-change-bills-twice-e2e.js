// Находка: после смены часового пояса склада одна и та же работа попадает
// во второй счёт. Счета различаются только датами периода, а не самими
// операциями: приёмка 20.09 в 22:30 по Москве — это уже 21.09 по
// Новосибирску. Счёт за 01–20.09 её взял, после смены пояса счёт за 21.09
// берёт её ещё раз.
//
// Код выхода: 1 — ошибка Аргуса, 2 — сломался тест.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Смена пояса склада и выставленные счета');
  try {
    const s = await stand(app, { racks: 2 });
    await s.receive([{ qty: 5, cell: s.cells[0] }]);
    // Приёмка — 20.09.2026 в 22:30 по Москве (19:30 UTC).
    await s.q(`UPDATE receiving_records SET finished_at = '2026-09-20 19:30:00+00' WHERE company_id = $1`, [s.company]);
    await s.q('DELETE FROM billing_storage_days WHERE company_id = $1', [s.company]);
    await app.ok('PUT', '/api/warehouses/billing/tariff', s.owner, { companyId: s.company, effectiveFrom: '2026-09-01',
      prices: { storage: '0', receiving: '10', picking: '0', returns: '0' }, storageUnit: 'cell_day', showSellers: true });

    const first = await app.ok('POST', '/api/warehouses/billing/invoices', s.owner, { companyId: s.company, from: '2026-09-01', to: '2026-09-20' });
    if (first.total !== '50.00') throw Error(`первый счёт не 50 ₽, а ${first.total}`);

    // Владелец исправляет пояс в настройках склада (склад на самом деле в Новосибирске).
    await app.ok('PATCH', '/api/warehouses/me', s.owner, { timezone: 'Asia/Novosibirsk' });
    const second = await app.api('POST', '/api/warehouses/billing/invoices', s.owner, { companyId: s.company, from: '2026-09-21', to: '2026-09-21' });
    const again = second.status < 300 ? second.body.total : '0.00';
    const sum = Number(first.total) + Number(again);
    v.expect('5 шт. приёмки (10 ₽/шт.) оплачиваются один раз — во всех счетах вместе 50 ₽',
      sum === 50, 'счёт за 21.09 не берёт приёмку из счёта за 01–20.09 (итого 50 ₽)',
      `счёт за 01–20.09 — ${first.total} ₽, счёт за 21.09 — ${again} ₽ (${second.status}); всего ${sum} ₽`);
  } catch (err) { fail(err); } finally { await app.stop(); v.done(); }
})();
