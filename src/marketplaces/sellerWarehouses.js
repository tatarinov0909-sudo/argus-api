const wb = require('./wb');
const journal = require('../journal/repository');
const { HttpError } = require('../middleware/errorHandler');

// Склады продавца на WB (владелец 30.09.2026). Всё здесь — только чтение WB.
//
// Продавец заводит на WB «склад продавца» под каждый фулфилмент и город, куда
// тот возит (у Авезова 16 складов, из них 6 — «ФФ Восход …»). WB отдаёт по
// ключу заказы всех складов сразу. Аргус забирает только заказы складов,
// отмеченных «наш»; заказы чужих складов не удаляются, а лежат в
// wb_foreign_orders и возвращаются, если склад отметят нашим.
//
// «Наш» ставит человек (менеджер склада или продавец) или правило: склад
// стоит на пункте приёмки, куда возит фулфилмент (ff_wb_offices), и в его
// названии есть имя фулфилмента. Решение человека правило не трогает.
//
// Пока у продавца ни один склад не отмечен нашим, Аргус забирает заказы со
// всех складов, как раньше, — иначе новый продавец молча остался бы без
// заказов, пока кто-то не расставит галочки.

const HOUR = 60 * 60 * 1000;
const REFRESH_MS = 6 * HOUR;          // список складов меняется редко
const RETRY_UNKNOWN_MS = 15 * 60 * 1000;
const STOCKS_MS = 30 * 60 * 1000;
const STOCKS_DENIED_MS = 6 * HOUR;    // у ключа нет доступа — не долбить WB
const HISTORY_WINDOW_S = 2 * 86400;
const HISTORY_PAGES_PER_TICK = 20;
const BATCH = 2000;

const norm = (s) => ` ${String(s || '').toLowerCase().replace(/ё/g, 'е')
  .replace(/[^a-zа-я0-9]+/g, ' ').trim()} `;

// Правило «наш склад». Одного признака мало: пункт приёмки у многих
// фулфилментов общий (Коледино), а название продавец пишет сам.
function autoOurs(w, { ffName, officeIds }) {
  const name = norm(ffName);
  if (name.trim().length < 3) return false;
  return officeIds.has(String(w.office_id)) && norm(w.name).includes(name);
}

async function ffContext(client, warehouseId) {
  const [wh, offices] = await Promise.all([
    client.query('SELECT name FROM warehouses WHERE id = $1', [warehouseId]),
    client.query('SELECT office_id FROM ff_wb_offices WHERE warehouse_id = $1', [warehouseId]),
  ]);
  return { ffName: wh.rows[0]?.name || '', officeIds: new Set(offices.rows.map((r) => String(r.office_id))) };
}

const companyName = async (client, companyId) => (
  (await client.query('SELECT name FROM companies WHERE id = $1', [companyId])).rows[0]?.name || 'продавца');

const credentialRow = async (client, warehouseId, companyId) => (await client.query(
  `SELECT id, wb_warehouses_at, wb_warehouses_error, wb_history_until, wb_stocks_at, wb_stocks_error
     FROM marketplace_credentials WHERE warehouse_id = $1 AND company_id = $2 AND marketplace = 'wb'`,
  [warehouseId, companyId])).rows[0];

const quoted = (names, max = 6) => names.slice(0, max).map((n) => `«${n}»`).join(', ')
  + (names.length > max ? ` и ещё ${names.length - max}` : '');

// Переоценить правило у складов, которые не решал человек. companyId = null —
// у всех продавцов склада (поменялся список пунктов приёмки).
async function applyAuto(client, warehouseId, companyId = null) {
  const ctx = await ffContext(client, warehouseId);
  const rows = (await client.query(
    `SELECT id, company_id, name, office_id, ours FROM seller_wb_warehouses
      WHERE warehouse_id = $1 AND decided_by IS NULL AND ($2::uuid IS NULL OR company_id = $2)`,
    [warehouseId, companyId])).rows;
  const changed = rows.filter((r) => autoOurs(r, ctx) !== r.ours).map((r) => ({ ...r, ours: !r.ours }));
  for (const r of changed) {
    await client.query('UPDATE seller_wb_warehouses SET ours = $2 WHERE id = $1', [r.id, r.ours]);
  }
  return changed;
}

