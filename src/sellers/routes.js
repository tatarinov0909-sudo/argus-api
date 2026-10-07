const express = require('express');
const { requireAuth, requireRole, requireGrant, forgetKey } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { randomPart } = require('../middleware/keys');
const { HttpError } = require('../middleware/errorHandler');
const { transliteratePrefix } = require('../auth/service');
const { tenantContextFromAuth } = require('../auth/tenantContext');
const inbound = require('./inbound');
const defectsService = require('../defects/service');
const billingService = require('../billing/service');

const { loadStock, BUCKET_SQL, summarize, stockBySeller } = require('./stock');
const { readPage, loadHistory } = require('./history');
const { prepareInventoryExport } = require('./export');
const { combineCatalog } = require('./catalog');
const sellerWarehouses = require('../marketplaces/sellerWarehouses');
const wbListing = require('./wbListing');
const sync = require('../marketplaces/sync');
const router = express.Router();

// A seller receives only the quantities needed to run the shop. Accounting
// source, cells and other warehouse internals stay in owner/manager APIs.
function sellerStockView(row) {
  return {
    sku: row.sku,
    name: row.name,
    barcode: row.barcode,
    total: row.total,
    totalKnown: row.totalKnown,
    // «Заказано» — купленное на площадке, чего ещё нет в поставке;
    // «в сборке» — то, что склад уже взял в работу поставкой. Оба числа
    // уменьшают доступное: этот товар обещан покупателям.
    ordered: row.orderedNotInSupply,
    inAssembly: row.inAssembly,
    // Уехало на WB, WB ещё не принял — в «доступно» уже не входит.
    inTransit: row.inTransit,
    transitDeducted: row.transitCounted,
    // Принято сортировочным центром WB за последние 3 дня.
    acceptedByWb: row.acceptedByWb,
    available: row.sellerAvailable,
    // Брак на складе — его товар, решение по нему за продавцом.
    defective: row.defective + row.packagingDefect,
    orderedOrders: row.queuedOrders,
    assemblyOrders: row.assemblyOrders,
    updatedAt: row.totalUpdatedAt,
    // Раскладка по складам продавца — если они заведены (02.10.2026).
    ...(row.byWarehouse ? { warehouses: row.byWarehouse } : {}),
  };
}

function sellerStockResponse(rows) {
  // Итог — одним правилом с владельцем и Кладовщиком (sellers/stock.js).
  return { rows: rows.filter((row) => row.listed).map(sellerStockView), summary: summarize(rows) };
}

// Где склад продавца ведёт учёт остатков (анкета склада). Строку склада
// продавцу по изоляции не видно: узнаём склад компании в контексте
// запроса, а настройку — в контексте этого склада.
async function stockSourceOf(req, companyId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(companyId))) return '1c';
  const company = await withTenantContext(tenantContextFromAuth(req.auth), async (c) => (
    await c.query('SELECT warehouse_id FROM companies WHERE id = $1', [companyId])).rows[0]);
  if (!company) return '1c';
  const wh = await withTenantContext({ warehouseId: company.warehouse_id }, async (c) => (
    await c.query('SELECT stock_source FROM warehouses WHERE id = $1', [company.warehouse_id])).rows[0]);
  return wh?.stock_source === 'argus' ? 'argus' : '1c';
}

async function requireActiveCompany(client, companyId) {
  const company = (await client.query(
    'SELECT id FROM companies WHERE id=$1 AND archived_at IS NULL',
    [companyId],
  )).rows[0];
  if (!company) throw new HttpError(404, 'Компания не найдена');
}

// Поставки на WB с товаром продавца. Видны с той минуты, как менеджер
// составил поставку, а не после отгрузки (решение владельца 24.09.2026): это
// его заказы уезжают, и знать, когда и куда, — его законный интерес. Приходы
// на склад — другое слово и другой раздел («Приходы и документы»).
const SUPPLY_STATUS = { collecting: 'Собирается', ready: 'Собрана, ждёт машину', shipped: 'Уехала' };
// Шаги WB (владелец 05.10.2026): передана в доставку (QR готов) → уехала →
// принята WB, когда WB принял все посылки. Сколько принято — отдельный
// столбец «Приёмка WB» (владелец 06.10.2026).
function supplyStatusName(x) {
  if (x.status === 'shipped' && x.mp_supply_id && x.orders > 0
      && x.orders_accepted + x.orders_canceled >= x.orders && x.orders_accepted > 0) return 'Принята WB';
  if (x.status === 'ready' && x.mp_delivered_at) return 'Передана в доставку · QR готов';
  return SUPPLY_STATUS[x.status] || x.status;
}

