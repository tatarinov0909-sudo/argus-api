// Большой объём для замеров скорости — одним SQL (generate_series), без API.
// Склад №1 — тот, что зарегистрирован через API (его владелец и ключи —
// настоящие); остальные склады, владельцы и все данные — синтетика.
//
// На склад: sellers продавцов; у продавца products товаров и orders заказов WB
// (70% уехали поставками, 15% закрыты WB без работы склада, 5% отменены,
// 5% новые, 5% собраны в поставке, ждут машину). У продавца №1 склада №1 —
// bigProducts товаров и bigOrders заказов (крупный продавец).
// Только для баз argus_seller_test_*.
async function seed(c, ff1, { warehouses = 10, sellers = 50, products = 300, orders = 3000,
  bigProducts = 12000, bigOrders = 20000 } = {}) {
  const db = (await c.query('SELECT current_database() AS d')).rows[0].d;
  if (!/^argus_seller_test_/.test(db)) throw Error('Только тестовая база argus_seller_test_*');
  const t0 = Date.now();
  if (!/^[0-9a-f-]{36}$/.test(ff1)) throw Error('Неверный id склада');
  const [W, S, P, O, BP, BO] = [warehouses, sellers, products, orders, bigProducts, bigOrders].map((x) => Number.parseInt(x, 10));
  const step = async (label, sql, params = []) => {
    const t = Date.now();
    const r = await c.query(sql, params);
    console.log(`  наполнение: ${label} — ${r.rowCount ?? ''} (${((Date.now() - t) / 1000).toFixed(1)} с)`);
  };
  await c.query('SET synchronous_commit = off');
  await step('склады', `
    CREATE TEMP TABLE tmp_wh AS SELECT '${ff1}'::uuid AS wid, 1 AS wn;
    WITH o AS (INSERT INTO owners (name, email, password_hash)
               SELECT 'Perf ' || g, 'perf-' || g || '-' || md5(random()::text) || '@example.test', 'x'
                 FROM generate_series(2, ${W}) g RETURNING id, name),
         w AS (INSERT INTO warehouses (owner_id, name, city, warehouse_code, stock_source, timezone)
               SELECT o.id, 'ФФ Perf ' || substr(o.name, 6), 'Москва', 'P' || substr(md5(random()::text), 1, 8), '1c', 'Europe/Moscow'
                 FROM o RETURNING id, name)
    INSERT INTO tmp_wh SELECT id, substr(name, 9)::int FROM w`);
  await step('продавцы', `
    CREATE TEMP TABLE tmp_co (cid uuid, wid uuid, wn int, cn int, np int, nord int);
    WITH c AS (INSERT INTO companies (warehouse_id, name)
               SELECT wid, 'Продавец ' || wn || '-' || g FROM tmp_wh, generate_series(1, ${S}) g
               RETURNING id, warehouse_id, name)
    INSERT INTO tmp_co SELECT c.id, c.warehouse_id, split_part(substr(c.name, 10), '-', 1)::int,
                              split_part(substr(c.name, 10), '-', 2)::int, 0, 0 FROM c;
    UPDATE tmp_co SET np = CASE WHEN wn = 1 AND cn = 1 THEN ${BP} ELSE ${P} END,
                      nord = CASE WHEN wn = 1 AND cn = 1 THEN ${BO} ELSE ${O} END`);
  await step('товары', `
    INSERT INTO products (warehouse_id, company_id, sku, name, barcode, stock_qty_1c, stock_at, external_id)
    SELECT wid, cid, 'PB' || lpad(p::text, 6, '0'), 'Товар ' || p || ' продавца ' || cn,
           (2000000000000 + cn * 100000 + p)::text, 50 + p % 50, now() - interval '1 hour', 'ext-' || cn || '-' || p
      FROM tmp_co, generate_series(1, np) p`);
  await step('связи с WB', `
    INSERT INTO product_marketplace_skus (warehouse_id, company_id, sku, marketplace, mp_sku, mp_article, mp_barcode)
    SELECT wid, cid, 'PB' || lpad(p::text, 6, '0'), 'wb', (100000 + p)::text, 'ART-' || p, (2000000000000 + cn * 100000 + p)::text
      FROM tmp_co, generate_series(1, np) p`);
  await step('ячейки', `
    CREATE TEMP TABLE tmp_cell (bid uuid, wid uuid, k int);
    WITH r AS (INSERT INTO warehouse_rows (warehouse_id, row_num, rack_count, tier_count)
               SELECT wid, 1, 100, 2 FROM tmp_wh RETURNING id, warehouse_id),
         b AS (INSERT INTO cell_blocks (warehouse_row_id, warehouse_id, rack_start, rack_end, tier_start, tier_end)
               SELECT r.id, r.warehouse_id, g, g, t, t FROM r, generate_series(1, 100) g, generate_series(1, 2) t
               RETURNING id, warehouse_id, rack_start, tier_start)
    INSERT INTO tmp_cell SELECT id, warehouse_id, (rack_start - 1) * 2 + tier_start FROM b;
    CREATE INDEX ON tmp_cell (wid, k)`);
  await step('остатки в ячейках', `
    ALTER TABLE cell_stock DISABLE TRIGGER cell_stock_revision;
    INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty, quality)
    SELECT tc.bid, co.wid, co.cid, 'PB' || lpad(p::text, 6, '0'), 30 + p % 40,
           (CASE WHEN p % 10 = 0 THEN 'defective' ELSE 'good' END)::return_quality
      FROM tmp_co co CROSS JOIN LATERAL generate_series(1, co.np) p
      JOIN tmp_cell tc ON tc.wid = co.wid AND tc.k = 1 + (co.cn * 7 + p) % 200;
    ALTER TABLE cell_stock ENABLE TRIGGER cell_stock_revision`);
  await step('приходы', `
    CREATE TEMP TABLE tmp_in AS SELECT gen_random_uuid() AS iid, gen_random_uuid() AS itid, co.wid, co.cid, co.cn, p
      FROM tmp_co co CROSS JOIN LATERAL generate_series(1, co.np) p;
    INSERT INTO invoices (id, warehouse_id, company_id, number, status, direction, source, created_at)
    SELECT iid, wid, cid, 'IN-' || cn || '-' || p, 'completed', 'in', '1c', now() - interval '60 days' FROM tmp_in;
    INSERT INTO invoice_items (id, invoice_id, warehouse_id, company_id, name, sku, declared_qty)
    SELECT itid, iid, wid, cid, 'Товар ' || p, 'PB' || lpad(p::text, 6, '0'), 100 FROM tmp_in;
    INSERT INTO receiving_records (invoice_item_id, warehouse_id, company_id, accepted_qty, cell_block_id, started_at, finished_at)
    SELECT t.itid, t.wid, t.cid, 100, tc.bid, now() - interval '60 days', now() - interval '60 days'
      FROM tmp_in t JOIN tmp_cell tc ON tc.wid = t.wid AND tc.k = 1 + (t.cn * 7 + t.p) % 200`);
  await step('заказы (подготовка)', `
    CREATE TEMP TABLE tmp_ord AS
    SELECT gen_random_uuid() AS iid, gen_random_uuid() AS itid, co.wid, co.cid, co.cn, g, g % 20 AS kind,
           1 + (g * 7) % co.np AS p, co.nord
      FROM tmp_co co CROSS JOIN LATERAL generate_series(1, co.nord) g;
    CREATE TEMP TABLE tmp_sup AS SELECT gen_random_uuid() AS sid, wid, cid, cn, g / 20 AS sk
      FROM tmp_ord WHERE kind <= 13 GROUP BY wid, cid, cn, g / 20;
    CREATE INDEX ON tmp_sup (cid, sk);
    CREATE TEMP TABLE tmp_sup2 AS SELECT gen_random_uuid() AS sid, wid, cid, cn FROM tmp_co`);
  await step('поставки', `
    INSERT INTO supplies (id, warehouse_id, company_id, number, marketplace, status, created_at, ready_at, shipped_at)
    SELECT sid, wid, cid, 'ПС-' || cn || '-' || sk, 'wb', 'shipped', now() - interval '30 days',
           now() - interval '30 days', now() - interval '29 days' FROM tmp_sup;
    INSERT INTO supplies (id, warehouse_id, company_id, number, marketplace, status, created_at)
    SELECT sid, wid, cid, 'ПС-' || cn || '-c', 'wb', 'collecting', now() FROM tmp_sup2`);
  await step('заказы', `
    INSERT INTO invoices (id, warehouse_id, company_id, number, status, direction, source, external_id, supply_id,
                          created_at, mp_created_at, shipped_at, mp_closed_at, mp_close_reason, mp_warehouse_id,
                          mp_status_attempted_at, mp_supplier_status, mp_status)
    SELECT o.iid, o.wid, o.cid, 'WB-' || o.cn || '-' || o.g,
           (CASE WHEN o.kind <= 13 THEN 'shipped' WHEN o.kind = 19 THEN 'ready' ELSE 'open' END)::invoice_status,
           'out', 'wb', (o.cn * 1000000 + o.g)::text,
           CASE WHEN o.kind <= 13 THEN s.sid WHEN o.kind = 19 THEN s2.sid END,
           now() - ((o.nord - o.g) * interval '3 minutes'), now() - ((o.nord - o.g) * interval '3 minutes'),
           CASE WHEN o.kind <= 13 THEN now() - interval '29 days' END,
           CASE WHEN o.kind BETWEEN 14 AND 17 THEN now() - interval '20 days' END,
           CASE WHEN o.kind BETWEEN 14 AND 16 THEN 'fulfilled' WHEN o.kind = 17 THEN 'canceled' END,
           (500000 + o.cn)::text,
           CASE WHEN o.kind BETWEEN 14 AND 17 THEN now() - interval '20 days' END,
           CASE WHEN o.kind BETWEEN 14 AND 16 THEN 'complete' WHEN o.kind = 17 THEN 'cancel' END,
           CASE WHEN o.kind BETWEEN 14 AND 16 THEN 'sold' WHEN o.kind = 17 THEN 'canceled_by_client' END
      FROM tmp_ord o
      LEFT JOIN tmp_sup s ON o.kind <= 13 AND s.cid = o.cid AND s.sk = o.g / 20
      LEFT JOIN tmp_sup2 s2 ON s2.cid = o.cid`);
  await step('строки заказов', `
    INSERT INTO invoice_items (id, invoice_id, warehouse_id, company_id, name, sku, declared_qty,
                               mp_rid, mp_article, mp_barcode, mp_nm_id, mp_chrt_id)
    SELECT itid, iid, wid, cid, 'Товар ' || p, 'PB' || lpad(p::text, 6, '0'), 1,
           'rid-' || cn || '-' || g, 'ART-' || p, (2000000000000 + cn * 100000 + p)::text, (100000 + p)::text, (700000 + p)::text
      FROM tmp_ord`);
  await step('отборы', `
    INSERT INTO shipping_records (invoice_item_id, warehouse_id, company_id, picked_qty, cell_block_id, is_final, started_at, finished_at)
    SELECT o.itid, o.wid, o.cid, 1, tc.bid, true, now() - interval '29 days', now() - interval '29 days'
      FROM tmp_ord o JOIN tmp_cell tc ON tc.wid = o.wid AND tc.k = 1 + (o.cn * 7 + o.p) % 200
     WHERE o.kind <= 13 OR o.kind = 19`);
  await step('склады WB продавцов', `
    INSERT INTO seller_wb_warehouses (warehouse_id, company_id, mp_warehouse_id, name, office_id, ours, decided_by, decided_at)
    SELECT wid, cid, (500000 + cn)::text, 'Наш склад ' || cn, 1, true, 'perf', now() FROM tmp_co
    UNION ALL
    SELECT wid, cid, (600000 + cn)::text, 'Чужой склад ' || cn, 2, false, 'perf', now() FROM tmp_co;
    UPDATE warehouses SET wb_offices_auto_at = now() WHERE id IN (SELECT wid FROM tmp_wh)`);
  await step('остатки на WB', `
    INSERT INTO wb_stock_levels (warehouse_id, company_id, mp_warehouse_id, chrt_id, amount)
    SELECT wid, cid, (500000 + cn)::text, (700000 + p)::text, p % 30 FROM tmp_co CROSS JOIN LATERAL generate_series(1, np) p`);
  await step('отложенные заказы чужих складов', `
    INSERT INTO wb_foreign_orders (warehouse_id, company_id, external_id, mp_warehouse_id, mp_created_at, wb_order)
    SELECT wid, cid, (cn * 1000000 + 900000 + g)::text, (600000 + cn)::text, now() - g * interval '5 minutes',
           jsonb_build_object('externalId', (cn * 1000000 + 900000 + g)::text, 'warehouseId', (600000 + cn)::text, 'article', 'ART-1')
      FROM tmp_co, generate_series(1, 200) g`);
  await step('ANALYZE', 'ANALYZE');
  console.log(`  наполнение готово за ${((Date.now() - t0) / 1000).toFixed(0)} с`);
}

module.exports = { seed };

// node _perf.js <база> <id склада №1> — наполнить готовую базу.
if (require.main === module) {
  const { Client } = require('pg');
  const [db, ff1] = process.argv.slice(2);
  const c = new Client({ connectionString: `postgres://postgres:argus_local_test@127.0.0.1:5433/${db}` });
  c.connect().then(() => seed(c, ff1)).then(() => c.end()).catch((e) => { console.error(e); process.exit(2); });
}
