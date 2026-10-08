// Находка: продавец заказывает физлицу со своего склада больше, чем у него
// свободно всего. «Свободно на складе» не знает о заказах «весь мой товар» и
// о заказах WB вне поставки — проверка сервера смотрит только на него.
//
// Ожидание (Отложено.md, «Заказы физлицам…»: «Продавец: «Создать заказ» —
// не больше свободного; на своём складе — свободного этого склада»): заказ
// не делает «Заказано + В сборке» больше, чем «Всего».
const { startApp, verdicts, fail, setup, to } = require('./_lib');

(async () => {
  const { ok, api, stop } = await startApp();
  const v = verdicts('Заказ физлицу со склада продавца сверх общего «Доступно»');
  try {
    const w = await setup(ok, { skus: ['A-1'] });
    // Весь товар продавца — на его складе «Озон»: 10 шт.
    const ozon = await ok('POST', '/api/vwarehouses', w.token, { companyId: w.companyId, name: 'Озон', marketplace: 'ozon' });
    await w.put(w.cells[0], 'A-1', 10, ozon.id);
    const s0 = await w.stock();
    v.expect('до заказов: всего 10, доступно 10, на складе «Озон» свободно 10',
      s0['A-1'].total === 10 && s0['A-1'].available === 10
        && (s0['A-1'].warehouses || []).find((x) => x.id === ozon.id)?.available === 10,
      '10 / 10 / 10', JSON.stringify(s0['A-1']));

    // 1. Продавец: «Весь мой товар» — 6 шт. Свободно остаётся 4.
    const first = await api('POST', '/api/direct-orders', w.seller, { ...to, items: [{ sku: 'A-1', qty: 6 }] });
    const s1 = await w.stock();
    const ozonFree1 = (s1['A-1'].warehouses || []).find((x) => x.id === ozon.id)?.available;
    v.expect('первый заказ «весь мой товар» на 6 шт. принят, «Доступно» стало 4',
      first.status === 201 && s1['A-1'].available === 4, '201, доступно 4', `${first.status}, доступно ${s1['A-1'].available}`);
    v.expect('«Свободно на складе Озон» после заказа на 6 шт. со всего товара — не больше 4 (весь товар лежит на «Озон»)',
      ozonFree1 <= 4, '≤ 4', String(ozonFree1));

    // 2. Тот же продавец: со склада «Озон» — 10 шт.
    const second = await api('POST', '/api/direct-orders', w.seller, { ...to, recipient: 'Петров', vwId: ozon.id, items: [{ sku: 'A-1', qty: 10 }] });
    const s2 = await w.stock();
    v.expect('второй заказ со склада «Озон» на 10 шт. отклонён (свободно всего 4)',
      second.status === 409, '409 «свободно 4 шт.»', `${second.status} ${JSON.stringify(second.body)}`);
    v.expect('после двух заказов продавца обещано не больше, чем есть («Заказано» ≤ «Всего»)',
      s2['A-1'].ordered + s2['A-1'].inAssembly <= s2['A-1'].total,
      'заказано + в сборке ≤ 10', `всего ${s2['A-1'].total}, заказано ${s2['A-1'].ordered}, в сборке ${s2['A-1'].inAssembly}, доступно ${s2['A-1'].available}`);

    // 3. То же через поставку «весь товар продавца», составленную складом:
    //    в сборке 3 шт. ещё не отобраны, а «Озон» по-прежнему «свободно 10».
    const w2 = await setup(ok, { skus: ['B-1'] });
    const ozon2 = await ok('POST', '/api/vwarehouses', w2.token, { companyId: w2.companyId, name: 'Озон', marketplace: 'ozon' });
    await w2.put(w2.cells[0], 'B-1', 10, ozon2.id);
    const made = await ok('POST', '/api/direct-orders', w2.token, { companyId: w2.companyId, ...to, items: [{ sku: 'B-1', qty: 3 }], toSupply: true });
    const t1 = await w2.stock();
    const ozonFree2 = (t1['B-1'].warehouses || []).find((x) => x.id === ozon2.id)?.available;
    const third = await api('POST', '/api/direct-orders', w2.seller, { ...to, vwId: ozon2.id, items: [{ sku: 'B-1', qty: 10 }] });
    v.expect('склад отправил на сборку заказ «весь товар» на 3 шт. (поставка ' + (made.supply && made.supply.number) + ')',
      Boolean(made.supply), 'поставка создана', JSON.stringify(made));
    v.expect('«Свободно на складе Озон» при 3 шт. в сборке «со всего товара» — не больше 7',
      ozonFree2 <= 7, '≤ 7', `${ozonFree2} (всего ${t1['B-1'].total}, в сборке ${t1['B-1'].inAssembly}, доступно ${t1['B-1'].available})`);
    v.expect('продавец не может заказать со склада «Озон» 10 шт., когда 3 из 10 уже в сборке',
      third.status === 409, '409', `${third.status} ${JSON.stringify(third.body)}`);
  } catch (e) { fail(e); } finally { v.done(); await stop(); }
})();