router.get('/supplies', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    if (!companyId) throw new HttpError(400, 'Укажите продавца');
    const rows = await withTenantContext(tenantContextFromAuth(req.auth), async (c) => {
      await requireActiveCompany(c, companyId);
      const supplies = (await c.query(
        `SELECT s.id, s.number, s.status, s.created_at, s.ready_at, s.shipped_at, to_char(s.ship_date, 'YYYY-MM-DD') AS ship_date,
                s.destination, s.mp_supply_id, s.mp_barcode, s.mp_barcode_file, s.mp_delivered_at,
                count(DISTINCT i.id)::int AS orders,
                count(DISTINCT i.id) FILTER (WHERE i.status = 'shipped' AND i.mp_closed_at IS NOT NULL
                                               AND i.mp_close_reason = 'fulfilled')::int AS orders_accepted,
                count(DISTINCT i.id) FILTER (WHERE i.status = 'shipped' AND i.mp_close_reason = 'canceled')::int AS orders_canceled,
                count(DISTINCT i.id) FILTER (WHERE i.status = 'shipped' AND i.mp_closed_at IS NULL)::int AS orders_in_transit,
                COALESCE(sum(ii.declared_qty), 0)::int AS units,
                count(DISTINCT i.id) FILTER (WHERE i.status IN ('ready', 'shipped'))::int AS orders_ready,
                bool_or(i.source_document_type = 'direct_supply') AS direct
           FROM supplies s
           JOIN invoices i ON i.supply_id = s.id AND i.company_id = $1
           JOIN invoice_items ii ON ii.invoice_id = i.id
          WHERE s.company_id = $1
          GROUP BY s.id
          ORDER BY s.created_at DESC
          LIMIT 1001`,
        [companyId],
      )).rows;
      const lines = supplies.length ? (await c.query(
        `SELECT i.supply_id, i.number, i.status, ii.sku, ii.name, ii.declared_qty
           FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
          WHERE i.company_id = $1 AND i.supply_id = ANY($2::uuid[])
          ORDER BY i.number`,
        [companyId, supplies.map((x) => x.id)],
      )).rows : [];
      // Список не обрезаем молча: до 1000 поставок, дальше — признак
      // «показана часть», как у заказов и документов (проверка 26.09.2026).
      const more = supplies.length > 1000;
      return { hasMore: more, rows: supplies.slice(0, 1000).map((x) => ({
        id: x.id,
        number: x.number,
        status: x.status,
        statusName: supplyStatusName(x),
        createdAt: x.created_at,
        readyAt: x.ready_at,
        shippedAt: x.shipped_at,
        shipDate: x.ship_date,
        destination: x.destination,
        orders: x.orders,
        ordersReady: x.orders_ready,
        // Приёмка на WB уехавшей поставки: принято сортировочным центром,
        // ещё в пути, отменено покупателем после отгрузки.
        ordersAccepted: x.orders_accepted,
        ordersInTransit: x.orders_in_transit,
        ordersCanceled: x.orders_canceled,
        units: x.units,
        // Номер и QR поставки на WB — их показывают на воротах
        // сортировочного центра. Появляются, когда поставка передана на WB.
        mpSupplyId: x.mp_supply_id,
        // Куда: поставка физлицу или на WB (проверка 07.10, замечание 1).
        marketplace: x.direct ? 'direct' : x.mp_supply_id ? 'wb' : null,
        mpBarcode: x.mp_barcode,
        mpBarcodeFile: x.mp_barcode_file,
        items: lines.filter((l) => l.supply_id === x.id).map((l) => ({
          order: l.number, sku: l.sku, name: l.name, qty: Number(l.declared_qty),
          status: l.status === 'shipped' ? 'уехал' : l.status === 'ready' ? 'собран' : 'собирается',
        })),
      })) };
    });
    res.set('Cache-Control', 'no-store').json(rows);
  } catch (err) { next(err); }
});

// Продавец оформляет привоз товара на склад файлом (решение владельца
// 25.09.2026): без apply — что узнали в файле, с apply — приход «ждёт
// приёмки» у склада. Продавец — только за себя: компанию берём из его входа.
// Запись идёт в контексте склада: приход, позиции и запись журнала — это
// документы склада, а продавцу журнал недоступен по правилам базы.
router.post('/inbound', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : ((req.body || {}).companyId || req.query.companyId);
    if (!companyId) throw new HttpError(400, 'Укажите продавца');
    const { warehouseId } = req.auth;
    const body = req.body || {};
    const out = await withTenantContext({ warehouseId }, async (c) => {
      const company = (await c.query(
        'SELECT id FROM companies WHERE id = $1 AND warehouse_id = $2 AND archived_at IS NULL', [companyId, warehouseId],
      )).rows[0];
      if (!company) throw new HttpError(404, 'Компания не найдена');
      return inbound.run(c, {
        warehouseId, companyId, grid: body.grid, apply: body.apply === true,
        createNew: body.createNew === true, details: body,
        warehouseByRow: body.warehouseByRow && typeof body.warehouseByRow === 'object' && !Array.isArray(body.warehouseByRow)
          ? body.warehouseByRow : null,
        // Замена списка товаров в уже оформленном привозе (до приезда машины).
        replaceId: typeof body.invoiceId === 'string' && /^[0-9a-f-]{36}$/i.test(body.invoiceId) ? body.invoiceId : null,
        actor: req.auth.role === 'seller' ? { type: 'seller', id: req.auth.sellerKeyId || null }
          : { type: req.auth.role, id: req.auth.staffKeyId || req.auth.ownerId || null },
      });
    });
    res.json(out);
  } catch (err) { next(err); }
});

router.get('/catalog', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    if (!companyId) throw new HttpError(400, 'Укажите продавца');
    const rows = await withTenantContext(tenantContextFromAuth(req.auth), async c => {
      const company = (await c.query('SELECT id FROM companies WHERE id=$1 AND archived_at IS NULL', [companyId])).rows[0];
      if (!company) throw new HttpError(404, 'Компания не найдена');
      return (await c.query(`WITH links AS (
        SELECT sku,mp_sku AS nm_id,mp_article AS article,mp_barcode AS barcode FROM product_marketplace_skus WHERE company_id=$1 AND marketplace='wb'
        UNION SELECT sku,mp_nm_id,mp_article,NULL FROM invoice_items WHERE company_id=$1 AND mp_nm_id IS NOT NULL
      ), skus AS (
        SELECT sku FROM products WHERE company_id=$1 AND active=true
        UNION
        SELECT l.sku FROM links l
        WHERE NOT EXISTS (
          SELECT 1 FROM products hidden
          WHERE hidden.company_id=$1 AND hidden.sku=l.sku AND hidden.active=false
        )
      )
      SELECT s.sku,p.category,l.nm_id,l.article,l.barcode,m.photo_url FROM skus s LEFT JOIN products p ON p.sku=s.sku AND p.company_id=$1 AND p.active=true
      LEFT JOIN links l ON l.sku=s.sku
      LEFT JOIN marketplace_product_media m ON m.company_id=$1 AND m.nm_id=l.nm_id
      ORDER BY s.sku,l.nm_id`, [companyId])).rows;
    });
    res.set('Cache-Control', 'no-store').json({ products: combineCatalog(rows) });
  } catch (err) { next(err); }
});

// Склады продавца на WB: какие из них у нашего фулфилмента и сколько он
// выставил на WB по каждому (только чтение WB, кэш обмена — в WB отсюда не
// ходим). Продавец сам отмечает, какие склады наши.
//
// Строки пунктов приёмки и ключей продавцу по изоляции не видны, поэтому,
// убедившись, что компания своя, читаем в контексте её склада — только по
// этой компании.
async function sellerWarehouseOf(req) {
  const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
  if (!companyId) throw new HttpError(400, 'Укажите продавца');
  const company = await withTenantContext(tenantContextFromAuth(req.auth), async (c) => (
    await c.query('SELECT id, name, warehouse_id FROM companies WHERE id=$1 AND archived_at IS NULL', [companyId])).rows[0]);
  if (!company) throw new HttpError(404, 'Компания не найдена');
  return company;
}

