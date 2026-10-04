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
  stock_source, timezone, wb_supplies_by, wb_names, setup_at, vw_reminders`;

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

// Готовность нового склада (рецензия 04.10, рекомендация 6): шаги по
// фактическому состоянию, а не по ручным галочкам. Последний шаг — первая
// настоящая операция: приход, который видят и склад, и продавец.
router.get('/me/readiness', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const r = await withTenantContext({ warehouseId }, async (client) => (await client.query(
      `SELECT w.setup_at IS NOT NULL AS survey, w.stock_source,
              EXISTS (SELECT 1 FROM cell_blocks WHERE warehouse_id = w.id) AS cells,
              EXISTS (SELECT 1 FROM companies WHERE warehouse_id = w.id AND archived_at IS NULL) AS seller,
              EXISTS (SELECT 1 FROM products p JOIN companies c ON c.id = p.company_id AND c.archived_at IS NULL
                       WHERE p.warehouse_id = w.id) AS catalog,
              EXISTS (SELECT 1 FROM integration_keys WHERE warehouse_id = w.id AND active AND last_seen_at IS NOT NULL) AS onec,
              EXISTS (SELECT 1 FROM cell_stock WHERE warehouse_id = w.id AND qty > 0) AS argus_stock,
              EXISTS (SELECT 1 FROM staff_keys WHERE warehouse_id = w.id AND active AND kind = 'worker') AS worker,
              EXISTS (SELECT 1 FROM seller_keys WHERE warehouse_id = w.id AND active) AS seller_key,
              EXISTS (SELECT 1 FROM receiving_records WHERE warehouse_id = w.id) AS first_operation
         FROM warehouses w WHERE w.id = $1`, [warehouseId])).rows[0]);
    const viaOneC = r.stock_source === '1c';
    res.json({ steps: [
      { key: 'survey', done: r.survey },
      { key: 'seller', done: r.seller },
      { key: 'catalog', done: r.catalog },
      // Учёт в Аргусе: пустой склад — тоже известный остаток, он наполнится приходами.
      viaOneC ? { key: 'stock_1c', done: r.onec } : { key: 'stock_argus', done: r.argus_stock, optional: true },
      { key: 'cells', done: r.cells, optional: true },
      { key: 'worker', done: r.worker },
      { key: 'seller_key', done: r.seller_key },
      { key: 'first_operation', done: r.first_operation },
    ] });
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
                WHERE warehouse_id = $1 AND quality = 'good' AND company_id IS NOT NULL) AS cells,
              -- Собранное, но не уехавшее: из ячеек ушло, а «Всего» у
              -- продавца его считает (sellers/stock.js, staged).
              (SELECT COALESCE(sum(sr.picked_qty), 0)::bigint FROM shipping_records sr
                 JOIN invoice_items ii ON ii.id = sr.invoice_item_id JOIN invoices i ON i.id = ii.invoice_id
                WHERE i.warehouse_id = $1 AND sr.company_id IS NOT NULL AND i.direction = 'out'
                  AND i.status <> 'shipped' AND i.mp_stock_returned_at IS NULL) AS staged`,
      [warehouseId])).rows[0]);
    res.json({ onec: Number(out.onec), cells: Number(out.cells), staged: Number(out.staged) });
  } catch (err) {
    next(err);
  }
});

// Только имя пояса («Europe/Moscow», «UTC»): смещение вроде «+03:00» не
// переходит на летнее время и не везде понятно браузеру (проверка 01.10.2026).
const validTimezone = (tz) => {
  if (!/^(UTC|[A-Za-z]+(\/[A-Za-z0-9_+-]+)+)$/.test(tz)) return false;
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
      // Только строки: String({}) — «[object Object]», String(null) — «null», и
      // такое «имя» отмечало бы чужие склады нашими (проверка 01.10.2026).
      if (!Array.isArray(body.wbNames) || body.wbNames.some((n) => typeof n !== 'string')) {
        throw new HttpError(400, 'wbNames — список названий');
      }
      wbNames = [...new Set(body.wbNames.map((n) => n.trim().slice(0, 60)).filter((n) => n.length >= 3))].slice(0, 10);
    }
    if (name !== undefined && !name) throw new HttpError(400, 'Название склада не может быть пустым');
    // Кладовщик напоминает о складах продавцов — можно выключить (02.10.2026).
    if (body.vwReminders !== undefined && typeof body.vwReminders !== 'boolean') {
      throw new HttpError(400, 'Напоминания о складах продавцов — да или нет');
    }
    const warehouse = await withTenantContext({ warehouseId }, async (client) => {
      const before = (await client.query('SELECT name, wb_names FROM warehouses WHERE id = $1', [warehouseId])).rows[0];
      const result = await client.query(
        `UPDATE warehouses SET name = COALESCE($2, name), city = COALESCE($3, city),
                legal_name = CASE WHEN $4::boolean THEN NULLIF($5, '') ELSE legal_name END,
                stock_source = COALESCE($6, stock_source),
                timezone = COALESCE($7, timezone),
                wb_supplies_by = COALESCE($8, wb_supplies_by),
                wb_names = COALESCE($9::text[], wb_names),
                setup_at = CASE WHEN $10::boolean THEN COALESCE(setup_at, now()) ELSE setup_at END,
                vw_reminders = COALESCE($11, vw_reminders)
          WHERE id = $1 RETURNING ${FIELDS}`,
        [warehouseId, name ?? null, city ?? null, legal !== undefined, legal ?? null,
          stockSource ?? null, timezone ?? null, suppliesBy ?? null, wbNames ?? null,
          body.setupDone === true, body.vwReminders ?? null],
      );
      // Имя склада и «как нас называют продавцы» решают, какие склады WB
      // продавцов Аргус считает нашими: отметить новые совпадения. Экран шлёт
      // оба поля при каждом сохранении — пересчёт только когда они изменились.
      const after = result.rows[0];
      if (before && after && (before.name !== after.name
          || JSON.stringify(before.wb_names || []) !== JSON.stringify(after.wb_names || []))) {
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
