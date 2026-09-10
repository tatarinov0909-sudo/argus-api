const express = require('express');
const { requireAuth, requireRole, requireGrant } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { randomPart } = require('../middleware/keys');
const { HttpError } = require('../middleware/errorHandler');
const { transliteratePrefix } = require('../auth/service');
const { tenantContextFromAuth } = require('../auth/tenantContext');

const { loadStock } = require('./stock');
const { prepareInventoryExport } = require('./export');
const { combineCatalog } = require('./catalog');
const router = express.Router();
router.use('/document-examples', require('./document-examples'));

router.get('/catalog', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    if (!companyId) throw new HttpError(400, 'Укажите продавца');
    const rows = await withTenantContext(tenantContextFromAuth(req.auth), async c => {
      const company = (await c.query('SELECT id FROM companies WHERE id=$1', [companyId])).rows[0];
      if (!company) throw new HttpError(404, 'Компания не найдена');
      return (await c.query(`WITH links AS (
        SELECT sku,mp_sku AS nm_id,mp_article AS article FROM product_marketplace_skus WHERE company_id=$1 AND marketplace='wb'
        UNION SELECT sku,mp_nm_id,mp_article FROM invoice_items WHERE company_id=$1 AND mp_nm_id IS NOT NULL
      ), skus AS (SELECT sku FROM products WHERE company_id=$1 UNION SELECT sku FROM links)
      SELECT s.sku,p.category,l.nm_id,l.article,m.photo_url FROM skus s LEFT JOIN products p ON p.sku=s.sku AND p.company_id=$1
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
      `SELECT i.id,i.number,i.direction,i.status,i.source,i.created_at,i.company_id,c.name AS company_name,
              count(ii.id)::int AS item_count,COALESCE(SUM(ii.declared_qty),0) AS declared_qty
       FROM invoices i JOIN companies c ON c.id=i.company_id LEFT JOIN invoice_items ii ON ii.invoice_id=i.id
       WHERE i.warehouse_id=$1 AND i.source='1c' AND i.external_id IS NOT NULL AND i.direction='in'
       GROUP BY i.id,c.name ORDER BY i.created_at DESC,i.id LIMIT 1001`, [req.auth.warehouseId])).rows);
    res.set('Cache-Control','no-store').json({rows:rows.slice(0,1000),hasMore:rows.length>1000});
  } catch (err) { next(err); }
});

router.get('/profile', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    const profile = await withTenantContext(tenantContextFromAuth(req.auth), async c => {
      const company = (await c.query('SELECT id, name, warehouse_id FROM companies WHERE id=$1', [companyId])).rows[0];
      if (!company) throw new HttpError(404, 'Компания не найдена');
      // Warehouse identity is non-secret. Seller context cannot read warehouse rows.
      return { id: company.id, name: company.name, warehouseId: company.warehouse_id };
    });
    res.set('Cache-Control','no-store').json(profile);
  } catch (err) { next(err); }
});

router.get('/export/1c', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    if (!companyId) throw new HttpError(400,'Укажите продавца');
    const prepared = await withTenantContext(tenantContextFromAuth(req.auth), async c => {
      // All quantities come from one loadStock SQL statement (one MVCC snapshot).
      const company = (await c.query('SELECT id,name,warehouse_id FROM companies WHERE id=$1',[companyId])).rows[0];
      if (!company) throw new HttpError(404,'Компания не найдена');
      return prepareInventoryExport(await loadStock(c,companyId), {
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
        `SELECT c.id, c.name, c.created_at,
                COALESCE(json_agg(json_build_object(
                  'id', sk.id, 'keyCode', sk.key_code, 'active', sk.active, 'issuedAt', sk.issued_at
                ) ORDER BY sk.issued_at) FILTER (WHERE sk.id IS NOT NULL), '[]') AS keys
         FROM companies c
         LEFT JOIN seller_keys sk ON sk.company_id = c.id
         WHERE c.warehouse_id = $1
         GROUP BY c.id ORDER BY c.created_at ASC`,
        [warehouseId],
      );
      return result.rows;
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
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
    const rows = await withTenantContext(tenantContextFromAuth(req.auth), async c => (await c.query(
      `SELECT i.id, i.number, i.direction, i.status, i.source, i.created_at,
              count(ii.id)::int AS item_count, COALESCE(SUM(ii.declared_qty),0) AS declared_qty
       FROM invoices i LEFT JOIN invoice_items ii ON ii.invoice_id=i.id AND ii.company_id=$1
       WHERE i.company_id=$1 AND i.direction IN ('in','return')
       GROUP BY i.id ORDER BY i.created_at DESC,i.id LIMIT 1001`,[companyId],
    )).rows);
    res.set('Cache-Control','no-store').json({ rows:rows.slice(0,1000),hasMore:rows.length>1000 });
  } catch (err) { next(err); }
});

router.get('/orders', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    if (!companyId) throw new HttpError(400, 'Укажите продавца');
    const rows = await withTenantContext(tenantContextFromAuth(req.auth), async client => (
      await client.query(
        `SELECT i.id, i.number, i.status, i.source, i.created_at,
                ii.id AS item_id, ii.name, ii.sku, ii.declared_qty AS qty, ii.mp_rid, ii.mp_nm_id, ii.mp_article
         FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
         WHERE i.company_id = $1 AND ii.company_id = $1 AND i.direction = 'out'
         ORDER BY (i.status = 'shipped'), i.created_at DESC, i.id, ii.id
         LIMIT 1001`, [companyId],
      )
    ).rows);
    res.json({ rows: rows.slice(0, 1000), hasMore: rows.length > 1000 });
  } catch (err) { next(err); }
});

router.get('/stock', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    if (!companyId) throw new HttpError(400, 'Укажите продавца');
    const rows = await withTenantContext(tenantContextFromAuth(req.auth), client => loadStock(client, companyId));
    res.set('Cache-Control', 'no-store').json(rows);
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
      const shipped = await client.query(
        `SELECT sr.id, sr.picked_qty AS qty, sr.finished_at AS at,
                ii.name, ii.sku, i.number AS invoice_number, i.source
         FROM shipping_records sr
         JOIN invoice_items ii ON ii.id = sr.invoice_item_id
         JOIN invoices i ON i.id = ii.invoice_id
         WHERE sr.company_id = $1 AND sr.picked_qty IS NOT NULL AND i.status = 'shipped'
         ORDER BY sr.finished_at DESC NULLS LAST
         LIMIT 300`,
        [companyId],
      );
      const returned = await client.query(
        `SELECT rr.id, rr.qty, rr.finished_at AS at, rr.quality_bucket, rr.defect_note,
                ii.name, ii.sku, i.number AS invoice_number
         FROM return_records rr
         JOIN invoice_items ii ON ii.id = rr.invoice_item_id
         JOIN invoices i ON i.id = ii.invoice_id
         WHERE rr.company_id = $1
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

// A seller-scoped document history. Pick timestamps are never called departure dates.
router.get('/history', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const companyId = req.auth.role === 'seller' ? req.auth.companyId : req.query.companyId;
    const sku = typeof req.query.sku === 'string' ? req.query.sku.trim() : '';
    if (!companyId || !sku || sku.length > 200) throw new HttpError(400, 'Укажите продавца и артикул');
    const events = await withTenantContext(tenantContextFromAuth(req.auth), async (client) => {
      const result = await client.query(
        `SELECT * FROM (
           SELECT rr.id, rr.finished_at AS at, 'received' AS kind,
                  rr.accepted_qty AS qty, i.number AS document, NULL::text AS note,
                  NULL::text AS quality, i.status::text AS status
           FROM receiving_records rr
           JOIN invoice_items ii ON ii.id = rr.invoice_item_id
           JOIN invoices i ON i.id = ii.invoice_id
           WHERE rr.company_id = $1 AND ii.sku = $2 AND rr.accepted_qty IS NOT NULL
           UNION ALL
           SELECT sr.id, sr.finished_at, 'picked', sr.picked_qty, i.number, NULL, NULL, i.status::text
           FROM shipping_records sr
           JOIN invoice_items ii ON ii.id = sr.invoice_item_id
           JOIN invoices i ON i.id = ii.invoice_id
           WHERE sr.company_id = $1 AND ii.sku = $2 AND sr.picked_qty IS NOT NULL
           UNION ALL
           SELECT rr.id, rr.finished_at, 'returned', rr.qty, i.number, rr.defect_note,
                  rr.quality_bucket::text, i.status::text
           FROM return_records rr
           JOIN invoice_items ii ON ii.id = rr.invoice_item_id
           JOIN invoices i ON i.id = ii.invoice_id
           WHERE rr.company_id = $1 AND ii.sku = $2
           UNION ALL
           SELECT op.id, op.created_at, op.kind, op.qty, NULL, NULL, NULL, NULL
           FROM stock_operations op WHERE op.company_id = $1 AND op.sku = $2
         ) events ORDER BY at DESC NULLS LAST, id DESC LIMIT 201`, [companyId, sku]);
      return result.rows;
    });
    res.json({ events: events.slice(0, 200).map(r => ({ ...r, qty: Number(r.qty) })), hasMore: events.length > 200 });
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

router.post('/companies/:companyId/keys', requireAuth, requireGrant('clients'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { companyId } = req.params;

    const key = await withTenantContext({ warehouseId }, async (client) => {
      const companyResult = await client.query(
        `SELECT id, name FROM companies WHERE id = $1 AND warehouse_id = $2`,
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