router.get('/wb-warehouses', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const company = await sellerWarehouseOf(req);
    const out = await withTenantContext({ warehouseId: company.warehouse_id }, async (c) => {
      const info = await sellerWarehouses.list(c, company.warehouse_id, company.id);
      // Размер WB → наш товар: по заказам, где размер записан; у размера,
      // встречавшегося под разными кодами, — сначала настоящий товар продавца,
      // потом самый частый. Заказы, пришедшие до сопоставления с WB и
      // закрытые на WB, так и записаны артикулом WB; раньше они перевешивали,
      // и у товара «На WB» было пусто (проверка 02.10, находка 7).
      const levels = await wbListing.levels(c, company.warehouse_id, company.id);
      const stock = {};
      for (const l of levels) (stock[l.sku] ||= {})[l.mp_warehouse_id] = l.amount;
      return { ...info, stock };
    });
    res.set('Cache-Control', 'no-store').json(out);
  } catch (err) { next(err); }
});

// «Обновить из WB» из кабинета продавца: прочитать его склады сейчас.
router.post('/wb-warehouses/refresh', requireAuth, requireRole('seller'), async (req, res, next) => {
  try {
    const company = await sellerWarehouseOf(req);
    const out = await withTenantContext({ warehouseId: company.warehouse_id }, async (c) => {
      const token = await require('../marketplaces/credentials').tokenFor(c, company.warehouse_id, company.id, 'wb');
      return sellerWarehouses.refreshNow(c, company.warehouse_id, company.id, token, { importOrders: sync.importOrders });
    });
    res.json(out);
  } catch (err) { next(err); }
});

router.patch('/wb-warehouses/:mpWarehouseId', requireAuth, requireRole('seller'), async (req, res, next) => {
  try {
    if (typeof req.body?.ours !== 'boolean') throw new HttpError(400, 'Передайте ours: true или false');
    const company = await sellerWarehouseOf(req);
    const out = await withTenantContext({ warehouseId: company.warehouse_id }, (c) => sellerWarehouses.setOurs(
      c, company.warehouse_id, company.id, req.params.mpWarehouseId, req.body.ours,
      { name: `Продавец «${company.name}»`, type: 'seller', id: req.auth.sellerKeyId || null },
      { importOrders: sync.importOrders }));
    res.json(out);
  } catch (err) { next(err); }
});

// Explicit owner-only view of source documents, without rebinding them to a seller.
router.get('/profile', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    const profile = await withTenantContext(tenantContextFromAuth(req.auth), async c => {
      const company = (await c.query('SELECT id, name, warehouse_id FROM companies WHERE id=$1 AND archived_at IS NULL', [companyId])).rows[0];
      if (!company) throw new HttpError(404, 'Компания не найдена');
      // Warehouse identity is non-secret. Seller context cannot read warehouse rows.
      return { id: company.id, name: company.name, warehouseId: company.warehouse_id };
    });
    // Название склада — в шапке кабинета продавца («Восход · фулфилмент»).
    // Строку склада продавцу читать нельзя, поэтому берём её в контексте склада.
    const wh = await withTenantContext({ warehouseId: profile.warehouseId },
      (c) => c.query('SELECT name, timezone FROM warehouses WHERE id = $1', [profile.warehouseId]));
    profile.warehouseName = wh.rows[0]?.name || null;
    // Пояс склада: «сегодня» и «вчера» в кабинете продавца — по дню склада.
    profile.timezone = wh.rows[0]?.timezone || 'Europe/Moscow';
    res.set('Cache-Control','no-store').json(profile);
  } catch (err) { next(err); }
});

// Расчёт продавцу за месяц — тот же, что видит склад, и только если склад
// включил показ. Руководитель видит всегда (смотрит глазами продавца, прежде
// чем включить); менеджер — с правом «тариф и деньги».
router.get('/billing', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    if (req.auth.role === 'manager' && !(req.auth.grants || []).includes('billing')) return res.json({ enabled: false });
    const company = await withTenantContext(tenantContextFromAuth(req.auth), async (c) => {
      const r = (await c.query('SELECT id, warehouse_id FROM companies WHERE id=$1 AND archived_at IS NULL', [companyId])).rows[0];
      if (!r) throw new HttpError(404, 'Компания не найдена');
      return r;
    });
    const out = await withTenantContext({ warehouseId: company.warehouse_id }, async (c) => {
      const t = await billingService.tariff(c, company.warehouse_id, company.id);
      if (!t.showSellers && req.auth.role === 'seller') return { enabled: false };
      const r = await billingService.charges(c, company.warehouse_id, { month: req.query.month,
        from: req.query.from, to: req.query.to, companyId: company.id });
      const mine = r.sellers[0] || { lines: [], total: 0 };
      const invoices = await billingService.listInvoices(c, company.warehouse_id,
        { companyId: company.id, cursor: req.query.invoiceCursor });
      return { enabled: true, shownToSeller: t.showSellers, month: r.month, approximate: r.approximate,
        from: r.from, to: r.to, configured: mine.configured, missingTariff: mine.missingTariff,
        storageSince: r.storageSince, lines: mine.lines, total: mine.total, totalCents: mine.totalCents,
        // Кто из склада менял прайс — внутреннее дело склада (проверка 05.10).
        tariff: req.auth.role === 'seller' ? { ...t, history: t.history.map(({ updatedBy, ...h }) => h) } : t,
        schedule: t.schedule, invoices: invoices.items, nextInvoiceCursor: invoices.nextCursor };
    });
    res.set('Cache-Control', 'no-store').json(out);
  } catch (err) { next(err); }
});