// Прочитать склады продавца у WB. Раз в 6 часов или сразу, если в заказах
// встретился склад, которого мы не знаем.
async function refresh(client, warehouseId, companyId, token, {
  orders = [], force = false, fetchWarehouses = wb.warehouses, fetchOffices = wb.offices,
} = {}) {
  const cred = await credentialRow(client, warehouseId, companyId);
  if (!cred) return { skipped: true };
  const known = new Set((await client.query(
    'SELECT mp_warehouse_id FROM seller_wb_warehouses WHERE warehouse_id = $1 AND company_id = $2',
    [warehouseId, companyId])).rows.map((r) => r.mp_warehouse_id));
  const unknown = orders.some((o) => o.warehouseId && !known.has(o.warehouseId));
  const age = cred.wb_warehouses_at ? Date.now() - new Date(cred.wb_warehouses_at).getTime() : Infinity;
  if (!force && age < REFRESH_MS && !(unknown && age > RETRY_UNKNOWN_MS)) return { skipped: true };

  let list;
  let offices = [];
  try {
    list = await fetchWarehouses(token);
    // Адрес пункта — для людей, не для правила: без него работаем дальше.
    try { offices = await fetchOffices(token); } catch { offices = []; }
  } catch (err) {
    await client.query(`UPDATE marketplace_credentials SET wb_warehouses_at = now(), wb_warehouses_error = $2
      WHERE id = $1`, [cred.id, err.message]);
    return { error: err.message };
  }
  const byOffice = new Map(offices.map((o) => [String(o.id), o]));
  const rows = list.filter((w) => w.id != null).map((w) => {
    const o = byOffice.get(String(w.officeId));
    return {
      mp_warehouse_id: String(w.id),
      name: String(w.name || '').trim().slice(0, 300) || `Склад WB ${w.id}`,
      office_id: Number.isSafeInteger(Number(w.officeId)) ? Number(w.officeId) : null,
      office_name: o?.name || null, office_city: o?.city || null, office_address: o?.address || null,
      cargo_type: Number.isInteger(w.cargoType) ? w.cargoType : null,
      delivery_type: Number.isInteger(w.deliveryType) ? w.deliveryType : null,
    };
  });
  const saved = await client.query(
    `INSERT INTO seller_wb_warehouses (warehouse_id, company_id, mp_warehouse_id, name, office_id,
       office_name, office_city, office_address, cargo_type, delivery_type)
     SELECT $1, $2, r.mp_warehouse_id, r.name, r.office_id, r.office_name, r.office_city,
            r.office_address, r.cargo_type, r.delivery_type
       FROM jsonb_to_recordset($3::jsonb) AS r(mp_warehouse_id text, name text, office_id bigint,
            office_name text, office_city text, office_address text, cargo_type int, delivery_type int)
     ON CONFLICT (company_id, mp_warehouse_id) DO UPDATE SET
       name = EXCLUDED.name, office_id = EXCLUDED.office_id,
       office_name = COALESCE(EXCLUDED.office_name, seller_wb_warehouses.office_name),
       office_city = COALESCE(EXCLUDED.office_city, seller_wb_warehouses.office_city),
       office_address = COALESCE(EXCLUDED.office_address, seller_wb_warehouses.office_address),
       cargo_type = EXCLUDED.cargo_type, delivery_type = EXCLUDED.delivery_type,
       seen_at = now(), gone_at = NULL
     RETURNING mp_warehouse_id, name, (xmax = 0) AS created`,
    [warehouseId, companyId, JSON.stringify(rows)]);
  await client.query(
    `UPDATE seller_wb_warehouses SET gone_at = COALESCE(gone_at, now())
      WHERE warehouse_id = $1 AND company_id = $2 AND NOT (mp_warehouse_id = ANY($3::text[]))`,
    [warehouseId, companyId, rows.map((r) => r.mp_warehouse_id)]);
  const changed = await applyAuto(client, warehouseId, companyId);
  await client.query(`UPDATE marketplace_credentials SET wb_warehouses_at = now(), wb_warehouses_error = NULL
    WHERE id = $1`, [cred.id]);

  const created = saved.rows.filter((r) => r.created);
  if (created.length || changed.length) {
    const ctx = await ffContext(client, warehouseId);
    const all = (await client.query(
      `SELECT name, office_id, ours FROM seller_wb_warehouses
        WHERE warehouse_id = $1 AND company_id = $2 AND gone_at IS NULL`, [warehouseId, companyId])).rows;
    const atOurs = all.filter((w) => ctx.officeIds.has(String(w.office_id)));
    const ours = all.filter((w) => w.ours).map((w) => w.name);
    const text = `Склады WB «${await companyName(client, companyId)}»: у продавца ${all.length} `
      + `склад(ов) на WB${created.length ? `, новых — ${created.length}` : ''}. `
      + (ctx.officeIds.size
        ? `На ваших пунктах приёмки — ${atOurs.length}, отмечены вашими — ${ours.length}`
          + (ours.length ? `: ${quoted(ours)}.` : '.')
          + (ours.length ? ' Заказы забираются только с них.' : ' Пока ни один не отмечен — заказы забираются со всех складов продавца.')
        : 'Пункты приёмки WB, куда вы возите, ещё не указаны («Площадки» → «Куда вы возите на WB») — '
          + 'пока заказы забираются со всех складов продавца.');
    await journal.createEntry(client, { warehouseId, agent: 'Обмен с WB', actorType: 'system',
      entityType: 'wb_warehouse', entityId: companyId, actionText: text });
  }
  return { count: rows.length, created: created.length, changed: changed.length };
}

