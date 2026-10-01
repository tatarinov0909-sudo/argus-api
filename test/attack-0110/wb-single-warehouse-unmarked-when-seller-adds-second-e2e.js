// Склады WB, правило «у продавца единственный склад — он наш» (случай
// «Слим Тим»: один склад «ФФ Восток» без имени фулфилмента, на проде так
// стал нашим 01.10 00:15).
//
// Сценарий: у продавца один склад, заказы с него в работе у фулфилмента.
// Продавец заводит на WB второй склад — под другой фулфилмент. Аргус при
// следующем чтении складов пересчитывает правило: складов уже два, ни в
// одном нет нашего имени — и снимает отметку с ПЕРВОГО склада. Все заказы
// продавца молча уходят из работы, новые больше не приходят.
//
// Ожидаемо: склад, с которого мы уже работали (отмечен правилом, заказы в
// работе), не теряет отметку из-за того, что у продавца появился чужой
// склад; новый склад остаётся неотмеченным до решения человека.
const { WB, order, startApp, warehouse, verdicts, fail } = require('./_lib');

(async () => {
  const { ok, stop } = await startApp();
  const v = verdicts('Единственный склад продавца теряет отметку');
  try {
    const ff = await warehouse(ok, 'Ромашка');
    const tim = await ff.seller('Слим Тим', 'slim', [{ id: 31, name: 'ФФ Восток', officeId: 500 }]);
    WB.queue.slim = [order(5001, 31), order(5002, 31)];
    await ff.sync(tim.companyId);
    const before = await ff.inWork(tim.companyId);
    const w0 = (await ff.whs(tim.companyId)).find((w) => w.id === '31');
    v.expect('исходно: единственный склад «ФФ Восток» отмечен нашим правилом', w0 && w0.ours === true && w0.decided_by === null,
      'ours=true, решил Аргус', JSON.stringify(w0));
    v.expect('исходно: оба заказа продавца в работе', before.join() === '5001,5002', '5001,5002', before.join());

    // Продавец завёл на WB второй склад — для другого фулфилмента в Казани.
    WB.warehouses.slim.push({ id: 32, name: 'Склад Казань', officeId: 777 });
    WB.queue.slim = [order(5001, 31), order(5002, 31), order(5003, 31)];
    // Список складов перечитывается раз в час — «час спустя».
    await ff.q(`UPDATE marketplace_credentials SET wb_warehouses_at = now() - interval '2 hours' WHERE company_id = $1`, [tim.companyId]);
    const res = await ff.sync(tim.companyId);

    const after = await ff.whs(tim.companyId);
    const w31 = after.find((w) => w.id === '31');
    const w32 = after.find((w) => w.id === '32');
    const work = await ff.inWork(tim.companyId);
    const off = await ff.hidden(tim.companyId);
    v.expect('склад «ФФ Восток», с которого уже шли заказы, остался нашим', w31 && w31.ours === true,
      'ours=true', JSON.stringify(w31));
    v.expect('новый склад «Склад Казань» не отмечен (решает человек)', w32 && w32.ours === false, 'ours=false', JSON.stringify(w32));
    v.expect('заказы с «ФФ Восток» остались в работе, новый пришёл', work.join() === '5001,5002,5003',
      '5001,5002,5003', `в работе: [${work.join()}], отложено: [${off.join()}], ответ обмена: hidden=${res.settled.hidden}, foreign=${res.foreign}`);
    const notes = (await ff.q(`SELECT action_text FROM journal_entries WHERE warehouse_id = $1 AND entity_type = 'wb_warehouse'
      ORDER BY created_at DESC LIMIT 2`, [ff.warehouseId])).map((r) => r.action_text);
    console.log(`        журнал: ${notes.join(' | ')}`);
  } finally {
    v.done();
    await stop();
  }
})().catch(fail);