// Продавец читает только свои счета; все финансовые изменения — у склада.
router.get('/billing/invoices', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    if (req.auth.role === 'manager' && !(req.auth.grants || []).includes('billing')) throw new HttpError(403, 'Нет права на расчёты');
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    const company = await withTenantContext(tenantContextFromAuth(req.auth), async (c) => {
      const r = (await c.query('SELECT id,warehouse_id FROM companies WHERE id=$1 AND archived_at IS NULL', [companyId])).rows[0];
      if (!r) throw new HttpError(404, 'Продавец не найден');
      return r;
    });
    const out = await withTenantContext({ warehouseId: company.warehouse_id }, async (c) => {
      const t = await billingService.tariff(c, company.warehouse_id, company.id);
      if (!t.showSellers && req.auth.role === 'seller') return { enabled: false, items: [], nextCursor: null };
      return billingService.listInvoices(c, company.warehouse_id,
        { companyId: company.id, limit: req.query.limit || 30, cursor: req.query.cursor });
    });
    res.set('Cache-Control', 'no-store').json(out);
  } catch (err) { next(err); }
});
router.get('/billing/invoices/:id', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    if (req.auth.role === 'manager' && !(req.auth.grants || []).includes('billing')) throw new HttpError(403, 'Нет права на расчёты');
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    const company = await withTenantContext(tenantContextFromAuth(req.auth), async (c) => {
      const r = (await c.query('SELECT id,warehouse_id FROM companies WHERE id=$1 AND archived_at IS NULL', [companyId])).rows[0];
      if (!r) throw new HttpError(404, 'Продавец не найден');
      return r;
    });
    const out = await withTenantContext({ warehouseId: company.warehouse_id }, async (c) => {
      const t = await billingService.tariff(c, company.warehouse_id, company.id);
      if (!t.showSellers && req.auth.role === 'seller') throw new HttpError(404, 'Счёт не найден');
      return billingService.getInvoice(c, company.warehouse_id, req.params.id, company.id);
    });
    res.set('Cache-Control', 'no-store').json(out);
  } catch (err) { next(err); }
});

router.get('/export/1c', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    if (!companyId) throw new HttpError(400,'Укажите продавца');
    // Учёт — там же, где у экрана остатков (анкета склада): иначе у склада,
    // который ведёт учёт в Аргусе, файл не совпадал с экраном (проверка 02.10).
    const source = await stockSourceOf(req, companyId);
    const prepared = await withTenantContext(tenantContextFromAuth(req.auth), async c => {
      // All quantities come from one loadStock SQL statement (one MVCC snapshot).
      const company = (await c.query('SELECT id,name,warehouse_id FROM companies WHERE id=$1 AND archived_at IS NULL',[companyId])).rows[0];
      if (!company) throw new HttpError(404,'Компания не найдена');
      return prepareInventoryExport((await loadStock(c,companyId,{ source })).filter(row => row.listed || row.stockKnown), {
        seller: { id:company.id,name:company.name }, warehouse: { id:company.warehouse_id },
      });
    });
    res.set('Cache-Control','no-store');
    if (req.query.download !== '1') return res.json(prepared.readiness);
    if (!prepared.readiness.ready) return res.status(422).json({ error:'Выгрузка требует проверки данных', ...prepared.readiness });
    res.set('Content-Disposition','attachment; filename="argus-inventory-v1.json"');
    res.json(prepared.snapshot);
  } catch (err) { next(err); }
});

router.get('/companies', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const rows = await withTenantContext({ warehouseId }, async (client) => {
      const result = await client.query(
        `SELECT c.id, c.name, c.created_at, c.external_id AS one_c_external_id,
                ic.name AS one_c_counterparty_name,
                COALESCE(json_agg(json_build_object(
                  'id', sk.id, 'keyCode', sk.key_code, 'active', sk.active, 'issuedAt', sk.issued_at
                ) ORDER BY sk.issued_at) FILTER (WHERE sk.id IS NOT NULL), '[]') AS keys
         FROM companies c
         LEFT JOIN seller_keys sk ON sk.company_id = c.id
         LEFT JOIN integration_counterparties ic
           ON ic.warehouse_id = c.warehouse_id AND ic.external_id = c.external_id
         WHERE c.warehouse_id = $1 AND c.archived_at IS NULL
         GROUP BY c.id, ic.name ORDER BY c.created_at ASC`,
        [warehouseId],
      );
      return result.rows;
    });
    // Ключ продавца — это вход в его кабинет. Видит его только тот, кому
    // владелец доверил клиентов: без этого права менеджер не может ключ
    // выдать, но мог его просто прочитать и войти за продавца.
    const mayReadKeys = req.auth.role === 'owner' || (req.auth.grants || []).includes('clients');
    if (!mayReadKeys) {
      for (const row of rows) {
        row.keys = row.keys.map((k) => ({ ...k, keyCode: `${String(k.keyCode).slice(0, 2)}-••••••-K` }));
      }
    }
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Поиск работает на сервере: в старой 1С справочник может содержать десятки
// тысяч строк, и загружать их все в каждый браузер нет причины.
router.get('/1c-counterparties', requireAuth, requireGrant('clients'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : '';
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 50);
    const rows = await withTenantContext({ warehouseId }, async (client) => (await client.query(
      `SELECT ic.external_id, ic.name, ic.last_seen_at,
              c.id AS mapped_company_id, c.name AS mapped_company_name
         FROM integration_counterparties ic
         LEFT JOIN companies c
           ON c.warehouse_id = ic.warehouse_id AND c.external_id = ic.external_id
        WHERE ic.warehouse_id = $1
          AND ($2 = '' OR ic.name ILIKE '%' || $2 || '%')
        ORDER BY (c.id IS NULL) DESC, ic.name, ic.external_id
        LIMIT $3`,
      [warehouseId, q, limit],
    )).rows);
    res.set('Cache-Control', 'no-store').json({ rows });
  } catch (err) { next(err); }
});