async function policy(client, warehouseId, companyId) {
  const rows = (await client.query(
    'SELECT mp_warehouse_id, ours FROM seller_wb_warehouses WHERE warehouse_id = $1 AND company_id = $2',
    [warehouseId, companyId])).rows;
  const ours = new Set(rows.filter((r) => r.ours).map((r) => r.mp_warehouse_id));
  const known = new Set(rows.map((r) => r.mp_warehouse_id));
  const active = ours.size > 0;
  // Склад, которого мы не знаем (WB не отдал список), считаем своим: лучше
  // лишний заказ, который уберётся на следующем обмене, чем потерянный.
  const isForeign = (id) => active && Boolean(id) && known.has(String(id)) && !ours.has(String(id));
  return { active, ours, known, isForeign, foreignIds: [...known].filter((id) => !ours.has(id)) };
}

// Заказы чужих складов из очереди WB — в сторону, не в работу.
async function hideOrders(client, warehouseId, companyId, orders) {
  if (!orders.length) return 0;
  // Заказ, заведённый раньше без склада, узнаёт его здесь — и settle уберёт его.
  await client.query(
    `UPDATE invoices i SET mp_warehouse_id = o->>'warehouseId'
       FROM jsonb_array_elements($3::jsonb) AS o
      WHERE i.warehouse_id = $1 AND i.company_id = $2 AND i.source = 'wb'
        AND i.external_id = o->>'externalId' AND i.mp_warehouse_id IS NULL`,
    [warehouseId, companyId, JSON.stringify(orders)]);
  const r = await client.query(
    `INSERT INTO wb_foreign_orders (warehouse_id, company_id, external_id, mp_warehouse_id, mp_created_at, wb_order)
     SELECT $1, $2, o->>'externalId', o->>'warehouseId', (o->>'createdAt')::timestamptz, o
       FROM jsonb_array_elements($3::jsonb) AS o
     ON CONFLICT (warehouse_id, external_id) DO NOTHING`,
    [warehouseId, companyId, JSON.stringify(orders)]);
  return r.rowCount;
}

