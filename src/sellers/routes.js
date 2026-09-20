const express = require('express');
const { requireAuth, requireRole, requireGrant } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { randomPart } = require('../middleware/keys');
const { HttpError } = require('../middleware/errorHandler');
const { transliteratePrefix } = require('../auth/service');
const { tenantContextFromAuth } = require('../auth/tenantContext');

const { loadStock } = require('./stock');
const { readPage, loadHistory } = require('./history');
const { prepareInventoryExport } = require('./export');
const { combineCatalog } = require('./catalog');
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
    available: row.sellerAvailable,
    orderedOrders: row.queuedOrders,
    assemblyOrders: row.assemblyOrders,
    updatedAt: row.totalUpdatedAt,
  };
}

function sellerStockResponse(rows) {
  // Only products with a current accounting quantity belong in the seller's
  // inventory. Order-only lines stay visible on the orders page and cannot
  // invent a product or a stock quantity.
  // Строка без числа из 1С — это «остаток не получен», а не «товара нет»:
  // раньше такие строки исчезали из кабинета вместе с товаром, который лежит
  // в ячейках и по которому идут заказы. Поля totalKnown/unknownRows как раз
  // для этого и заведены, и до сих пор были мертвы.
  const inventoryRows = rows.filter(row => row.listed);
  const unknownRows = inventoryRows.filter(row => !row.totalKnown);
  const sum = (source, field) => source.reduce((total, row) => total + Number(row[field] || 0), 0);
  // Сортировка строк давала не самую свежую дату, а последнюю по алфавиту.
  const updatedAt = inventoryRows
    .map(row => row.totalUpdatedAt)
    .filter(Boolean)
    .reduce((latest, value) => (!latest || new Date(value) > new Date(latest) ? value : latest), null);

  return {
    rows: inventoryRows.map(sellerStockView),
    summary: {
      productCount: inventoryRows.length,
      total: unknownRows.length ? null : sum(inventoryRows, 'total'),
      ordered: sum(inventoryRows, 'orderedNotInSupply'),
      inAssembly: sum(inventoryRows, 'inAssembly'),
      available: unknownRows.length ? null : sum(inventoryRows, 'sellerAvailable'),
      updatedAt,
    },
  };
}

async function requireActiveCompany(client, companyId) {
  const company = (await client.query(
    'SELECT id FROM companies WHERE id=$1 AND archived_at IS NULL',
    [companyId],
  )).rows[0];
  if (!company) throw new HttpError(404, 'Компания не найдена');
}

router.get('/catalog', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    if (!companyId) throw new HttpError(400, 'Укажите продавца');
    const rows = await withTenantContext(tenantContextFromAuth(req.auth), async c => {
      const company = (await c.query('SELECT id FROM companies WHERE id=$1 AND archived_at IS NULL', [companyId])).rows[0];
      if (!company) throw new HttpError(404, 'Компания не найдена');
      return (await c.query(`WITH links AS (
        SELECT sku,mp_sku AS nm_id,mp_article AS article FROM product_marketplace_skus WHERE company_id=$1 AND marketplace='wb'
        UNION SELECT sku,mp_nm_id,mp_article FROM invoice_items WHERE company_id=$1 AND mp_nm_id IS NOT NULL
      ), skus AS (
        SELECT sku FROM products WHERE company_id=$1 AND active=true
        UNION
        SELECT l.sku FROM links l
        WHERE NOT EXISTS (
          SELECT 1 FROM products hidden
          WHERE hidden.company_id=$1 AND hidden.sku=l.sku AND hidden.active=false
        )
      )
      SELECT s.sku,p.category,l.nm_id,l.article,m.photo_url FROM skus s LEFT JOIN products p ON p.sku=s.sku AND p.company_id=$1 AND p.active=true
      LEFT JOIN links l ON l.sku=s.sku
      LEFT JOIN marketplace_product_media m ON m.company_id=$1 AND m.nm_id=l.nm_id
      ORDER BY s.sku,l.nm_id`, [companyId])).rows;
    });
    res.set('Cache-Control', 'no-store').json({ products: combineCatalog(rows) });
  } catch (err) { next(err); }
});

// Explicit owner-only view of source documents, without rebinding them to a seller.
router.get('/source-documents', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const rows = await withTenantContext(tenantContextFromAuth(req.auth), async c => (await c.query(
      `SELECT i.id,i.number,i.direction,i.status,i.source,i.created_at,i.source_document_type,i.source_document_date,i.company_id,c.name AS company_name,
              count(ii.id)::int AS item_count,COALESCE(SUM(ii.declared_qty),0) AS declared_qty
       FROM invoices i JOIN companies c ON c.id=i.company_id AND c.archived_at IS NULL LEFT JOIN invoice_items ii ON ii.invoice_id=i.id
       WHERE i.warehouse_id=$1 AND i.source='1c' AND i.external_id IS NOT NULL AND i.direction='in'
       GROUP BY i.id,c.name ORDER BY i.created_at DESC,i.id LIMIT 1001`, [req.auth.warehouseId])).rows);
    res.set('Cache-Control','no-store').json({rows:rows.slice(0,1000),hasMore:rows.length>1000});
  } catch (err) { next(err); }
});

