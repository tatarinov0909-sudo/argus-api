// Находка: поставка физлицу «одним шагом» (POST /api/supplies/direct) с
// неверной датой отгрузки — «Внутренняя ошибка сервера» вместо понятного
// отказа. С 08.10 (c03680d) дата сначала пишется в direct_orders.planned_date
// как есть, а проверяется только потом, в supplies.create. До 08.10 тот же
// запрос получал 400 «Дата отгрузки — в виде ГГГГ-ММ-ДД».
//
// Ожидание (проверка 07.10, Н8, «понятные ответы, без 500»): 400 и
// человеческий текст для любой даты, которой не бывает.
const { startApp, verdicts, fail, setup } = require('./_lib');

(async () => {
  const { api, ok, stop } = await startApp();
  const v = verdicts('Поставка физлицу: дата отгрузки, которой не бывает');
  try {
    const w = await setup(ok, { skus: ['A-1'] });
    await w.put(w.cells[0], 'A-1', 10);
    const body = (shipDate) => ({ companyId: w.companyId, destination: 'Иванов, Казань', items: [{ sku: 'A-1', qty: 1 }], shipDate });
    for (const bad of ['2026-02-30', '31.12.2026', 'завтра', '2026-13-01']) {
      const r = await api('POST', '/api/supplies/direct', w.token, body(bad));
      v.expect(`дата «${bad}» — понятный отказ 400, а не 500`, r.status === 400,
        '400 «Дата отгрузки — в виде ГГГГ-ММ-ДД»', `${r.status} ${JSON.stringify(r.body)}`);
    }
    // Та же дата в «Заказе физлицу» (POST /api/direct-orders) — проверяется до записи.
    const same = await api('POST', '/api/direct-orders', w.token, { companyId: w.companyId, recipient: 'Иванов', address: 'Казань',
      items: [{ sku: 'A-1', qty: 1 }], plannedDate: '2026-02-30' });
    v.expect('для сравнения: «Заказ физлицу» с той же датой — 400', same.status === 400, '400', `${same.status}`);
    const supplies = (await w.q('SELECT count(*)::int AS n FROM supplies WHERE warehouse_id = $1', [w.warehouseId]))[0].n;
    v.expect('ни одной поставки не создано', supplies === 0, '0', String(supplies));
  } catch (e) { fail(e); } finally { v.done(); await stop(); }
})();
