// Находка: заказ физлицу со склада продавца, а склад потом убрали. Товар
// склада перешёл в «Остальной товар» (так задумано при удалении склада), а
// заказ по-прежнему привязан к убранному складу: поставку из него составить
// нельзя («Склад не найден — возможно, его убрали»), а в «Заказах» он висит
// «Нет на складе», хотя товар лежит на тех же полках.
//
// Ожидание: при удалении склада его заказы и поставки переходят на
// «Остальной товар» (vwarehouses/service.js, archive — так сделано для строк
// заказов и поставок), заказ физлицу собирается как обычно.
const { startApp, verdicts, fail, setup, to } = require('./_lib');

(async () => {
  const { ok, api, stop } = await startApp();
  const v = verdicts('Заказ физлицу с убранного склада продавца');
  try {
    const w = await setup(ok, { skus: ['A-1'] });
    const ozon = await ok('POST', '/api/vwarehouses', w.token, { companyId: w.companyId, name: 'Озон', marketplace: 'ozon' });
    await w.put(w.cells[0], 'A-1', 5, ozon.id);
    // Продавец заказывает со своего склада «Озон».
    const order = await ok('POST', '/api/direct-orders', w.seller, { ...to, vwId: ozon.id, items: [{ sku: 'A-1', qty: 2 }] });
    const before = (await ok('GET', `/api/supplies/pending/${w.companyId}`, w.token)).find((o) => o.id === order.id);
    v.expect('до удаления склада: заказ готов к поставке, товара хватает',
      before && before.ready && before.stockLevel === 'ok', 'ready, ok', JSON.stringify(before && { ready: before.ready, stockLevel: before.stockLevel }));

    // Склад убирает склад продавца «Озон» — товар остаётся на полках в «Остальном товаре».
    await ok('DELETE', `/api/vwarehouses/${ozon.id}?companyId=${w.companyId}`, w.token);
    const pending = (await ok('GET', `/api/supplies/pending/${w.companyId}`, w.token)).find((o) => o.id === order.id);
    const stock = await w.stock();
    v.expect('после удаления: товар продавца на месте (всего 5, в заказах 2)',
      stock['A-1'].total === 5, 'всего 5', JSON.stringify(stock['A-1']));
    v.expect('после удаления: заказ в «Заказах» не помечен «Нет на складе» (товар лежит на тех же полках)',
      pending && pending.stockLevel !== 'none', 'stockLevel ok', JSON.stringify(pending && { stockLevel: pending.stockLevel, vw: pending.direct }));

    const supply = await api('POST', '/api/supplies', w.token, { invoiceIds: [order.id] });
    v.expect('после удаления: из заказа составляется поставка',
      supply.status === 201, '201', `${supply.status} ${JSON.stringify(supply.body)}`);
  } catch (e) { fail(e); } finally { v.done(); await stop(); }
})();
