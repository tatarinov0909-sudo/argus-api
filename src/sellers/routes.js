const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const { transliteratePrefix } = require('../auth/service');
const { tenantContextFromAuth } = require('../auth/tenantContext');

const router = express.Router();

router.get('/companies', requireAuth, requireRole('owner'), async (req, res, next) => {
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
router.get('/stock', requireAuth, requireRole('seller', 'owner'), async (req, res, next) => {
  try {
    const ctx = tenantContextFromAuth(req.auth);
    // Владелец смотрит глазами конкретного продавца — иначе он увидел бы
    // склад целиком, а вопрос здесь другой: «что видит мой клиент».
    const companyId = req.auth.role === 'owner' ? req.query.companyId : req.auth.companyId;
    if (!companyId) throw new HttpError(400, 'Укажите продавца');

    const rows = await withTenantContext(ctx, async (client) => {
      // Два независимых факта об одном товаре, и ни один не подменяет другой:
      // сколько числится в 1С и сколько Аргус физически разложил по ячейкам.
      // Поэтому FULL JOIN: товар может числиться в 1С и ещё не быть принят
      // у нас, а может лежать в ячейке, но не приехать из обмена. Обычный
      // JOIN от cell_stock прятал первый случай — а сегодня это ВСЕ товары.
      const result = await client.query(
        `WITH cells AS (
           SELECT sku,
                  SUM(qty) FILTER (WHERE quality = 'good') AS good_qty,
                  SUM(qty) FILTER (WHERE quality <> 'good') AS bad_qty,
                  count(DISTINCT cell_block_id) AS cells
           FROM cell_stock
           WHERE company_id = $1 AND qty > 0
           GROUP BY sku
         ), prod AS (
           SELECT sku, name, stock_qty_1c, stock_at
           FROM products
           WHERE company_id = $1 AND COALESCE(stock_qty_1c, 0) <> 0
         )
         SELECT COALESCE(p.sku, c.sku) AS sku,
                COALESCE(p.name, (SELECT ii.name FROM invoice_items ii
                                  WHERE ii.company_id = $1 AND ii.sku = c.sku
                                  ORDER BY ii.id DESC LIMIT 1),
                         COALESCE(p.sku, c.sku)) AS name,
                c.good_qty, c.bad_qty, c.cells,
                p.stock_qty_1c, p.stock_at
         FROM prod p
         FULL JOIN cells c ON c.sku = p.sku
         ORDER BY name`,
        [companyId],
      );
      return result.rows;
    });

    res.json(rows.map((r) => ({
      sku: r.sku,
      name: r.name,
      // Годное и негодное раздельно: «на складе 40» без оговорки, что 8 из них
      // брак, — это обещание отгрузить то, что отгружено не будет.
      qty: Number(r.good_qty || 0),
      notForSale: Number(r.bad_qty || 0),
      cells: Number(r.cells || 0),
      // Цифра из 1С склада и время, когда она пришла. Без времени нельзя
      // отличить «на складе ноль» от «обмен молчит вторую неделю».
      qtyIn1c: r.stock_qty_1c === null || r.stock_qty_1c === undefined
        ? null : Number(r.stock_qty_1c),
      stockAt: r.stock_at || null,
    })));
  } catch (err) {
    next(err);
  }
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
router.get('/movements', requireAuth, requireRole('seller', 'owner'), async (req, res, next) => {
  try {
    const ctx = tenantContextFromAuth(req.auth);
    const companyId = req.auth.role === 'owner' ? req.query.companyId : req.auth.companyId;
    if (!companyId) throw new HttpError(400, 'Укажите продавца');

    const out = await withTenantContext(ctx, async (client) => {
      const shipped = await client.query(
        `SELECT sr.id, sr.picked_qty AS qty, sr.finished_at AS at,
                ii.name, ii.sku, i.number AS invoice_number, i.source
         FROM shipping_records sr
         JOIN invoice_items ii ON ii.id = sr.invoice_item_id
         JOIN invoices i ON i.id = ii.invoice_id
         WHERE sr.company_id = $1 AND sr.picked_qty IS NOT NULL
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

router.post('/companies', requireAuth, requireRole('owner'), async (req, res, next) => {
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

router.post('/companies/:companyId/keys', requireAuth, requireRole('owner'), async (req, res, next) => {
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
        const digits = String(1000 + Math.floor(Math.random() * 9000));
        const keyCode = `${prefix}-${digits}-K`;
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

router.patch('/keys/:id/toggle', requireAuth, requireRole('owner'), async (req, res, next) => {
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