router.put('/companies/:companyId/1c-counterparty', requireAuth, requireGrant('clients'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { companyId } = req.params;
    const externalId = typeof req.body?.externalId === 'string' ? req.body.externalId.trim() : '';
    const company = await withTenantContext({ warehouseId }, async (client) => {
      const found = (await client.query(
        'SELECT id FROM companies WHERE id = $1 AND warehouse_id = $2 AND archived_at IS NULL',
        [companyId, warehouseId],
      )).rows[0];
      if (!found) throw new HttpError(404, 'Компания не найдена');

      if (!externalId) {
        return (await client.query(
          `UPDATE companies SET external_id = NULL WHERE id = $1
           RETURNING id, name, external_id`, [companyId],
        )).rows[0];
      }

      const counterparty = (await client.query(
        `SELECT name FROM integration_counterparties
         WHERE warehouse_id = $1 AND external_id = $2`,
        [warehouseId, externalId],
      )).rows[0];
      if (!counterparty) throw new HttpError(404, 'Контрагент не найден в последней выгрузке 1С');

      const occupied = (await client.query(
        `SELECT id, name FROM companies
         WHERE warehouse_id = $1 AND external_id = $2 AND id <> $3`,
        [warehouseId, externalId, companyId],
      )).rows[0];
      if (occupied) throw new HttpError(409, `Этот контрагент уже связан с компанией «${occupied.name}»`);

      return (await client.query(
        `UPDATE companies SET external_id = $2 WHERE id = $1
         RETURNING id, name, external_id`,
        [companyId, externalId],
      )).rows[0];
    });
    res.json(company);
  } catch (err) { next(err); }
});

// Настоящий остаток продавца — то, что лежит в ячейках прямо сейчас.
//
// До этого кабинет складывал приёмки нарастающим итогом и называл это
// остатком. Пока склад только принимал, цифра почти совпадала; с первой же
// отгрузкой она расходится навсегда и больше никогда не сойдётся. Показывать
// продавцу «сколько всего привезли» под словом «остаток» — врать ему каждый
// день.
//
// Область видимости решает Postgres: контекст продавца выставляет только его
// компанию, и политика на cell_stock пропускает ровно его строки. Никакой
// фильтрации «руками» здесь нет намеренно — на такой фильтрации проект уже
// однажды получил утечку между компаниями.
router.get('/documents', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    if (!companyId) throw new HttpError(400,'Укажите продавца');
    const rows = await withTenantContext(tenantContextFromAuth(req.auth), async c => {
      await requireActiveCompany(c, companyId);
      // Приход рассказывает, как он прошёл (владелец 26.09.2026): когда
      // начали выгружать (первая принятая строка), кто вёз и на чём, сколько
      // принято, кто принимал и когда закончили. Возврат — сколько годного
      // и сколько брака.
      return (await c.query(
        `WITH docs AS (
           SELECT i.id, i.number, i.direction, i.status, i.source, i.created_at, i.source_document_type,
                  i.source_document_date, i.carrier, i.vehicle, i.inbound_comment,
                  i.planned_from, i.planned_to, i.boxes, i.pallets, i.weight_kg,
                  i.arrived_at, i.arrived_boxes, i.arrived_pallets, i.seller_verdict,
                  (SELECT count(*)::int FROM invoice_comments ic WHERE ic.invoice_id = i.id) AS comment_count,
                  (SELECT count(*)::int FROM invoice_documents idc WHERE idc.invoice_id = i.id) AS document_count
             FROM invoices i
            WHERE i.company_id=$1 AND i.direction IN ('in','return')
            ORDER BY i.created_at DESC, i.id LIMIT 1001
         ), items AS (
           SELECT ii.invoice_id, count(*)::int AS item_count, SUM(ii.declared_qty) AS declared_qty
             FROM invoice_items ii JOIN docs d ON d.id=ii.invoice_id
            WHERE ii.company_id=$1 GROUP BY ii.invoice_id
         ), rec AS (
           SELECT ii.invoice_id, SUM(rr.accepted_qty) AS done_qty, MIN(rr.finished_at) AS first_at,
                  MAX(rr.finished_at) AS last_at,
                  -- Принято, но не разложено по ячейкам («своё место»):
                  -- принятое минус все укладки, сколько бы ячеек ни было.
                  SUM(rr.accepted_qty - COALESCE((SELECT SUM(rp.qty) FROM receiving_placements rp
                                                  WHERE rp.receiving_record_id = rr.id), 0)) AS unplaced_qty,
                  array_agg(DISTINCT rr.worker_key_id) FILTER (WHERE rr.worker_key_id IS NOT NULL) AS workers,
                  NULL::numeric AS good_qty, NULL::numeric AS bad_qty
             FROM receiving_records rr JOIN invoice_items ii ON ii.id=rr.invoice_item_id
             JOIN docs d ON d.id=ii.invoice_id
            WHERE rr.company_id=$1 GROUP BY ii.invoice_id
           UNION ALL
           SELECT ii.invoice_id, SUM(rt.qty), MIN(rt.finished_at), MAX(rt.finished_at), NULL::numeric,
                  array_agg(DISTINCT rt.worker_key_id) FILTER (WHERE rt.worker_key_id IS NOT NULL),
                  SUM(rt.qty) FILTER (WHERE rt.quality_bucket='good'),
                  SUM(rt.qty) FILTER (WHERE rt.quality_bucket<>'good')
             FROM return_records rt JOIN invoice_items ii ON ii.id=rt.invoice_item_id
             JOIN docs d ON d.id=ii.invoice_id
            WHERE rt.company_id=$1 GROUP BY ii.invoice_id
         )
         SELECT d.*, COALESCE(it.item_count,0) AS item_count, COALESCE(it.declared_qty,0) AS declared_qty,
                r.done_qty, r.first_at, r.last_at, r.unplaced_qty, r.workers, r.good_qty, r.bad_qty
           FROM docs d LEFT JOIN items it ON it.invoice_id=d.id LEFT JOIN rec r ON r.invoice_id=d.id
          ORDER BY d.created_at DESC, d.id`, [companyId])).rows;
    });
    // Имена работников — в контексте склада: продавцу таблица сотрудников
    // закрыта, а «кто принимал» он видеть вправе.
    const workerIds = [...new Set(rows.flatMap((r) => r.workers || []))];
    const names = new Map();
    if (workerIds.length) {
      const got = await withTenantContext({ warehouseId: req.auth.warehouseId },
        (c) => c.query('SELECT id, name FROM staff_keys WHERE id = ANY($1::uuid[])', [workerIds]));
      got.rows.forEach((w) => names.set(w.id, w.name));
    }
    const list = rows.slice(0, 1000).map((r) => {
      const { workers, ...rest } = r;
      return { ...rest, received_by: (workers || []).map((id) => names.get(id)).filter(Boolean) };
    });
    res.set('Cache-Control','no-store').json({ rows: list, hasMore: rows.length > 1000 });
  } catch (err) { next(err); }
});

