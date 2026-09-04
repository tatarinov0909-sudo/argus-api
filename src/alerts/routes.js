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