// Привести заказы в базе к отметкам складов: заказы чужих складов — из
// работы в wb_foreign_orders, заказы складов, ставших нашими, — обратно.
// Трогаем только заказы без работы склада: в поставке, с отбором, этикеткой,
// комментарием или документом заказ остаётся, как бы ни стояла галочка.
async function settle(client, warehouseId, companyId, { importOrders }) {
  const p = await policy(client, warehouseId, companyId);
  let hidden = 0;
  if (p.active && p.foreignIds.length) {
    const r = await client.query(
      `WITH victims AS (
         SELECT i.id, i.external_id, i.mp_warehouse_id, i.mp_created_at,
                jsonb_build_object(
                  'externalId', i.external_id, 'article', ii.mp_article, 'nmId', ii.mp_nm_id,
                  'barcodes', CASE WHEN ii.mp_barcode IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(ii.mp_barcode) END,
                  'rid', ii.mp_rid, 'createdAt', i.mp_created_at, 'offices', to_jsonb(COALESCE(i.mp_offices, '{}'::text[])),
                  'salePriceKopecks', i.mp_sale_price_kopecks, 'warehouseId', i.mp_warehouse_id,
                  'chrtId', ii.mp_chrt_id) AS wb_order
           FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
          WHERE i.warehouse_id = $1 AND i.company_id = $2 AND i.source = 'wb' AND i.direction = 'out'
            AND i.mp_warehouse_id = ANY($3::text[])
            AND i.supply_id IS NULL AND i.status <> 'shipped'
            AND (SELECT count(*) FROM invoice_items x WHERE x.invoice_id = i.id) = 1
            AND NOT EXISTS (SELECT 1 FROM shipping_records sr WHERE sr.invoice_item_id = ii.id)
            AND NOT EXISTS (SELECT 1 FROM return_records rr WHERE rr.invoice_item_id = ii.id)
            AND NOT EXISTS (SELECT 1 FROM marketplace_order_stickers s WHERE s.invoice_id = i.id)
            AND NOT EXISTS (SELECT 1 FROM invoice_comments c WHERE c.invoice_id = i.id)
            AND NOT EXISTS (SELECT 1 FROM invoice_documents d WHERE d.invoice_id = i.id)
            AND NOT EXISTS (SELECT 1 FROM work_sessions w WHERE w.invoice_id = i.id)
          LIMIT ${BATCH}
       ), saved AS (
         INSERT INTO wb_foreign_orders (warehouse_id, company_id, external_id, mp_warehouse_id, mp_created_at, wb_order)
         SELECT $1, $2, external_id, mp_warehouse_id, mp_created_at, wb_order FROM victims
         ON CONFLICT (warehouse_id, external_id) DO NOTHING
       )
       DELETE FROM invoices WHERE id IN (SELECT id FROM victims)`,
      [warehouseId, companyId, p.foreignIds]);
    hidden = r.rowCount;
  }
  const back = (await client.query(
    `SELECT id, wb_order FROM wb_foreign_orders
      WHERE warehouse_id = $1 AND company_id = $2 AND ($3::boolean OR NOT (mp_warehouse_id = ANY($4::text[])))
      ORDER BY mp_created_at NULLS LAST LIMIT ${BATCH}`,
    [warehouseId, companyId, !p.active, p.foreignIds])).rows;
  if (back.length) {
    await importOrders(client, warehouseId, { companyId, orders: back.map((r) => r.wb_order) });
    await client.query('DELETE FROM wb_foreign_orders WHERE id = ANY($1::uuid[])', [back.map((r) => r.id)]);
  }
  if (hidden || back.length) {
    const name = await companyName(client, companyId);
    await journal.createEntry(client, { warehouseId, agent: 'Обмен с WB', actorType: 'system',
      entityType: 'wb_warehouse', entityId: companyId,
      actionText: `Склады WB «${name}»: `
        + (hidden ? `${hidden} заказ(ов) со складов, не отмеченных вашими, убраны из работы — их собирает другой фулфилмент. `
          + 'Заказы не удалены: отметите склад вашим — вернутся. ' : '')
        + (back.length ? `${back.length} заказ(ов) вернулись в работу: их склад теперь отмечен вашим`
          + (p.active ? '.' : ' (или ни один склад продавца не отмечен).') : '') });
  }
  return { hidden, restored: back.length };
}

