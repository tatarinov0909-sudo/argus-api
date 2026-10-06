const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const runner = require('./runner');

const router = express.Router();

// Что Кладовщик сказал сам, без вопроса. Владельцу — потому что решения по
// этим пунктам принимает он; работнику незачем, у него своя работа на экране.
router.get('/', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const includeResolved = req.query.all === '1';

    const data = await withTenantContext({ warehouseId }, async (client) => {
      const rows = await client.query(
        `SELECT id, alert_key, text, created_at, resolved_at, seen_at
         FROM alerts
         WHERE warehouse_id = $1 ${includeResolved ? '' : 'AND resolved_at IS NULL'}
         ORDER BY created_at DESC
         LIMIT 50`,
        [warehouseId],
      );
      // Когда сторож проходил в последний раз. Без этого «тревог нет» и
      // «проверка не работает» выглядят снаружи одинаково.
      const run = await client.query(
        `SELECT last_run_at FROM alert_runs WHERE warehouse_id = $1`,
        [warehouseId],
      );
      return { alerts: rows.rows, lastCheckedAt: run.rows[0]?.last_run_at || null };
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Прочитано. На то, появится ли тревога снова, это не влияет: она вернётся,
// если причина не ушла, — иначе «скрыть» превратилось бы в способ не чинить.
router.post('/:id/seen', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { id } = req.params;
    const updated = await withTenantContext({ warehouseId }, (client) => client.query(
      `UPDATE alerts SET seen_at = now()
       WHERE id = $1 AND warehouse_id = $2 AND seen_at IS NULL
       RETURNING id`,
      [id, warehouseId],
    ));
    if (updated.rowCount === 0) {
      // Либо чужая, либо уже прочитана — для клиента это одно и то же.
      throw new HttpError(404, 'Сообщение не найдено');
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// «Сегодня» — четыре цифры на первом экране владельца (отчёт рецензии 03.10,
// раздел 30): что отгрузить, что принять, что ждёт его решения, что не так с
// обменом. Только числа: каждое открывает уже существующий список. Работа
// считается тем же правилом, что у грузчика и Кладовщика (workQueue), обмен —
// по живым тревогам сторожа, чтобы «1С молчит» не считалось вторым способом.
router.get('/today', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { workQueue } = require('../agents/kladovshchik');
    const data = await withTenantContext({ warehouseId }, async (client) => {
      const work = await workQueue(client, warehouseId);
      const d = (await client.query(
        `SELECT
           (SELECT count(*)::int FROM journal_entries je
             WHERE je.warehouse_id = $1 AND je.status = 'pending'
               -- Заявка клиента на перенос считается ниже (seller_requests) —
               -- здесь её не повторяем (проверка 05.10).
               AND je.entity_type IS DISTINCT FROM 'vw_transfer'
               AND NOT EXISTS (SELECT 1 FROM journal_entries a WHERE a.related_entry_id = je.id)) AS discrepancies,
           (SELECT count(*)::int FROM vw_transfers WHERE warehouse_id = $1 AND status = 'requested') AS seller_requests,
           (SELECT count(*)::int FROM inventory_tasks WHERE warehouse_id = $1 AND status = 'waiting_owner') AS recounts,
           (SELECT count(DISTINCT i.id)::int FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
              JOIN companies c ON c.id = i.company_id AND c.archived_at IS NULL
             WHERE i.warehouse_id = $1 AND i.direction = 'out' AND i.source = 'wb' AND i.supply_id IS NULL
               AND i.status <> 'shipped' AND i.mp_closed_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM products p WHERE p.warehouse_id = ii.warehouse_id
                                 AND p.company_id = ii.company_id AND p.sku = ii.sku)) AS wb_unmapped`,
        [warehouseId],
      )).rows[0];
      const wbOver = await require('../sellers/stock').wbOverBySeller(client, warehouseId);
      const sync = (await client.query(
        `SELECT text FROM alerts WHERE warehouse_id = $1 AND resolved_at IS NULL AND alert_key LIKE 'sync\\_%'
          ORDER BY created_at`, [warehouseId])).rows.map((r) => r.text);
      return {
        ship: { supplies: work.suppliesToPick, orders: work.ordersToPick, ready: work.suppliesReady, onec: work.onecToPick },
        receive: { arrivals: work.toReceive, arrived: work.arrived, returns: work.returnsToSort },
        decide: { discrepancies: d.discrepancies, sellerRequests: d.seller_requests, recounts: d.recounts },
        exchange: { sync, wbUnmapped: d.wb_unmapped, wbOver },
      };
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Прогнать проверку прямо сейчас — для отладки и для тестов, чтобы не ждать
// десять минут до следующего прохода.
router.post('/check', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const result = await withTenantContext({ warehouseId }, async (client) => {
      const r = await runner.checkWarehouse(client, warehouseId);
      await runner.maybeDigest(client, warehouseId);
      return r;
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
