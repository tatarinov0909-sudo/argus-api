// Склады WB: заказ, который склад уже ведёт (он в поставке), одновременно
// числится «отложенным» — и «не в работе», и «в работе».
//
// Сценарий: заказ 8001 со склада «ФФ Восход» в поставке Аргуса. Менеджер
// снимает галочку со склада — 8001 по правилу остаётся в работе (есть
// поставка). Пока запись на WB выключена, заказ остаётся в очереди WB
// orders/new, и следующий обмен кладёт его ещё и в wb_foreign_orders.
// Итог: в окне продавца «В работе заказов: 1 · не в работе: 2», у продавца
// «2 заказа склад не собирает», хотя собирают один из них прямо сейчас. Когда
// галочку вернут, ответ и журнал говорят «вернулись в работу: 2», хотя
// вернулся один.
//
// Ожидаемо: заказ, который в работе, не считается отложенным; «вернулось»
// — только то, что действительно вернулось.
const { WB, order, startApp, warehouse, verdicts, fail } = require('./_lib');

(async () => {
  const { ok, stop } = await startApp();
  const v = verdicts('Счётчик отложенных заказов');
  try {
    const ff = await warehouse(ok, 'Восход');
    const s = await ff.seller('Авезов', 'avezov', [
      { id: 11, name: 'ФФ Восход Москва', officeId: 500 },
      { id: 12, name: 'ФФ Другой', officeId: 900 },
    ]);
    WB.queue.avezov = [order(8001, 11), order(8002, 11)];
    await ff.sync(s.companyId);
    const [inv] = await ff.q(`SELECT id FROM invoices WHERE company_id = $1 AND external_id = '8001'`, [s.companyId]);
    await ok('POST', '/api/supplies', ff.token, { invoiceIds: [inv.id], marketplace: 'wb', destination: 'Коледино' }, 201);

    const off = await ok('PATCH', `/api/marketplaces/${s.companyId}/wb/warehouses/11`, ff.token, { ours: false });
    v.expect('сняли галочку: убран только заказ без работы (8002)', off.hidden === 1, 'hidden=1', `hidden=${off.hidden}`);
    // Следующий обмен: WB по-прежнему отдаёт оба заказа в очереди.
    await ff.sync(s.companyId);
    const work = await ff.inWork(s.companyId);
    const hid = await ff.hidden(s.companyId);
    v.expect('8001 в работе (в поставке)', work.includes('8001'), 'в работе 8001', `в работе: [${work.join()}]`);
    v.expect('заказ в работе не лежит одновременно в отложенных', !hid.includes('8001'),
      'отложен только 8002', `отложены: [${hid.join()}]`);

    const card = await ok('GET', `/api/marketplaces/${s.companyId}/wb/warehouses`, ff.token);
    const w11 = card.warehouses.find((w) => w.id === '11');
    v.expect('окно продавца: «в работе 1 · не в работе 1»', w11.openOrders === 1 && w11.hidden === 1,
      'openOrders=1, hidden=1', `openOrders=${w11.openOrders}, hidden=${w11.hidden}`);
    const sellerView = await ok('GET', '/api/sellers/wb-warehouses', await ff.sellerToken(s.companyId));
    const sw11 = sellerView.warehouses.find((w) => w.id === '11');
    v.expect('кабинет продавца: «склад не собирает» 1 заказ, а не 2', sw11.hidden === 1, 'hidden=1', `hidden=${sw11.hidden}`);

    const on = await ok('PATCH', `/api/marketplaces/${s.companyId}/wb/warehouses/11`, ff.token, { ours: true });
    v.expect('вернули галочку: «вернулось в работу» — 1 заказ (8002)', on.restored === 1, 'restored=1', `restored=${on.restored}`);
    const [note] = await ff.q(`SELECT action_text FROM journal_entries WHERE warehouse_id = $1 AND action_text LIKE '%вернулись в работу%'
      ORDER BY created_at DESC LIMIT 1`, [ff.warehouseId]);
    console.log(`        журнал: ${note && note.action_text}`);
  } finally {
    v.done();
    await stop();
  }
})().catch(fail);
