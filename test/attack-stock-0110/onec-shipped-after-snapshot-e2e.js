// Учёт в 1С: заказ уехал после того, как пришло число из 1С.
//
// 1С прислала «всего 10». Пришло 2 заказа, их собрали — доступно 8 (верно).
// Поставка уехала. Число 1С по-прежнему 10: оно посчитано ДО отгрузки и эти
// 2 штуки ещё содержит (новой выгрузки из 1С не было). Аргус же перестаёт
// вычитать уехавшие заказы сразу — «доступно» прыгает до 10, хотя на складе 8.
// Владелец: «Аргус должен правильно вычитать заказы из того числа, которое
// ему дала 1С». Ожидаемо: пока число 1С старше отгрузки, уехавшее вычитается.
const F = require('./_flow');

(async () => {
  const c = await F.setup({ source: '1c' });
  const v = F.verdicts('Учёт 1С и отгрузка после выгрузки 1С');
  try {
    const s = await c.w.seller('Продавец', 'key-1c', [{ id: 601, name: 'Ромашка Москва', officeId: 1 }]);
    const sku = 'SKU-key-1c';
    await F.receive(c, s.companyId, sku, 10);
    await F.push1c(c, [{ sku, qty: 10 }]);
    F.WB.queue['key-1c'] = [F.order(9201, 601), F.order(9202, 601)];
    await F.syncWb(c, s.companyId);
    F.WB.queue['key-1c'] = [];
    const token = await c.w.sellerToken(s.companyId);
    const o = await F.orders(c, s.companyId);
    const sup = await F.supply(c, [o['9201'].id, o['9202'].id]);
    await F.pick(c, o['9201'].item_id); await F.pick(c, o['9202'].item_id);
    const picked = await F.sellerStock(c, token, sku);
    console.log('  собрано, ждёт машину:', F.nums(picked.row));
    v.expect('до отгрузки: доступно 10 − 2 = 8', picked.row?.available === 8, 8, picked.row?.available);

    await F.ship(c, sup);
    const shipped = await F.sellerStock(c, token, sku);
    console.log('  уехало, 1С ещё не присылала новое число:', F.nums(shipped.row));
    v.expect('после отгрузки, пока 1С не прислала новое число: доступно 8', shipped.row?.available === 8, 8, shipped.row?.available);
    v.expect('итог «Доступно» в шапке — 8', shipped.summary.available === 8, 8, shipped.summary.available);

    // 1С провела реализацию и прислала 8 — дальше всё сходится.
    await F.push1c(c, [{ sku, qty: 8 }]);
    const later = await F.sellerStock(c, token, sku);
    console.log('  1С прислала 8:', F.nums(later.row));
    v.expect('после нового числа из 1С: доступно 8', later.row?.available === 8, 8, later.row?.available);
    v.done();
  } catch (e) { F.fail(e); } finally { await c.stop(); }
})();
