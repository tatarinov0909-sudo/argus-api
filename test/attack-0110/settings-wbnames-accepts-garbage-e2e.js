// «Настройки склада» → «Как вас называют продавцы на WB» (PATCH
// /api/warehouses/me, wbNames): не-строки не отвергаются, а превращаются в
// текст через String(): {} → «[object Object]», null → «null». Эти «имена»
// сохраняются и участвуют в правиле «наш склад WB»: склад продавца
// «Null Логистик» после такого сохранения сам становится «нашим», и его
// заказы приходят в работу. Экран так не отправляет, но сервер обязан
// проверять ввод сам.
//
// Ожидаемо: 400 на не-строку в списке (или такие элементы отброшены), в
// базе — только настоящие названия.
const { WB, order, startApp, warehouse, verdicts, fail } = require('./_lib');

(async () => {
  const { api, ok, stop } = await startApp();
  const v = verdicts('Проверка «как вас называют продавцы»');
  try {
    const ff = await warehouse(ok, 'Восход');
    const s = await ff.seller('Авезов', 'avezov', [
      { id: 11, name: 'ФФ Восход Москва', officeId: 500 },
      { id: 13, name: 'Null Логистик Казань', officeId: 777 },
    ]);
    WB.queue.avezov = [order(9301, 11), order(9302, 13)];
    await ff.sync(s.companyId);
    const r = await api('PATCH', '/api/warehouses/me', ff.token, { wbNames: ['Восход-Юг', {}, null] });
    const [row] = await ff.q('SELECT wb_names FROM warehouses WHERE id = $1', [ff.warehouseId]);
    v.expect('мусор в списке имён не сохраняется', r.status === 400 || JSON.stringify(row.wb_names) === '["Восход-Юг"]',
      '400 или ["Восход-Юг"]', `${r.status}, сохранено ${JSON.stringify(row.wb_names)}`);
    const w13 = (await ff.whs(s.companyId)).find((w) => w.id === '13');
    const work = await ff.inWork(s.companyId);
    v.expect('склад «Null Логистик Казань» не стал нашим из-за «null»', w13 && w13.ours === false, 'ours=false',
      `${JSON.stringify(w13)}; в работе: [${work.join()}]`);
  } finally {
    v.done();
    await stop();
  }
})().catch(fail);
