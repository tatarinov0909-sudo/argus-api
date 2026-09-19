const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HttpError } = require('../src/middleware/errorHandler');
const wbHandoff = require('../src/supplies/wbHandoff');
const wbWrite = require('../src/marketplaces/wbWrite');

// Поддельный WB с его настоящими правилами: пачка с одним чужим заказом не
// проходит целиком; больше 20 запросов подряд без паузы в 200 мс — 429.
function fakeWb({ bad = new Set(), tooManyOnce = false } = {}) {
  const attached = new Set();
  const calls = [];
  let last = 0;
  let burst = 0;
  let refusedOnce = false;
  return {
    calls,
    attached,
    createSupply: async () => 'WB-GI-1',
    addOrders: async (token, supply, ids) => {
      const now = Date.now();
      burst = now - last < 200 ? burst + 1 : 1;
      last = now;
      calls.push(ids.length);
      if (burst > 20) throw new HttpError(429, 'Wildberries просит сбавить темп');
      if (tooManyOnce && !refusedOnce) { refusedOnce = true; throw new HttpError(429, 'Wildberries просит сбавить темп'); }
      if (ids.some((id) => bad.has(String(id)))) throw new HttpError(502, 'Wildberries ответил с ошибкой 409');
      ids.forEach((id) => attached.add(String(id)));
      return true;
    },
    supplyOrderIds: async () => [...attached],
    orderStickers: async () => [],
    deleteSupply: async () => true,
  };
}

// База не нужна: запросы к ней просто записываются.
const withTx = (fn) => fn({ query: async () => ({ rows: [{}], rowCount: 1 }) });
const orders = (n) => Array.from({ length: n }, (_, i) => ({
  invoiceId: 'inv-' + i, number: 'WB-' + (500 + i), externalId: String(500 + i),
}));
const handOver = (api, list) => wbHandoff.handOver({
  warehouseId: 'w', companyId: 'c', supply: { id: 's', number: 'ПС-1' }, orders: list,
  withTx, api, tokenFor: async () => 'synthetic-test-token',
});

test('один плохой заказ из девяноста не выбивает остальные и не упирается в лимит WB', async () => {
  const api = fakeWb({ bad: new Set(['537']) });
  const result = await handOver(api, orders(90));
  assert.equal(result.confirmed.length, 89);
  assert.deepEqual(result.rejected.map((o) => o.externalId), ['537']);
  assert.ok(api.calls.length <= 16, `запросов к WB: ${api.calls.length}`);
  assert.equal(api.calls[0], 90, 'первая попытка — вся пачка сразу');
});

test('«слишком часто» от WB — подождать и повторить, а не выкидывать заказы', async () => {
  const api = fakeWb({ tooManyOnce: true });
  const result = await handOver(api, orders(5));
  assert.equal(result.confirmed.length, 5);
  assert.equal(result.rejected.length, 0);
});

test('WB пакетный метод: до 100 заказов, в адрес — только числа', async (t) => {
  const previous = global.fetch; t.after(() => { global.fetch = previous; });
  const seen = [];
  global.fetch = async (url, options) => {
    seen.push({ url, options });
    return { ok: true, status: 204, text: async () => '' };
  };
  await wbWrite.addOrders('synthetic-test-token', 'WB-GI-1', ['101', 102]);
  assert.equal(seen[0].url, 'https://marketplace-api.wildberries.ru/api/marketplace/v3/supplies/WB-GI-1/orders');
  assert.equal(seen[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(seen[0].options.body), { orders: [101, 102] });
  await assert.rejects(() => wbWrite.addOrders('synthetic-test-token', 'WB-GI-1', []));
  await assert.rejects(() => wbWrite.addOrders('synthetic-test-token', 'WB-GI-1', Array(101).fill(1)));
  await assert.rejects(() => wbWrite.addOrders('synthetic-test-token', 'WB-GI-1', ['1; DROP']));
  assert.equal(seen.length, 1);
});
