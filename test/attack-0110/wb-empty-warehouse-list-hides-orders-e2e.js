// Склады WB: один пустой ответ WB на «склады продавца» убирает из работы все
// заказы продавца, отмеченные правилом.
//
// refresh() записывает всё, чего нет в ответе, как «пропавшее» (gone_at), а
// правило autoOurs у пропавшего склада снимает отметку — и settle уводит его
// заказы в отложенные. Пустой ответ при этом не считается сбоем, хотя в той же
// очереди WB лежат новые заказы с этого самого склада. В другом месте код сам
// держится правила «пустой ответ WB — сбой, а не "пунктов нет"»
// (supplies/routes.js, пункты отгрузки).
//
// Ожидаемо: пустой список складов при живых заказах с них — сбой чтения:
// отметки и заказы не трогаются, в работу приходит новый заказ.
const { WB, order, startApp, warehouse, verdicts, fail } = require('./_lib');

(async () => {
  const { ok, stop } = await startApp();
  const v = verdicts('Пустой список складов WB');
  try {
    const ff = await warehouse(ok, 'Восход');
    const s = await ff.seller('Авезов', 'avezov', [
      { id: 11, name: 'ФФ Восход Москва', officeId: 500 },
      { id: 12, name: 'ФФ Другой', officeId: 900 },
    ]);
    WB.queue.avezov = [order(6001, 11), order(6002, 11)];
    await ff.sync(s.companyId);
    const before = await ff.inWork(s.companyId);
    v.expect('исходно: заказы склада «ФФ Восход Москва» в работе', before.join() === '6001,6002', '6001,6002', before.join());

    // Час спустя WB на «склады продавца» ответил пустым списком, а в очереди —
    // новый заказ с того же склада 11.
    WB.warehouses.avezov = [];
    WB.queue.avezov = [order(6001, 11), order(6002, 11), order(6003, 11)];
    await ff.q(`UPDATE marketplace_credentials SET wb_warehouses_at = now() - interval '2 hours' WHERE company_id = $1`, [s.companyId]);
    const res = await ff.sync(s.companyId);
    const w11 = (await ff.whs(s.companyId)).find((w) => w.id === '11');
    const work = await ff.inWork(s.companyId);
    const off = await ff.hidden(s.companyId);
    v.expect('склад 11 остался нашим', w11 && w11.ours === true, 'ours=true', JSON.stringify(w11));
    v.expect('заказы склада 11 в работе, новый 6003 тоже', work.join() === '6001,6002,6003', '6001,6002,6003',
      `в работе: [${work.join()}], отложено: [${off.join()}], обмен: warehouses=${JSON.stringify(res.warehouses)}`);
  } finally {
    v.done();
    await stop();
  }
})().catch(fail);
