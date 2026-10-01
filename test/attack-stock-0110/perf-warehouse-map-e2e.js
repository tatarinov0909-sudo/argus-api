// Скорость: карта склада у владельца — GET /api/cells/rows.
//
// Кабинет владельца (и менеджера с правом «склад») запрашивает карту при
// каждом открытии (cabinet_main.js: `if(CAN_WAREHOUSE) apiFetch('/api/cells/rows')`),
// по ней же экран «Товары» показывает «Где лежит». Заполнение ячеек
// (src/cells/fill.js, cellFills) для КАЖДОЙ строки остатка в ячейках ищет
// товар по (склад, артикул), а индекс products — (склад, продавец, артикул):
// без продавца он не сужает поиск, и каждый раз читается весь диапазон
// товаров склада. Время = строк остатка × товаров склада.
// Порог владельца: экран с остатками — до 2 секунд на запрос.
//
// Объём: один склад, 50 продавцов × 300 товаров + продавец с 3000 — 18 тыс.
// товаров и столько же строк остатка в ячейках. Только тестовая база.
const { Client } = require('pg');
const L = require('../attack-0110/_lib');
const { seed } = require('./_perf');

const LIMIT_MS = 2000;
(async () => {
  const app = await L.startApp();
  const v = L.verdicts('Скорость карты склада');
  try {
    const w = await L.warehouse(app.ok, 'Восход');
    const c = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
    await c.connect();
    try {
      await seed(c, w.warehouseId, { warehouses: 1, sellers: 50, products: 300, orders: 10, bigProducts: 3000, bigOrders: 10 });
    } finally { await c.end(); }
    const t = Date.now();
    const r = await app.api('GET', '/api/cells/rows', w.token);
    const ms = Date.now() - t;
    const stock = (r.body || []).flatMap((row) => row.blocks || []).reduce((s, b) => s + (b.stock || []).length, 0);
    v.expect(`владелец открывает карту склада: ${ms} мс (строк остатка ${stock}), порог ${LIMIT_MS} мс`,
      r.status === 200 && ms <= LIMIT_MS, `≤ ${LIMIT_MS} мс`, `${ms} мс, ответ ${r.status}`);
    v.done();
  } catch (e) { L.fail(e); } finally { await app.stop(); }
})();