// ?sku= — заказы одного товара: список за числами «Заказано», «В сборке»,
// «В пути» в карточке товара (владелец 27.09.2026). bucket — под каким из
// этих чисел стоит строка; правило то же, что у самих чисел (stock.js).
router.get('/orders', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    if (!companyId) throw new HttpError(400, 'Укажите продавца');
    const sku = req.query.sku == null ? null : String(req.query.sku).trim();
    if (sku !== null && (!sku || sku.length > 200)) throw new HttpError(400, 'Некорректный артикул');
    const rows = await withTenantContext(tenantContextFromAuth(req.auth), async client => {
      await requireActiveCompany(client, companyId);
      return (await client.query(
        // Заказ поставки физлицу — «физлицу», а не «1С» (в 1С его нет; проверка 07.10, замечание 1).
        `SELECT i.id, i.number, i.status, CASE WHEN i.source_document_type = 'direct_supply' THEN 'direct' ELSE i.source END AS source,
                i.created_at, i.shipped_at, ${BUCKET_SQL} AS bucket,
                i.mp_supplier_status, i.mp_status, i.mp_status_checked_at, i.mp_closed_at,
                i.mp_close_reason, i.mp_stock_returned_at, (i.supply_id IS NOT NULL) AS in_supply,
                (i.supply_id IS NOT NULL OR EXISTS (SELECT 1 FROM shipping_records sr JOIN invoice_items si ON si.id=sr.invoice_item_id
                        WHERE si.invoice_id=i.id AND sr.company_id=$1 AND si.company_id=$1 AND sr.picked_qty>0))
                  AND i.mp_closed_at IS NOT NULL AND i.mp_stock_returned_at IS NULL AND i.status<>'shipped' AS stock_conflict,
                ii.id AS item_id, ii.name, ii.sku, ii.declared_qty AS qty, ii.mp_rid, ii.mp_nm_id, ii.mp_article,
                ii.mp_barcode, i.mp_created_at,
                -- Поставка заказа — по ней продавец ищет и фильтрует заказы.
                s.number AS supply_number, s.destination AS supply_destination,
                -- Склад продавца на WB, с которого заказ.
                i.mp_warehouse_id, w.name AS mp_warehouse_name
         FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
         LEFT JOIN supplies s ON s.id = i.supply_id AND s.company_id = $1
         LEFT JOIN seller_wb_warehouses w ON w.company_id = $1 AND w.mp_warehouse_id = i.mp_warehouse_id
         WHERE i.company_id = $1 AND ii.company_id = $1 AND i.direction = 'out'
           AND ($2::text IS NULL OR ii.sku = $2)
         ORDER BY (i.status = 'shipped' OR i.mp_closed_at IS NOT NULL), i.created_at DESC, i.id, ii.id
         LIMIT 1001`, [companyId, sku])).rows;
    });
    res.json({ rows: rows.slice(0, 1000), hasMore: rows.length > 1000 });
  } catch (err) { next(err); }
});

router.get('/stock', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    if (!companyId) throw new HttpError(400, 'Укажите продавца');
    const source = await stockSourceOf(req, companyId);
    const rows = await withTenantContext(tenantContextFromAuth(req.auth), async client => {
      await requireActiveCompany(client, companyId);
      const stock = await loadStock(client, companyId, { source });
      // Складу — «На WB» и расхождение с «Доступно» (владелец 06.10.2026).
      if (req.auth.role !== 'seller') await wbListing.annotate(client, req.auth.warehouseId, companyId, stock);
      return stock;
    });
    // Keep real warehouse-only products visible, but do not create inventory
    // rows from unresolved order lines that have neither a product nor stock.
    const visibleRows = rows.filter(row => row.listed || row.stockKnown);
    res.set('Cache-Control', 'no-store').json(
      // ?view=seller — владелец смотрит кабинет продавца его глазами.
      req.auth.role === 'seller' || req.query.view === 'seller' ? sellerStockResponse(rows) : visibleRows,
    );
  } catch (err) { next(err); }
});

// «Остатки продавцов» в кабинете владельца (владелец 02.10.2026): одна строка
// на продавца — те же числа, что он видит у себя, — и сколько лежит в ячейках.
router.get('/stock-summary', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const out = await withTenantContext({ warehouseId: req.auth.warehouseId }, (c) => stockBySeller(c, req.auth.warehouseId));
    res.set('Cache-Control', 'no-store').json(out);
  } catch (err) { next(err); }
});