router.get('/profile', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    const profile = await withTenantContext(tenantContextFromAuth(req.auth), async c => {
      const company = (await c.query('SELECT id, name, warehouse_id FROM companies WHERE id=$1 AND archived_at IS NULL', [companyId])).rows[0];
      if (!company) throw new HttpError(404, 'Компания не найдена');
      // Warehouse identity is non-secret. Seller context cannot read warehouse rows.
      return { id: company.id, name: company.name, warehouseId: company.warehouse_id };
    });
    res.set('Cache-Control','no-store').json(profile);
  } catch (err) { next(err); }
});

router.get('/export/1c', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    if (!companyId) throw new HttpError(400,'Укажите продавца');
    const prepared = await withTenantContext(tenantContextFromAuth(req.auth), async c => {
      // All quantities come from one loadStock SQL statement (one MVCC snapshot).
      const company = (await c.query('SELECT id,name,warehouse_id FROM companies WHERE id=$1 AND archived_at IS NULL',[companyId])).rows[0];
      if (!company) throw new HttpError(404,'Компания не найдена');
      return prepareInventoryExport((await loadStock(c,companyId)).filter(row => row.listed || row.stockKnown), {
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
      return (await c.query(
        `SELECT i.id, i.number, i.direction, i.status, i.source, i.created_at, i.source_document_type, i.source_document_date,
              count(ii.id)::int AS item_count, COALESCE(SUM(ii.declared_qty),0) AS declared_qty
       FROM invoices i LEFT JOIN invoice_items ii ON ii.invoice_id=i.id AND ii.company_id=$1
       WHERE i.company_id=$1 AND i.direction IN ('in','return')
       GROUP BY i.id ORDER BY i.created_at DESC,i.id LIMIT 1001`, [companyId])).rows;
    });
    res.set('Cache-Control','no-store').json({ rows:rows.slice(0,1000),hasMore:rows.length>1000 });
  } catch (err) { next(err); }
});

router.get('/orders', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    if (!companyId) throw new HttpError(400, 'Укажите продавца');
    const rows = await withTenantContext(tenantContextFromAuth(req.auth), async client => {
      await requireActiveCompany(client, companyId);
      return (await client.query(
        `SELECT i.id, i.number, i.status, i.source, i.created_at, i.shipped_at,
                i.mp_supplier_status, i.mp_status, i.mp_status_checked_at, i.mp_closed_at,
                i.mp_close_reason, i.mp_stock_returned_at, (i.supply_id IS NOT NULL) AS in_supply,
                (i.supply_id IS NOT NULL OR EXISTS (SELECT 1 FROM shipping_records sr JOIN invoice_items si ON si.id=sr.invoice_item_id
                        WHERE si.invoice_id=i.id AND sr.company_id=$1 AND si.company_id=$1 AND sr.picked_qty>0))
                  AND i.mp_closed_at IS NOT NULL AND i.mp_stock_returned_at IS NULL AND i.status<>'shipped' AS stock_conflict,
                ii.id AS item_id, ii.name, ii.sku, ii.declared_qty AS qty, ii.mp_rid, ii.mp_nm_id, ii.mp_article
         FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
         WHERE i.company_id = $1 AND ii.company_id = $1 AND i.direction = 'out'
         ORDER BY (i.status = 'shipped' OR i.mp_closed_at IS NOT NULL), i.created_at DESC, i.id, ii.id
         LIMIT 1001`, [companyId])).rows;
    });
    res.json({ rows: rows.slice(0, 1000), hasMore: rows.length > 1000 });
  } catch (err) { next(err); }
});

router.get('/stock', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    if (!companyId) throw new HttpError(400, 'Укажите продавца');
    const rows = await withTenantContext(tenantContextFromAuth(req.auth), async client => {
      await requireActiveCompany(client, companyId);
      return loadStock(client, companyId);
    });
    // Keep real warehouse-only products visible, but do not create inventory
    // rows from unresolved order lines that have neither a product nor stock.
    const visibleRows = rows.filter(row => row.listed || row.stockKnown);
    res.set('Cache-Control', 'no-store').json(
      req.auth.role === 'seller' ? sellerStockResponse(rows) : visibleRows,
    );
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

// History remains under seller RLS, including every page requested by its cursor.
router.get('/history', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    const sku = typeof req.query.sku === 'string' ? req.query.sku.trim() : '';
    if (!companyId || !sku || sku.length > 200) throw new HttpError(400, 'Укажите продавца и артикул');
    const page = readPage(req.query, companyId, sku);
    const result = await withTenantContext(tenantContextFromAuth(req.auth), async client => {
      await requireActiveCompany(client, companyId);
      return loadHistory(client, companyId, sku, page);
    });
    if (req.auth.role === 'seller') {
      result.events = result.events.map(({ fromCell, toCell, ...event }) => event);
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
    res.json(key);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
