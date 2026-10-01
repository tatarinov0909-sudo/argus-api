// «Настройки склада»: переименование склада (или правка поля «Как вас
// называют продавцы на WB») молча убирает из работы заказы всех продавцов.
//
// Правило «наш склад WB» ищет название склада Аргуса в названиях складов
// продавцов на WB. PATCH /api/warehouses/me при любом name/wbNames
// пересчитывает отметки у всех продавцов и сразу убирает заказы складов,
// переставших «совпадать». Экран «Настройки склада» отправляет name и
// wbNames при КАЖДОМ сохранении и не предупреждает; ответ сервера не говорит,
// что заказы ушли. Владелец дописал к названию «Логистик» для актов — и у
// фулфилмента пропали все заказы WB.
//
// Ожидаемо: переименование склада не убирает из работы заказы, которые
// склад уже вёл, — или хотя бы сервер не делает этого молча (просит
// подтверждение / сообщает, сколько заказов уйдёт).
const { WB, order, startApp, warehouse, verdicts, fail } = require('./_lib');

(async () => {
  const { ok, stop } = await startApp();
  const v = verdicts('Переименование склада и заказы WB');
  try {
    const ff = await warehouse(ok, 'Восход');
    const a = await ff.seller('Авезов', 'avezov', [
      { id: 11, name: 'ФФ Восход Москва', officeId: 500 },
      { id: 12, name: 'ФФ Другой Самара', officeId: 900 },
    ]);
    const b = await ff.seller('Бета', 'beta', [
      { id: 21, name: 'Восход Краснодар', officeId: 600 },
      { id: 22, name: 'ФФ Юг', officeId: 601 },
    ]);
    WB.queue.avezov = [order(7001, 11), order(7002, 11)];
    WB.queue.beta = [order(7101, 21)];
    await ff.sync(a.companyId);
    await ff.sync(b.companyId);
    const before = [...await ff.inWork(a.companyId), ...await ff.inWork(b.companyId)];
    v.expect('исходно: заказы складов «ФФ Восход Москва» и «Восход Краснодар» в работе',
      before.join() === '7001,7002,7101', '7001,7002,7101', before.join());

    // Экран «Настройки склада» шлёт всё сразу; меняем только название.
    const res = await ok('PATCH', '/api/warehouses/me', ff.token, {
      name: 'Восход Логистик', city: 'Москва', legalName: '', timezone: 'Europe/Moscow', wbNames: [],
      stockSource: '1c', wbSuppliesBy: 'ff', setupDone: true,
    });
    const after = [...await ff.inWork(a.companyId), ...await ff.inWork(b.companyId)];
    const off = [...await ff.hidden(a.companyId), ...await ff.hidden(b.companyId)];
    v.expect('после переименования склада заказы, которые склад вёл, остались в работе', after.join() === '7001,7002,7101',
      '7001,7002,7101', `в работе: [${after.join()}], отложено: [${off.join()}]`);
    const told = JSON.stringify(res);
    v.expect('если заказы всё же убраны — ответ сервера об этом говорит (экран может предупредить)',
      after.length === before.length || /hidden|убран|заказ/i.test(told), 'в ответе — сколько заказов ушло',
      `ответ PATCH: ${told.slice(0, 200)}`);
  } finally {
    v.done();
    await stop();
  }
})().catch(fail);
