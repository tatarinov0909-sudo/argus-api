// Сверка счёта (должна ПРОХОДИТЬ): то, что проверено и в порядке.
// Учёт в Аргусе (ячейки). Два продавца с одинаковым артикулом, повторный
// обмен с WB, заказы чужого склада WB, поставка, «убрать из поставки»,
// «разобрать поставку», отмена неотобранного заказа в поставке, отгрузка;
// у продавца и у владельца («его глазами») числа одинаковые.
const F = require('./_flow');

(async () => {
  const c = await F.setup({ source: 'argus' });
  const v = F.verdicts('Сверка счёта остатков');
  try {
    const k1 = 'key-ok1'; const k2 = 'key-ok2';
    const s1 = await c.w.seller('Продавец 1', k1, [{ id: 901, name: 'Ромашка Москва', officeId: 1 }, { id: 902, name: 'ФФ Другой', officeId: 2 }]);
    const s2 = await c.w.seller('Продавец 2', k2, [{ id: 903, name: 'Ромашка Казань', officeId: 3 }]);
    const sku = `SKU-${k1}`;
    // Один артикул у двух продавцов — разный товар.
    for (const s of [s1, s2]) await c.ok('POST', '/api/products', c.w.token, { sku: 'PB-SAME', name: 'Одинаковый артикул', companyId: s.companyId });
    await F.receive(c, s1.companyId, 'PB-SAME', 10);
    await F.receive(c, s2.companyId, 'PB-SAME', 3);
    await F.receive(c, s1.companyId, sku, 10);
    const t1 = await c.w.sellerToken(s1.companyId); const t2 = await c.w.sellerToken(s2.companyId);
    const same1 = (await F.sellerStock(c, t1, 'PB-SAME')).row; const same2 = (await F.sellerStock(c, t2, 'PB-SAME')).row;
    v.expect('одинаковый артикул: у продавца 1 — 10, у продавца 2 — 3', same1?.total === 10 && same2?.total === 3, '10 и 3', `${same1?.total} и ${same2?.total}`);

    // 4 заказа с нашего склада WB и 2 — со склада другого фулфилмента; обмен дважды.
    F.WB.queue[k1] = [1, 2, 3, 4].map((n) => F.order(9300 + n, 901)).concat([F.order(9391, 902), F.order(9392, 902)]);
    await F.syncWb(c, s1.companyId); await F.syncWb(c, s1.companyId);
    let r = (await F.sellerStock(c, t1, sku)).row;
    v.expect('повторный обмен и чужой склад: заказано 4, доступно 6', r?.ordered === 4 && r?.available === 6, 'заказано 4, доступно 6', F.nums(r));
    const o = await F.orders(c, s1.companyId);
    v.expect('заказы чужого склада в работу не попали', !o['9391'] && !o['9392'], 'нет', Object.keys(o).join(','));

    // Поставка из трёх, один убрали, поставку разобрали.
    const sup1 = await F.supply(c, [o['9301'].id, o['9302'].id, o['9303'].id]);
    r = (await F.sellerStock(c, t1, sku)).row;
    v.expect('в поставке 3: в сборке 3, заказано 1, доступно 6', r?.inAssembly === 3 && r?.ordered === 1 && r?.available === 6, '3 / 1 / 6', F.nums(r));
    await c.ok('POST', `/api/supplies/orders/${o['9303'].id}/remove`, c.w.token, {});
    r = (await F.sellerStock(c, t1, sku)).row;
    v.expect('убрали один из поставки: в сборке 2, заказано 2, доступно 6', r?.inAssembly === 2 && r?.ordered === 2 && r?.available === 6, '2 / 2 / 6', F.nums(r));
    await c.ok('DELETE', `/api/supplies/${sup1}`, c.w.token);
    r = (await F.sellerStock(c, t1, sku)).row;
    v.expect('поставку разобрали: в сборке 0, заказано 4, доступно 6', r?.inAssembly === 0 && r?.ordered === 4 && r?.available === 6, '0 / 4 / 6', F.nums(r));

    // Новая поставка: один отобрали, второй (не отобранный) WB отменил.
    const sup2 = await F.supply(c, [o['9301'].id, o['9302'].id]);
    await F.pick(c, o['9301'].item_id);
    F.WB.statuses['9302'] = { supplierStatus: 'cancel', wbStatus: 'canceled_by_client' };
    await F.syncWb(c, s1.companyId);
    r = (await F.sellerStock(c, t1, sku)).row;
    v.expect('отмена неотобранного: всего 10 (9 в ячейке + 1 собран), в сборке 1, заказано 2, доступно 7',
      r?.total === 10 && r?.inAssembly === 1 && r?.ordered === 2 && r?.available === 7, '10 / 1 / 2 / 7', F.nums(r));
    await F.ship(c, sup2);
    const both = await F.sellerStock(c, t1, sku);
    r = both.row;
    v.expect('уехало: всего 9, в сборке 0, заказано 2, в пути 1, доступно 7',
      r?.total === 9 && r?.inAssembly === 0 && r?.ordered === 2 && r?.inTransit === 1 && r?.available === 7, '9 / 0 / 2 / 1 / 7', F.nums(r));
    const owner = await c.ok('GET', `/api/sellers/stock?companyId=${s1.companyId}&view=seller`, c.w.token);
    v.expect('владелец «его глазами» видит те же итоги', JSON.stringify(owner.summary) === JSON.stringify(both.summary),
      JSON.stringify(both.summary), JSON.stringify(owner.summary));
    const r2 = (await F.sellerStock(c, t2, 'PB-SAME')).row;
    v.expect('заказы продавца 1 не тронули продавца 2', r2?.ordered === 0 && r2?.available === 3, '0 / 3', F.nums(r2));
    // Изоляция: продавец 2 не видит товар продавца 1 даже с чужим companyId.
    const foreign = await c.api('GET', `/api/sellers/stock?companyId=${s1.companyId}`, t2);
    v.expect('продавец 2 с чужим companyId видит только своё', !foreign.body?.rows?.some((x) => x.sku === sku), 'нет строк продавца 1', JSON.stringify(foreign.body?.rows?.map((x) => x.sku)));
    v.done();
  } catch (e) { F.fail(e); } finally { await c.stop(); }
})();