// У заказов, заведённых до 30.09.2026, склад WB не сохранён. Узнаём его из
// истории заказов WB окнами по два дня; докуда дочитали — wb_history_until.
// ponytail: окно, в котором больше HISTORY_PAGES_PER_TICK тысяч заказов, будет
// перечитываться с начала — тогда хранить курсор next между проходами.
async function backfillHistory(client, warehouseId, companyId, token, { fetchHistory = wb.ordersHistory } = {}) {
  const cred = await credentialRow(client, warehouseId, companyId);
  if (!cred) return { skipped: true };
  let pages = 0;
  let filled = 0;
  let until = cred.wb_history_until;
  for (;;) {
    const start = (await client.query(
      `SELECT min(mp_created_at) AS start FROM invoices
        WHERE warehouse_id = $1 AND company_id = $2 AND source = 'wb' AND mp_warehouse_id IS NULL
          AND mp_created_at > now() - interval '89 days'
          AND ($3::timestamptz IS NULL OR mp_created_at >= $3)`,
      [warehouseId, companyId, until])).rows[0].start;
    if (!start) return { filled, done: true };
    const from = Math.floor(new Date(start).getTime() / 1000) - 60;
    const to = Math.min(from + HISTORY_WINDOW_S, Math.floor(Date.now() / 1000));
    let next = 0;
    let complete = false;
    while (pages < HISTORY_PAGES_PER_TICK) {
      let page;
      try { page = await fetchHistory(token, { dateFrom: from, dateTo: to, next }); }
      catch (err) { return { filled, error: err.message }; }
      pages += 1;
      const rows = page.orders.filter((o) => o.externalId && o.warehouseId)
        .map((o) => ({ id: o.externalId, wh: o.warehouseId, chrt: o.chrtId }));
      if (rows.length) {
        const u = await client.query(
          `UPDATE invoices i SET mp_warehouse_id = r.wh
             FROM jsonb_to_recordset($3::jsonb) AS r(id text, wh text, chrt text)
            WHERE i.warehouse_id = $1 AND i.company_id = $2 AND i.source = 'wb'
              AND i.external_id = r.id AND i.mp_warehouse_id IS NULL`,
          [warehouseId, companyId, JSON.stringify(rows)]);
        filled += u.rowCount;
        await client.query(
          `UPDATE invoice_items ii SET mp_chrt_id = r.chrt
             FROM invoices i, jsonb_to_recordset($3::jsonb) AS r(id text, wh text, chrt text)
            WHERE ii.invoice_id = i.id AND i.warehouse_id = $1 AND i.company_id = $2 AND i.source = 'wb'
              AND i.external_id = r.id AND ii.mp_chrt_id IS NULL AND r.chrt IS NOT NULL`,
          [warehouseId, companyId, JSON.stringify(rows)]);
      }
      if (page.orders.length < 1000 || !page.next || page.next === next) { complete = true; break; }
      next = page.next;
    }
    if (!complete) return { filled, pages };
    until = new Date(to * 1000);
    await client.query('UPDATE marketplace_credentials SET wb_history_until = $2 WHERE id = $1', [cred.id, until]);
    if (to >= Math.floor(Date.now() / 1000) - 60) return { filled, done: true };
  }
}