// Движение товара продавца: что у него отгрузили и что вернулось.
//
// Остаток отвечает на «сколько лежит», но не на «куда делось». Именно из-за
// второго вопроса продавец и звонит на склад: он видит, что стало меньше, и
// не знает почему. Возврат тем более: пока он не увидит, что признано браком
// и почему, решать по нему он не сможет.
//
// Область видимости снова решает Postgres: политики на shipping_records и
// return_records пропускают строки своей компании.
router.get('/movements', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const ctx = tenantContextFromAuth(req.auth);
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    if (!companyId) throw new HttpError(400, 'Укажите продавца');

    const out = await withTenantContext(ctx, async (client) => {
      await requireActiveCompany(client, companyId);
      const shipped = await client.query(
        `SELECT sr.id, sr.picked_qty AS qty, COALESCE(i.shipped_at,s.shipped_at) AS at,
                ii.name, ii.sku, i.number AS invoice_number, i.source
         FROM shipping_records sr
         JOIN invoice_items ii ON ii.id = sr.invoice_item_id
         JOIN invoices i ON i.id = ii.invoice_id
         LEFT JOIN supplies s ON s.id=i.supply_id AND s.company_id=$1 AND s.status='shipped'
         WHERE sr.company_id = $1 AND ii.company_id=$1 AND i.company_id=$1 AND sr.picked_qty IS NOT NULL AND i.status = 'shipped'
         ORDER BY COALESCE(i.shipped_at,s.shipped_at) DESC NULLS LAST,sr.id DESC
         LIMIT 300`,
        [companyId],
      );
      const returned = await client.query(
        `SELECT rr.id, rr.qty, rr.finished_at AS at, rr.quality_bucket, rr.defect_note,
                ii.name, ii.sku, i.number AS invoice_number
         FROM return_records rr
         JOIN invoice_items ii ON ii.id = rr.invoice_item_id
         JOIN invoices i ON i.id = ii.invoice_id
         WHERE rr.company_id = $1 AND ii.company_id=$1 AND i.company_id=$1
         ORDER BY rr.finished_at DESC
         LIMIT 300`,
        [companyId],
      );
      return { shipped: shipped.rows, returned: returned.rows };
    });

    res.json({
      shipped: out.shipped.map((r) => ({
        id: r.id,
        at: r.at,
        qty: Number(r.qty),
        name: r.name,
        sku: r.sku,
        order: r.invoice_number,
        // Откуда пришёл заказ — продавцу это важнее, чем складу: он сверяет
        // с кабинетом площадки, а не с 1С склада.
        source: r.source === 'wb' ? 'Wildberries' : '1С',
      })),
      returned: out.returned.map((r) => ({
        id: r.id,
        at: r.at,
        qty: Number(r.qty),
        name: r.name,
        sku: r.sku,
        order: r.invoice_number,
        bucket: r.quality_bucket,
        note: r.defect_note || null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Склад брака продавца (владелец 02.10.2026): что лежит на складе брака и
// сколько ждёт решения, документы «Перемещение на склад брака» (откуда брак,
// описание, есть ли фото), решения и их выполнение, и решения, которые склад
// принял за продавца и которые продавец ещё не видел.
router.get('/defects', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    if (!companyId) throw new HttpError(400, 'Укажите продавца');
    const out = await withTenantContext(tenantContextFromAuth(req.auth), async (c) => {
      await requireActiveCompany(c, companyId);
      const balances = await defectsService.balances(c, companyId);
      const moves = (await c.query(
        `SELECT m.id, m.number, m.sku, m.name, m.qty, m.bucket, m.note, m.source, m.created_at,
                m.photo IS NOT NULL AS has_photo, i.number AS document, m.invoice_id
           FROM defect_moves m LEFT JOIN invoices i ON i.id = m.invoice_id
          WHERE m.company_id = $1 ORDER BY m.created_at DESC, m.number DESC LIMIT 1001`, [companyId])).rows;
      const decisions = (await c.query(
        `SELECT id, number, sku, name, bucket, qty, action, markdown_barcode, note, decided_role, decided_name,
                decided_at, seller_seen_at, status, done_at, done_qty
           FROM defect_decisions WHERE company_id = $1 ORDER BY decided_at DESC LIMIT 501`, [companyId])).rows;
      return { balances, moves, decisions };
    });
    const sourceName = defectsService.SOURCES;
    res.set('Cache-Control', 'no-store').json({
      balances: out.balances,
      hasMore: out.moves.length > 1000,
      moves: out.moves.slice(0, 1000).map((m) => ({
        id: m.id, number: m.number, sku: m.sku, name: m.name, qty: Number(m.qty), bucket: m.bucket, note: m.note,
        source: m.source, sourceName: sourceName[m.source] || 'склад', document: m.document || null,
        invoiceId: m.invoice_id || null, at: m.created_at, hasPhoto: m.has_photo,
      })),
      decisions: out.decisions.slice(0, 500).map((d) => ({
        id: d.id, number: d.number, sku: d.sku, name: d.name, bucket: d.bucket, qty: Number(d.qty), action: d.action,
        markdownBarcode: d.markdown_barcode, note: d.note, decidedRole: d.decided_role, decidedName: d.decided_name,
        decidedAt: d.decided_at, status: d.status, doneAt: d.done_at, doneQty: Number(d.done_qty || 0),
        unseen: d.decided_role !== 'seller' && !d.seller_seen_at,
      })),
    });
  } catch (err) { next(err); }
});

// Решение по браку. Продавец решает за себя; руководитель и менеджер склада —
// за продавца (например, после звонка): видно, кто решил, и продавцу
// приходит уведомление в кабинете.
router.post('/defects/decisions', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : (b.companyId || req.query.companyId);
    if (!companyId) throw new HttpError(400, 'Укажите продавца');
    const { warehouseId } = req.auth;
    const out = await withTenantContext({ warehouseId }, async (c) => {
      const company = (await c.query(
        'SELECT id FROM companies WHERE id = $1 AND warehouse_id = $2 AND archived_at IS NULL', [companyId, warehouseId])).rows[0];
      if (!company) throw new HttpError(404, 'Компания не найдена');
      let name = null;
      if (req.auth.role === 'owner') name = 'Руководитель склада';
      if (req.auth.role === 'manager') {
        const s = (await c.query('SELECT name FROM staff_keys WHERE id = $1', [req.auth.staffKeyId])).rows[0];
        name = s ? `Менеджер ${s.name}` : 'Менеджер склада';
      }
      return defectsService.decide(c, {
        warehouseId, companyId, sku: String(b.sku || ''), bucket: b.bucket, qty: b.qty, action: b.action,
        markdownBarcode: b.markdownBarcode, note: b.note,
        actor: {
          role: req.auth.role, name,
          id: req.auth.role === 'seller' ? req.auth.sellerKeyId : (req.auth.staffKeyId || req.auth.ownerId || null),
        },
      });
    });
    res.status(201).json(out);
  } catch (err) { next(err); }
});

// Продавец увидел решения, которые склад принял за него.
router.post('/defects/seen', requireAuth, requireRole('seller'), async (req, res, next) => {
  try {
    const n = await withTenantContext({ warehouseId: req.auth.warehouseId }, async (c) => (await c.query(
      `UPDATE defect_decisions SET seller_seen_at = now()
        WHERE company_id = $1 AND decided_role <> 'seller' AND seller_seen_at IS NULL`, [req.auth.companyId])).rowCount);
    res.json({ seen: n });
  } catch (err) { next(err); }
});

// History remains under seller RLS, including every page requested by its cursor.
router.get('/history', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    const sku = typeof req.query.sku === 'string' ? req.query.sku.trim() : '';
    if (!companyId || !sku || sku.length > 200) throw new HttpError(400, 'Укажите продавца и артикул');
    const page = readPage(req.query, companyId, sku);
    const result = await withTenantContext(tenantContextFromAuth(req.auth), async client => {
      await requireActiveCompany(client, companyId);
      return loadHistory(client, companyId, sku, page, { forSeller: req.auth.role === 'seller' });
    });
    if (req.auth.role === 'seller') {
      result.events = result.events.map(({ fromCell, toCell, toCells, ...event }) => event);
    }
    res.set('Cache-Control', 'no-store').json(result);
  } catch (err) { next(err); }
});

