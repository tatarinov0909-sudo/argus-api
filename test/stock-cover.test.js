// Хватит ли товара на полках: сперва собирающимся поставкам (старшим
// первыми), остаток — очереди. Заказ, которому не хватило, помечен.
const test = require('node:test');
const assert = require('node:assert');
const { stockCover } = require('../src/supplies/service');

function fakeClient({ cells, demand }) {
  return { query: async (sql) => ({ rows: sql.includes('FROM cell_stock') ? cells : demand }) };
}

test('полки раздаются поставкам по старшинству, остаток — очереди', async () => {
  const client = fakeClient({
    cells: [{ company_id: 'c', sku: 'A', qty: '4' }],
    demand: [
      { supply_id: 's1', invoice_id: 'i1', company_id: 'c', sku: 'A', need: '3' },
      { supply_id: 's2', invoice_id: 'i2', company_id: 'c', sku: 'A', need: '2' },
      { supply_id: 's2', invoice_id: 'i3', company_id: 'c', sku: 'B', need: '0' },
    ],
  });
  const cover = await stockCover(client, 'w');
  assert.deepEqual([...cover.shortInvoices], ['i2']);
  // Второй поставке не хватило — полка пуста, очереди ничего не осталось.
  assert.equal(cover.take('c|A', 1), false);
  // Полностью собранная строка (need 0) нехватки не создаёт.
  assert.equal(cover.shortInvoices.has('i3'), false);
});

test('очередь получает то, что осталось после поставок', async () => {
  const client = fakeClient({
    cells: [{ company_id: 'c', sku: 'A', qty: '5' }],
    demand: [{ supply_id: 's1', invoice_id: 'i1', company_id: 'c', sku: 'A', need: '3' }],
  });
  const cover = await stockCover(client, 'w');
  assert.equal(cover.take('c|A', 1), true);
  assert.equal(cover.take('c|A', 1), true);
  assert.equal(cover.take('c|A', 1), false);
});
