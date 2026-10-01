// Склады WB, гонка «обмен во время отметки»: галочка склада и кнопка
// «Обновить из WB» падают с ошибкой (взаимная блокировка в базе), если их
// нажали, пока обмен с WB читает склады этого продавца. Человек видит
// «Склад занят другой операцией с теми же ячейками» — про ячейки, которых
// он не трогал; галочка не сохраняется.
//
// Почему: обмен (sync.pullWildberries) сначала блокирует строку ключа
// (markUsed → UPDATE marketplace_credentials), потом строки складов продавца
// (refresh → INSERT … ON CONFLICT DO UPDATE seller_wb_warehouses). Галочка
// (sellerWarehouses.setOurs) и «Обновить из WB» (refreshNow) — наоборот:
// сначала строки складов, потом строку ключа. Встречный порядок блокировок →
// deadlock, одна из транзакций откатывается. Склады читаются раз в час и по
// кнопке, а ответ WB идёт секунды — окно реальное.
//
// Ожидаемо: действие человека и обмен не мешают друг другу — оба доходят до
// конца (один ждёт другого), без ошибки.
const { WB, order, startApp, warehouse, verdicts, fail } = require('./_lib');
const wb = require('../../src/marketplaces/wb');

(async () => {
  const { api, ok, stop } = await startApp();
  const v = verdicts('Действия со складами WB во время обмена');
  const fetchWarehouses = wb.warehouses;
  try {
    const ff = await warehouse(ok, 'Восход');
    const s = await ff.seller('Авезов', 'avezov', [
      { id: 11, name: 'ФФ Восход Москва', officeId: 500 },
      { id: 12, name: 'ФФ Другой', officeId: 900 },
    ]);
    WB.queue.avezov = [order(9001, 11), order(9002, 12)];
    await ff.sync(s.companyId);

    // Обмен дошёл до «склады продавца» у WB; WB отвечает не сразу — в это
    // время человек нажимает action(). Остальные запросы к WB — сразу.
    async function duringSync(action) {
      let reached;
      const atWb = new Promise((r) => { reached = r; });
      let release;
      const gate = new Promise((r) => { release = r; });
      let first = true;
      wb.warehouses = async (t) => { if (first) { first = false; reached(); await gate; } return fetchWarehouses(t); };
      // Список складов перечитывается раз в час — «час спустя».
      await ff.q(`UPDATE marketplace_credentials SET wb_warehouses_at = now() - interval '2 hours' WHERE company_id = $1`, [s.companyId]);
      const syncing = api('POST', '/api/marketplaces/sync', ff.token, { companyId: s.companyId });
      await atWb;
      const acting = action();
      await new Promise((r) => setTimeout(r, 400));   // действие дошло до базы и ждёт
      release();
      const [sy, act] = await Promise.all([syncing, acting]);
      wb.warehouses = fetchWarehouses;
      return { sy, act };
    }

    const t1 = await duringSync(() => api('PATCH', `/api/marketplaces/${s.companyId}/wb/warehouses/12`, ff.token, { ours: true }));
    v.expect('галочка «наш склад» во время обмена сохранилась (200)', t1.act.status === 200, '200',
      `${t1.act.status} ${JSON.stringify(t1.act.body)}`);
    v.expect('обмен при этом прошёл без ошибки чтения складов', t1.sy.status === 200 && !(t1.sy.body.warehouses && t1.sy.body.warehouses.error),
      'warehouses без error', `${t1.sy.status} warehouses=${JSON.stringify(t1.sy.body && t1.sy.body.warehouses)}`);
    const [w12] = (await ff.whs(s.companyId)).filter((w) => w.id === '12');
    v.expect('склад 12 в итоге отмечен вашим', w12 && w12.ours === true, 'ours=true', JSON.stringify(w12));

    // Отметку возвращаем как было, чтобы второй сценарий начинался так же.
    await ok('PATCH', `/api/marketplaces/${s.companyId}/wb/warehouses/12`, ff.token, { ours: false });
    const t2 = await duringSync(() => api('POST', `/api/marketplaces/${s.companyId}/wb/warehouses/refresh`, ff.token));
    v.expect('«Обновить из WB» во время обмена отвечает списком складов (200)', t2.act.status === 200, '200',
      `${t2.act.status} ${JSON.stringify(t2.act.body).slice(0, 160)}`);
  } finally {
    wb.warehouses = fetchWarehouses;
    v.done();
    await stop();
  }
})().catch(fail);
