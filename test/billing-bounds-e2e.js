// Счета после починки проверки 05.10.2026 — то, чего нет в test/attack-0510:
//  1. пояс склада сдвинули на запад (Новосибирск → Москва): вечерняя работа,
//     не вошедшая в прошлый счёт, попадает в следующий ровно один раз, а не
//     выпадает из обоих;
//  2. номера счетов у склада — по порядку: СЧ-1, СЧ-2;
//  3. клиент не видит, кто из склада менял его прайс.
// Код выхода: 1 — ошибка, 2 — сломался тест.
const { startApp, stand, verdicts, fail } = require('./attack-0310/_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Счета: границы, номера, прайс у клиента');
  try {
    const s = await stand(app, { racks: 2 });
    await app.ok('PATCH', '/api/warehouses/me', s.owner, { timezone: 'Asia/Novosibirsk' });
    await s.receive([{ qty: 5, cell: s.cells[0] }]);
    // 20.09 18:30 UTC = 21.09 01:30 по Новосибирску = 20.09 21:30 по Москве.
    await s.q(`UPDATE receiving_records SET finished_at = '2026-09-20 18:30:00+00' WHERE company_id = $1`, [s.company]);
    await s.q('DELETE FROM billing_storage_days WHERE company_id = $1', [s.company]);
    await app.ok('PUT', '/api/warehouses/billing/tariff', s.owner, { companyId: s.company, effectiveFrom: '2026-09-01',
      prices: { storage: '0', receiving: '10', picking: '0', returns: '0' }, storageUnit: 'cell_day', showSellers: true });
    const first = await app.api('POST', '/api/warehouses/billing/invoices', s.owner, { companyId: s.company, from: '2026-09-01', to: '2026-09-20' });
    // Приёмка — 21.09 по Новосибирску: в счёт за 01–20.09 не входит.
    v.expect('счёт за 01–20.09 по Новосибирску приёмку 21.09 не берёт', first.status === 409, '409 «нет услуг»',
      `${first.status} ${JSON.stringify(first.body).slice(0, 120)}`);
    // Нужен счёт, чтобы было что продолжать: хранение 19.09.
    await s.q(`INSERT INTO billing_storage_days (warehouse_id, company_id, day, cells, units) VALUES ($1, $2, '2026-09-19', 1, 1)`,
      [s.warehouseId, s.company]);
    await app.ok('PUT', '/api/warehouses/billing/tariff', s.owner, { companyId: s.company, effectiveFrom: '2026-09-01',
      prices: { storage: '1', receiving: '10', picking: '0', returns: '0' }, storageUnit: 'cell_day', showSellers: true });
    const a = await app.ok('POST', '/api/warehouses/billing/invoices', s.owner, { companyId: s.company, from: '2026-09-01', to: '2026-09-20' });
    v.expect('первый счёт — только хранение 1 ₽', a.total === '1.00', '1.00', a.total);
    await app.ok('PATCH', '/api/warehouses/me', s.owner, { timezone: 'Europe/Moscow' });
    // По Москве приёмка — 20.09 21:30, то есть в днях уже выставленного счёта,
    // но в его границы (до 21.09 00:00 по Новосибирску) она не входила.
    const b = await app.ok('POST', '/api/warehouses/billing/invoices', s.owner, { companyId: s.company, from: '2026-09-21', to: '2026-09-21' });
    v.expect('после смены пояса на Москву приёмка попала в следующий счёт один раз', b.total === '50.00', '50.00',
      `${b.total}; строки ${JSON.stringify(b.lines.map((l) => [l.service, l.qty, l.details.map((d) => d.day)]))}`);
    v.expect('день работы в счёте — внутри его периода', b.lines.every((l) => l.details.every((d) => d.day === '2026-09-21')),
      'все работы — 21.09', JSON.stringify(b.lines.map((l) => l.details.map((d) => d.day))));
    v.expect('номера счетов по порядку', a.number === 'СЧ-1' && b.number === 'СЧ-2', 'СЧ-1, СЧ-2', `${a.number}, ${b.number}`);

    const mine = await app.ok('GET', '/api/sellers/billing?month=2026-09', s.seller);
    v.expect('клиент не видит, кто менял прайс', mine.tariff.history.length > 0 && mine.tariff.history.every((h) => !('updatedBy' in h)),
      'нет updatedBy', JSON.stringify(mine.tariff.history[0]));
    const own = await app.ok('GET', `/api/sellers/billing?month=2026-09&companyId=${s.company}`, s.owner);
    v.expect('руководитель видит, кто менял прайс', own.tariff.history.every((h) => 'updatedBy' in h), 'есть updatedBy',
      JSON.stringify(own.tariff.history[0]));
  } catch (err) { fail(err); } finally { await app.stop(); v.done(); }
})();
