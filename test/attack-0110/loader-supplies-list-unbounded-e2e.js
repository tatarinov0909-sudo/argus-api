// Ограничение списков (аудит 30.09, хендофф 30.09-2 п. 7): «грузчику не
// отдаются закрытые документы старше 14 дней». Для приходов и заказов
// (GET /api/invoices) это сделано, а поставки грузчик по-прежнему получает
// все за всю историю: экран грузчика (loader.html, refreshWork) на каждом
// входе на главный экран тянет GET /api/supplies без ограничения, и список
// растёт с каждой уехавшей поставкой — тот же рост, от которого лечили
// /api/invoices.
//
// Ожидаемо: уехавшая месяц назад поставка грузчику не отдаётся — как и
// заказ этой поставки.
const { WB, order, startApp, warehouse, verdicts, admin, fail } = require('./_lib');

(async () => {
  const { ok, stop } = await startApp();
  const v = verdicts('Список поставок у грузчика');
  try {
    const ff = await warehouse(ok, 'Восход');
    const s = await ff.seller('Авезов', 'avezov', [{ id: 11, name: 'ФФ Восход Москва', officeId: 500 }]);
    WB.queue.avezov = [order(9101, 11)];
    await ff.sync(s.companyId);
    const [inv] = await ff.q(`SELECT id FROM invoices WHERE company_id = $1 AND external_id = '9101'`, [s.companyId]);
    const supply = await ok('POST', '/api/supplies', ff.token, { invoiceIds: [inv.id], marketplace: 'wb', destination: 'Коледино' }, 201);
    // Поставка уехала месяц назад (через API отгрузку не состарить — готовим данные).
    await admin(`UPDATE supplies SET status = 'shipped', shipped_at = now() - interval '30 days', created_at = now() - interval '31 days' WHERE id = $1`, [supply.id]);
    await admin(`UPDATE invoices SET status = 'shipped', shipped_at = now() - interval '30 days', created_at = now() - interval '31 days' WHERE id = $1`, [inv.id]);

    const worker = await ff.worker('Джоник');
    const invoices = await ok('GET', '/api/invoices', worker);
    const supplies = await ok('GET', '/api/supplies', worker);
    v.expect('заказ, уехавший месяц назад, грузчику не отдаётся (так уже сделано)', !invoices.some((i) => i.id === inv.id),
      'нет в /api/invoices', 'есть');
    v.expect('поставка, уехавшая месяц назад, грузчику тоже не отдаётся', !supplies.some((x) => x.id === supply.id),
      'нет в /api/supplies', `есть: «${supply.number}», всего поставок в ответе ${supplies.length}`);
  } finally {
    v.done();
    await stop();
  }
})().catch(fail);
