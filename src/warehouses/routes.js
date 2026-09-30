const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const sellerWarehouses = require('../marketplaces/sellerWarehouses');
const sync = require('../marketplaces/sync');

const router = express.Router();

// Склад и его настройки — анкета фулфилмента (владелец 30.09.2026): как склад
// работает, решает он сам ответами здесь, а не доработкой кода под него.
const FIELDS = `id, name, city, warehouse_code, legal_name, created_at,
  stock_source, timezone, wb_supplies_by, wb_names, setup_at`;

router.get('/me', requireAuth, requireRole('owner', 'manager', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const warehouse = await withTenantContext({ warehouseId }, async (client) => {
      const result = await client.query(`SELECT ${FIELDS} FROM warehouses WHERE id = $1`, [warehouseId]);
      return result.rows[0];
    });
    if (!warehouse) return res.status(404).json({ error: 'Склад не найден' });
    res.json(warehouse);
  } catch (err) {
    next(err);
  }
});

// Сверка перед сменой учёта остатков: сколько товара продавцов по 1С и
// сколько годного в ячейках Аргуса. Меняя ответ, владелец видит, насколько
// сдвинется «Всего товара» у продавцов, — а не узнаёт это от них.
router.get('/me/stock-sources', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const out = await withTenantContext({ warehouseId }, async (client) => (await client.query(
      `SELECT (SELECT COALESCE(sum(GREATEST(stock_qty_1c, 0)), 0)::bigint FROM products
                WHERE warehouse_id = $1 AND active AND company_id IS NOT NULL) AS onec,
              (SELECT COALESCE(sum(qty), 0)::bigint FROM cell_stock
                WHERE warehouse_id = $1 AND quality = 'good' AND company_id IS NOT NULL) AS cells`,
      [warehouseId])).rows[0]);
    res.json({ onec: Number(out.onec), cells: Number(out.cells) });
  } catch (err) {
    next(err);
  }
});

const validTimezone = (tz) => {
  try { new Intl.DateTimeFormat('ru-RU', { timeZone: tz }); return true; } catch { return false; }
};

router.patch('/me', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const body = req.body || {};
    const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
    const name = text(body.name, 120);
    const city = text(body.city, 120);
    // Юрлицо склада — «Хранитель» в актах. Пустая строка стирает.
    const legal = text(body.legalName, 200);
    const stockSource = body.stockSource;
    if (stockSource !== undefined && !['1c', 'argus'].includes(stockSource)) {
      throw new HttpError(400, 'Учёт остатков: «1c» или «argus»');
    }
    const timezone = text(body.timezone, 64);
    if (timezone !== undefined && !validTimezone(timezone)) throw new HttpError(400, 'Неизвестный часовой пояс');
    const suppliesBy = body.wbSuppliesBy;
    if (suppliesBy !== undefined && !['ff', 'seller'].includes(suppliesBy)) {
      throw new HttpError(400, 'Кто оформляет поставку WB: «ff» или «seller»');
    }
    let wbNames;
    if (body.wbNames !== undefined) {
      if (!Array.isArray(body.wbNames)) throw new HttpError(400, 'wbNames — список названий');
      wbNames = [...new Set(body.wbNames.map((n) => String(n).trim().slice(0, 60)).filter((n) => n.length >= 3))].slice(0, 10);
    }
    if (name !== undefined && !name) throw new HttpError(400, 'Название склада не может быть пустым');
    const warehouse = await withTenantContext({ warehouseId }, async (client) => {
      const result = await client.query(
        `UPDATE warehouses SET name = COALESCE($2, name), city = COALESCE($3, city),
                legal_name = CASE WHEN $4::boolean THEN NULLIF($5, '') ELSE legal_name END,
                stock_source = COALESCE($6, stock_source),
                timezone = COALESCE($7, timezone),
                wb_supplies_by = COALESCE($8, wb_supplies_by),
                wb_names = COALESCE($9::text[], wb_names),
                setup_at = CASE WHEN $10::boolean THEN COALESCE(setup_at, now()) ELSE setup_at END
          WHERE id = $1 RETURNING ${FIELDS}`,
        [warehouseId, name ?? null, city ?? null, legal !== undefined, legal ?? null,
          stockSource ?? null, timezone ?? null, suppliesBy ?? null, wbNames ?? null,
          body.setupDone === true],
      );
      // Имя склада и «как нас называют продавцы» решают, какие склады WB
      // продавцов Аргус считает нашими: пересчитать отметки и заказы.
      if (wbNames !== undefined || name !== undefined) {
        await sellerWarehouses.afterRuleChange(client, warehouseId, sync.importOrders);
      }
      return result.rows[0];
    });
    res.json(warehouse);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
