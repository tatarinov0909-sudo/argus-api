// Галочка «наш» на складе WB возвращает в «Заказано» старые заказы, которые
// WB давно закрыл.
//
// У продавца два склада WB: «Ромашка Москва» (наш) и «ФФ Другой» (другой
// фулфилмент). Заказы склада «ФФ Другой» Аргус откладывает в
// wb_foreign_orders и больше о них WB не спрашивает. Другой фулфилмент их
// собрал и отвёз, WB их закрыл. Когда склад отмечают «наш» (продавец переехал,
// менеджер ошибся галочкой), settle возвращает ВСЕ отложенные заказы как новые:
// «Заказано» раздувается, «Доступно» падает до нуля. Обмен закрывает их не
// больше 1000 за проход (раз в 5 минут), возвращает — по 2000.
// Ожидаемо (правило 4): заказы, которые WB уже закрыл, не вычитаются.
const F = require('../attack-stock-0110/_flow');

const N = 1200;
(async () => {
  const c = await F.setup({ source: '1c' });
  const v = F.verdicts('Галочка «наш» и старые заказы другого фулфилмента');
  try {
    const key = 'key-foreign';
    const s = await c.w.seller('Продавец', key, [
      { id: 701, name: 'Ромашка Москва', officeId: 1 }, { id: 702, name: 'ФФ Другой', officeId: 2 }]);
    const sku = `SKU-${key}`;
    await F.push1c(c, [{ sku, qty: 100 }]);
    F.WB.queue[key] = Array.from({ length: N }, (_, k) => F.order(800000 + k, 702));
    await F.syncWb(c, s.companyId);
    const hidden = (await c.w.hidden(s.companyId)).length;
    v.expect(`заказы склада «ФФ Другой» отложены (${N})`, hidden === N, N, hidden);

    // Другой фулфилмент собрал и отвёз: в очереди WB их нет, WB их закрыл.
    F.WB.queue[key] = [];
    for (let k = 0; k < N; k += 1) F.WB.statuses[String(800000 + k)] = { supplierStatus: 'complete', wbStatus: 'sold' };
    const token = await c.w.sellerToken(s.companyId);
    const before = await F.sellerStock(c, token, sku);
    console.log('  до галочки:', F.nums(before.row));

    await c.ok('PATCH', '/api/sellers/wb-warehouses/702', token, { ours: true });
    const after = await F.sellerStock(c, token, sku);
    console.log('  сразу после галочки:', F.nums(after.row));
    v.expect('после галочки «Заказано» 0 (все эти заказы WB уже закрыл)', after.row?.ordered === 0, 0, after.row?.ordered);
    v.expect('после галочки «Доступно» 100', after.row?.available === 100, 100, after.row?.available);

    await F.syncWb(c, s.companyId);
    const synced = await F.sellerStock(c, token, sku);
    console.log('  после одного обмена с WB:', F.nums(synced.row));
    v.expect('после обмена с WB «Заказано» 0', synced.row?.ordered === 0, 0, synced.row?.ordered);
    v.expect('после обмена с WB «Доступно» 100', synced.row?.available === 100, 100, synced.row?.available);
    v.done();
  } catch (e) { F.fail(e); } finally { await c.stop(); }
})();