// Сколько продавец выставил на WB по нашим складам — раз в полчаса, в общий
// кэш: открытие кабинета в WB не ходит. Размеры (chrtId) — из заказов: у
// товара, который ни разу не заказывали, размера мы не знаем.
async function refreshStocks(client, warehouseId, companyId, token, { fetchStocks = wb.stocks, force = false } = {}) {
  const cred = await credentialRow(client, warehouseId, companyId);
  if (!cred) return { skipped: true };
  const age = cred.wb_stocks_at ? Date.now() - new Date(cred.wb_stocks_at).getTime() : Infinity;
  if (!force && age < (cred.wb_stocks_error ? STOCKS_DENIED_MS : STOCKS_MS)) return { skipped: true };
  const whs = (await client.query(
    `SELECT mp_warehouse_id FROM seller_wb_warehouses
      WHERE warehouse_id = $1 AND company_id = $2 AND ours AND gone_at IS NULL AND mp_warehouse_id ~ '^[0-9]+$'`,
    [warehouseId, companyId])).rows.map((r) => r.mp_warehouse_id);
  const chrts = (await client.query(
    `SELECT DISTINCT ii.mp_chrt_id FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
      WHERE ii.warehouse_id = $1 AND ii.company_id = $2 AND i.source = 'wb' AND ii.mp_chrt_id ~ '^[0-9]{1,15}$'`,
    [warehouseId, companyId])).rows.map((r) => r.mp_chrt_id);
  const levels = [];
  try {
    for (const w of whs) {
      for (let k = 0; k < chrts.length; k += 1000) {
        const part = chrts.slice(k, k + 1000);
        const got = new Map((await fetchStocks(token, w, part)).map((s) => [s.chrtId, s.amount]));
        // Кого WB не вернул — того на складе ноль.
        for (const c of part) levels.push({ wh: w, chrt: c, amount: got.get(c) ?? 0 });
      }
    }
  } catch (err) {
    await client.query('UPDATE marketplace_credentials SET wb_stocks_at = now(), wb_stocks_error = $2 WHERE id = $1',
      [cred.id, err.message]);
    return { error: err.message };
  }
  await client.query('DELETE FROM wb_stock_levels WHERE warehouse_id = $1 AND company_id = $2', [warehouseId, companyId]);
  if (levels.length) {
    await client.query(
      `INSERT INTO wb_stock_levels (warehouse_id, company_id, mp_warehouse_id, chrt_id, amount)
       SELECT $1, $2, r.wh, r.chrt, r.amount FROM jsonb_to_recordset($3::jsonb) AS r(wh text, chrt text, amount int)`,
      [warehouseId, companyId, JSON.stringify(levels)]);
  }
  await client.query('UPDATE marketplace_credentials SET wb_stocks_at = now(), wb_stocks_error = NULL WHERE id = $1', [cred.id]);
  return { warehouses: whs.length, sizes: chrts.length };
}

// Склады продавца для экрана: те, что на наших пунктах приёмки или отмечены
// нашими. Склады у других фулфилментов — только числом, без названий.
async function list(client, warehouseId, companyId) {
  const ctx = await ffContext(client, warehouseId);
  const rows = (await client.query(
    `SELECT w.*,
            (SELECT count(*)::int FROM invoices i WHERE i.warehouse_id = w.warehouse_id AND i.company_id = w.company_id
               AND i.source = 'wb' AND i.mp_warehouse_id = w.mp_warehouse_id
               AND i.status <> 'shipped' AND i.mp_closed_at IS NULL) AS open_orders,
            (SELECT count(*)::int FROM wb_foreign_orders f WHERE f.warehouse_id = w.warehouse_id
               AND f.company_id = w.company_id AND f.mp_warehouse_id = w.mp_warehouse_id) AS hidden
       FROM seller_wb_warehouses w
      WHERE w.warehouse_id = $1 AND w.company_id = $2
      -- Порядок не зависит от галочки: иначе строка уезжает из-под пальца.
      ORDER BY w.name, w.mp_warehouse_id`, [warehouseId, companyId])).rows;
  const cred = await credentialRow(client, warehouseId, companyId);
  const unknown = (await client.query(
    `SELECT count(*)::int AS n FROM invoices WHERE warehouse_id = $1 AND company_id = $2 AND source = 'wb'
        AND mp_warehouse_id IS NULL AND status <> 'shipped' AND mp_closed_at IS NULL`,
    [warehouseId, companyId])).rows[0].n;
  // Когда остатки прочитаны — по самим остаткам: отметка у ключа сбрасывается
  // при смене галочки, чтобы перечитать их на ближайшем обмене.
  const stocksAt = (await client.query(
    'SELECT max(fetched_at) AS at FROM wb_stock_levels WHERE warehouse_id = $1 AND company_id = $2',
    [warehouseId, companyId])).rows[0].at;
  const shown = rows.filter((r) => r.ours || ctx.officeIds.has(String(r.office_id)));
  const other = rows.filter((r) => !shown.includes(r));
  return {
    ffName: ctx.ffName,
    officesConfigured: ctx.officeIds.size,
    connected: Boolean(cred),
    active: rows.some((r) => r.ours),
    warehouses: shown.map((r) => ({
      id: r.mp_warehouse_id, name: r.name, ours: r.ours, auto: r.decided_by == null,
      decidedBy: r.decided_by, decidedAt: r.decided_at, gone: Boolean(r.gone_at),
      nameMatches: norm(r.name).includes(norm(ctx.ffName)) && norm(ctx.ffName).trim().length >= 3,
      office: { id: r.office_id == null ? null : String(r.office_id), name: r.office_name, city: r.office_city, address: r.office_address },
      openOrders: r.open_orders, hidden: r.hidden,
    })),
    otherCount: other.length,
    otherHidden: other.reduce((s, r) => s + r.hidden, 0),
    unknownOrders: unknown,
    refreshedAt: cred?.wb_warehouses_at || null,
    error: cred?.wb_warehouses_error || null,
    stocksAt: stocksAt || cred?.wb_stocks_at || null,
    stocksError: cred?.wb_stocks_error || null,
  };
}

