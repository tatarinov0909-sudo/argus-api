// «В пути» не уменьшается, когда WB принял поставку.
//
// Заказ собрали, поставка уехала — он «в пути». WB принял посылку (статус
// sold / complete). Ожидаемо: «в пути» 0. Обмен статусов (statuses.reconcile)
// не спрашивает WB об уехавших заказах (status <> 'shipped'), поэтому
// mp_closed_at у них не ставится никогда, и TRANSIT_SQL держит их «в пути»
// вечно: число только растёт.
const F = require('./_flow');

(async () => {
  const c = await F.setup({ source: 'argus' });
  const v = F.verdicts('«В пути» после приёмки WB');
  try {
    const s = await c.w.seller('Продавец', 'key-transit', [{ id: 501, name: 'Ромашка Москва', officeId: 1 }]);
    const sku = 'SKU-key-transit';
    await F.receive(c, s.companyId, sku, 10);
    F.WB.queue['key-transit'] = [F.order(9101, 501), F.order(9102, 501)];
    await F.syncWb(c, s.companyId);
    F.WB.queue['key-transit'] = [];
    const o = await F.orders(c, s.companyId);
    const sup = await F.supply(c, [o['9101'].id, o['9102'].id]);
    await F.pick(c, o['9101'].item_id); await F.pick(c, o['9102'].item_id);
    await F.ship(c, sup);
    const token = await c.w.sellerToken(s.companyId);
    const before = await F.sellerStock(c, token, sku);
    console.log('  после отгрузки:', F.nums(before.row));
    v.expect('сразу после отгрузки «в пути» 2', before.row?.inTransit === 2, 2, before.row?.inTransit);

    // WB принял обе посылки: продано / передано покупателю.
    F.WB.statuses['9101'] = { supplierStatus: 'complete', wbStatus: 'sold' };
    F.WB.statuses['9102'] = { supplierStatus: 'complete', wbStatus: 'sorted' };
    await F.syncWb(c, s.companyId);
    await F.syncWb(c, s.companyId);
    const after = await F.sellerStock(c, token, sku);
    console.log('  после приёмки WB:', F.nums(after.row));
    v.expect('WB принял обе посылки — «в пути» 0', after.row?.inTransit === 0, 0, after.row?.inTransit);
    v.expect('итог «В пути» в шапке — 0', after.summary.inTransit === 0, 0, after.summary.inTransit);
    v.done();
  } catch (e) { F.fail(e); } finally { await c.stop(); }
})();