router.post('/companies', requireAuth, requireGrant('clients'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { name } = req.body;
    if (!name || !name.trim()) throw new HttpError(400, 'Введите название компании');

    const company = await withTenantContext({ warehouseId }, async (client) => {
      const result = await client.query(
        `INSERT INTO companies (warehouse_id, name) VALUES ($1, $2) RETURNING id, name, created_at`,
        [warehouseId, name.trim()],
      );
      return result.rows[0];
    });
    res.status(201).json(company);
  } catch (err) {
    next(err);
  }
});

// Retiring a client is reversible and keeps its source history for audit.
// Access is revoked in the same transaction so an already issued key cannot
// keep an archived company operational.
router.patch('/companies/:companyId/archive', requireAuth, requireGrant('clients'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { companyId } = req.params;
    if (typeof req.body?.archived !== 'boolean') {
      throw new HttpError(400, 'Передайте archived: true или false');
    }
    const company = await withTenantContext({ warehouseId }, async (client) => {
      // В архиве продавец пропадает со всех экранов — вместе с его заказами
      // и поставками. Товар, уже снятый с полок под заказ, который ещё не
      // уехал и не вернулся на полку, выпал бы из учёта: ни на полке, ни в
      // отгрузке. Так висела ПС-0909-01 архивной компании (разобрана 26.09).
      // Касается любого заказа — и в поставке WB, и заказа 1С без поставки.
      if (req.body.archived) {
        // Строку продавца — на запись: одновременный отбор ждёт архив (или
        // архив ждёт отбор), и проверка ниже видит всё, что успели снять.
        await client.query('SELECT 1 FROM companies WHERE id = $1 AND warehouse_id = $2 FOR UPDATE', [companyId, warehouseId]);
        const busy = (await client.query(
          `SELECT DISTINCT COALESCE(s.number, i.number) AS label
             FROM invoices i
             JOIN invoice_items ii ON ii.invoice_id = i.id
             JOIN shipping_records sr ON sr.invoice_item_id = ii.id AND sr.picked_qty > 0
             LEFT JOIN supplies s ON s.id = i.supply_id
            WHERE i.warehouse_id = $1 AND i.company_id = $2 AND i.direction = 'out'
              AND i.status <> 'shipped' AND i.mp_stock_returned_at IS NULL
            ORDER BY 1`, [warehouseId, companyId])).rows.map((r) => r.label);
        if (busy.length) {
          throw new HttpError(409, `У продавца есть собранный товар, который ещё не уехал: ${busy.join(', ')}. `
            + 'Сначала отгрузите его («Уехала») или верните в ячейки.');
        }
      }
      const result = await client.query(
        `UPDATE companies
            SET archived_at = CASE WHEN $3 THEN COALESCE(archived_at, now()) ELSE NULL END,
                external_id = CASE WHEN $3 THEN NULL ELSE external_id END
          WHERE id = $1 AND warehouse_id = $2
          RETURNING id, name, archived_at`,
        [companyId, warehouseId, req.body.archived],
      );
      if (!result.rows[0]) return null;
      if (req.body.archived) {
        await client.query(
          `UPDATE seller_keys SET active=false, revoked_at=COALESCE(revoked_at,now())
            WHERE company_id=$1 AND warehouse_id=$2 AND active=true`,
          [companyId, warehouseId],
        );
      }
      return result.rows[0];
    });
    if (!company) throw new HttpError(404, 'Компания не найдена');
    res.json(company);
  } catch (err) { next(err); }
});

router.post('/companies/:companyId/keys', requireAuth, requireGrant('clients'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { companyId } = req.params;

    const key = await withTenantContext({ warehouseId }, async (client) => {
      const companyResult = await client.query(
        `SELECT id, name FROM companies WHERE id = $1 AND warehouse_id = $2 AND archived_at IS NULL`,
        [companyId, warehouseId],
      );
      const company = companyResult.rows[0];
      if (!company) throw new HttpError(404, 'Компания не найдена');

      const prefix = transliteratePrefix(company.name);

      for (let attempt = 0; attempt < 5; attempt++) {
        // Было четыре цифры от Math.random: девять тысяч вариантов при
        // угадываемой приставке из названия компании — и генератор, который
        // для секретов не предназначен. Шесть знаков из crypto дают
        // миллиард, форма ключа при этом та же.
        const keyCode = `${prefix}-${randomPart(6)}-K`;
        try {
          const insertResult = await client.query(
            `INSERT INTO seller_keys (company_id, warehouse_id, key_code)
             VALUES ($1, $2, $3) RETURNING id, key_code, active, issued_at`,
            [companyId, warehouseId, keyCode],
          );
          return insertResult.rows[0];
        } catch (err) {
          if (err.code === '23505' && attempt < 4) continue; // key_code collision, retry
          throw err;
        }
      }
      throw new HttpError(500, 'Не удалось сгенерировать уникальный ключ, попробуйте ещё раз');
    });
    res.status(201).json(key);
  } catch (err) {
    next(err);
  }
});

router.patch('/keys/:id/toggle', requireAuth, requireGrant('clients'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { id } = req.params;

    const key = await withTenantContext({ warehouseId }, async (client) => {
      const result = await client.query(
        `UPDATE seller_keys
         SET active = NOT active, revoked_at = CASE WHEN active THEN now() ELSE NULL END
         WHERE id = $1 AND warehouse_id = $2
         RETURNING id, key_code, active, issued_at, revoked_at`,
        [id, warehouseId],
      );
      return result.rows[0];
    });
    if (!key) throw new HttpError(404, 'Ключ не найден');
    // Отзыв действует с этой секунды, без двухсекундного запаса памяти.
    forgetKey('seller', key.id);
    res.json(key);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.sellerStockResponse = sellerStockResponse;