// actor — кто решил: { name, type, id } (продавец, менеджер, руководитель).
async function setOurs(client, warehouseId, companyId, mpWarehouseId, ours, actor, { importOrders }) {
  const r = (await client.query(
    `UPDATE seller_wb_warehouses SET ours = $4, decided_by = $5, decided_at = now()
      WHERE warehouse_id = $1 AND company_id = $2 AND mp_warehouse_id = $3 RETURNING name`,
    [warehouseId, companyId, String(mpWarehouseId), ours, actor.name])).rows[0];
  if (!r) throw new HttpError(404, 'Склад WB не найден у этого продавца');
  await journal.createEntry(client, { warehouseId, agent: actor.name, actorType: actor.type, actorId: actor.id,
    entityType: 'wb_warehouse', entityId: companyId,
    actionText: `Склад WB «${r.name}» продавца «${await companyName(client, companyId)}» `
      + (ours ? 'отмечен вашим: заказы с него забираются.' : 'снят с отметки: заказы с него больше не забираются.') });
  // Остатки по складам перечитаются на следующем опросе.
  await client.query(`UPDATE marketplace_credentials SET wb_stocks_at = NULL
    WHERE warehouse_id = $1 AND company_id = $2 AND marketplace = 'wb'`, [warehouseId, companyId]);
  return settle(client, warehouseId, companyId, { importOrders });
}

