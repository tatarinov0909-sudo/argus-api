// Скорость: экран «Товары» (остатки) у продавца и у владельца склада.
//
// GET /api/sellers/stock строит строку каждого товара, и для КАЖДОГО товара
// ищет его связь с WB (штрихкод) в product_marketplace_skus. Индексы этой
// таблицы начинаются с warehouse_id, а запрос ищет по company_id + sku —
// поэтому на каждый товар Postgres читает всю таблицу связей всех складов
// (Seq Scan, видно в EXPLAIN ANALYZE). Время = товаров у продавца × связей во
// всей системе: растёт с каждым новым клиентом.
// Порог владельца: экран с остатками — до 2 секунд на запрос.
//
// Объём: 10 складов × 10 продавцов × 1500 товаров (150 тыс. связей WB), у
// проверяемого продавца — 3000 товаров. Только тестовая база.
const { Client } = require('pg');
const L = require('../attack-0110/_lib');
const { seed } = require('./_perf');

const LIMIT_MS = 2000;
(async () => {
  const app = await L.startApp();
  const v = L.verdicts('Скорость экрана остатков');
  try {
    const w = await L.warehouse(app.ok, 'Восход');
    const c = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
    await c.connect();
    try {
      await seed(c, w.warehouseId, { warehouses: 10, sellers: 10, products: 1500, orders: 30, bigProducts: 3000, bigOrders: 300 });
    } finally { await c.end(); }
    const companyId = (await w.q("SELECT id FROM companies WHERE name = 'Продавец 1-1'"))[0].id;
    const sellerToken = await w.sellerToken(companyId);
    const time = async (label, path, token) => {
      const t = Date.now();
      const r = await app.api('GET', path, token);
      const ms = Date.now() - t;
      const rows = Array.isArray(r.body) ? r.body.length : r.body?.rows?.length;
      v.expect(`${label}: ${ms} мс (строк ${rows}), порог ${LIMIT_MS} мс`, r.status === 200 && ms <= LIMIT_MS,
        `≤ ${LIMIT_MS} мс`, `${ms} мс, ответ ${r.status}`);
    };
    await time('продавец открывает «Товары» (3000 товаров)', '/api/sellers/stock', sellerToken);
    await time('владелец открывает остатки продавца', `/api/sellers/stock?companyId=${companyId}`, w.token);
    await time('владелец смотрит кабинет продавца его глазами', `/api/sellers/stock?companyId=${companyId}&view=seller`, w.token);
    v.done();
  } catch (e) { L.fail(e); } finally { await app.stop(); }
})();