// Пункты приёмки фулфилмента и подсказки к ним: пункты, к которым привязаны
// склады продавцов этого фулфилмента. Названия складов показываем только
// у тех, в названии которых есть имя фулфилмента, — чужие остаются числом.
async function listOffices(client, warehouseId) {
  const ctx = await ffContext(client, warehouseId);
  const configured = (await client.query(
    'SELECT office_id, name, city, address, added_by, created_at FROM ff_wb_offices WHERE warehouse_id = $1 ORDER BY city, name',
    [warehouseId])).rows;
  const seen = (await client.query(
    `SELECT w.office_id, max(w.office_name) AS name, max(w.office_city) AS city, max(w.office_address) AS address,
            count(DISTINCT w.company_id)::int AS sellers, count(*)::int AS warehouses,
            array_agg(w.name ORDER BY w.name) AS names
       FROM seller_wb_warehouses w
      WHERE w.warehouse_id = $1 AND w.office_id IS NOT NULL AND w.gone_at IS NULL
      GROUP BY w.office_id`, [warehouseId])).rows;
  const ff = norm(ctx.ffName);
  const matching = (names) => (ff.trim().length >= 3 ? names.filter((n) => norm(n).includes(ff)) : []);
  const offices = new Map();
  for (const s of seen) {
    offices.set(String(s.office_id), { id: String(s.office_id), name: s.name, city: s.city, address: s.address,
      sellers: s.sellers, warehouses: s.warehouses, ourNames: matching(s.names), configured: false });
  }
  for (const c of configured) {
    const o = offices.get(String(c.office_id)) || { id: String(c.office_id), sellers: 0, warehouses: 0, ourNames: [] };
    offices.set(String(c.office_id), { ...o, name: o.name || c.name, city: o.city || c.city, address: o.address || c.address,
      configured: true, addedBy: c.added_by, addedAt: c.created_at });
  }
  const order = (o) => (o.configured ? 0 : o.ourNames.length ? 1 : 2);
  // Сводка по продавцам — для их карточек на экране «Площадки», одним запросом.
  const sellers = (await client.query(
    `SELECT w.company_id, count(*) FILTER (WHERE w.gone_at IS NULL)::int AS total,
            count(*) FILTER (WHERE w.ours)::int AS ours,
            (SELECT count(*)::int FROM wb_foreign_orders f WHERE f.warehouse_id = $1 AND f.company_id = w.company_id) AS hidden
       FROM seller_wb_warehouses w WHERE w.warehouse_id = $1 GROUP BY w.company_id`, [warehouseId])).rows;
  return {
    ffName: ctx.ffName,
    offices: [...offices.values()].sort((a, b) => order(a) - order(b)
      || String(a.city || '').localeCompare(String(b.city || ''), 'ru')),
    sellers: sellers.map((s) => ({ companyId: s.company_id, total: s.total, ours: s.ours, hidden: s.hidden })),
  };
}

async function afterRuleChange(client, warehouseId, importOrders) {
  const changed = await applyAuto(client, warehouseId, null);
  const results = [];
  for (const companyId of new Set(changed.map((c) => c.company_id))) {
    results.push(await settle(client, warehouseId, companyId, { importOrders }));
  }
  return { changed: changed.length, hidden: results.reduce((s, r) => s + r.hidden, 0),
    restored: results.reduce((s, r) => s + r.restored, 0) };
}

async function setOffice(client, warehouseId, officeId, on, actor, { importOrders }) {
  const id = String(officeId || '');
  if (!/^\d{1,15}$/.test(id)) throw new HttpError(400, 'Неверный пункт приёмки WB');
  if (on) {
    const o = (await client.query(
      `SELECT max(office_name) AS name, max(office_city) AS city, max(office_address) AS address
         FROM seller_wb_warehouses WHERE warehouse_id = $1 AND office_id = $2 HAVING count(*) > 0`,
      [warehouseId, id])).rows[0];
    if (!o) throw new HttpError(404, 'Этого пункта приёмки нет ни у одного вашего продавца');
    await client.query(
      `INSERT INTO ff_wb_offices (warehouse_id, office_id, name, city, address, added_by)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (warehouse_id, office_id) DO NOTHING`,
      [warehouseId, id, o.name, o.city, o.address, actor.name]);
  } else {
    await client.query('DELETE FROM ff_wb_offices WHERE warehouse_id = $1 AND office_id = $2', [warehouseId, id]);
  }
  const office = (await client.query(
    `SELECT max(office_city) AS city, max(office_address) AS address FROM seller_wb_warehouses
      WHERE warehouse_id = $1 AND office_id = $2`, [warehouseId, id])).rows[0] || {};
  await journal.createEntry(client, { warehouseId, agent: actor.name, actorType: actor.type, actorId: actor.id,
    entityType: 'wb_warehouse',
    actionText: `Пункт приёмки WB ${[office.city, office.address].filter(Boolean).join(', ') || id} `
      + (on ? 'добавлен в «Куда вы возите на WB».' : 'убран из «Куда вы возите на WB».') });
  return afterRuleChange(client, warehouseId, importOrders);
}

module.exports = {
  autoOurs, norm, applyAuto, refresh, policy, hideOrders, settle, backfillHistory, refreshStocks,
  list, setOurs, listOffices, setOffice,
};
