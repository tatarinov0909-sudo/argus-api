const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');

const router = express.Router();

router.get('/', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const rows = await withTenantContext({ warehouseId }, async (client) => {
      const result = await client.query(
        `SELECT id, key_code, name, active, issued_at, revoked_at
         FROM staff_keys WHERE warehouse_id = $1 ORDER BY issued_at ASC`,
        [warehouseId],
      );
      return result.rows;
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { name } = req.body;
    if (!name || !name.trim()) throw new HttpError(400, 'Введите имя сотрудника');

    const key = await withTenantContext({ warehouseId }, async (client) => {
      const whResult = await client.query(`SELECT warehouse_code FROM warehouses WHERE id = $1`, [warehouseId]);
      const code = whResult.rows[0].warehouse_code;

      const countResult = await client.query(
        `SELECT COUNT(*)::int AS n FROM staff_keys WHERE warehouse_id = $1`,
        [warehouseId],
      );
      const seq = countResult.rows[0].n + 1;
      const keyCode = `${code}-${String(seq).padStart(2, '0')}`;

      const insertResult = await client.query(
        `INSERT INTO staff_keys (warehouse_id, key_code, name)
         VALUES ($1, $2, $3) RETURNING id, key_code, name, active, issued_at`,
        [warehouseId, keyCode, name.trim()],
      );
      return insertResult.rows[0];
    });
    res.status(201).json(key);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/toggle', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { id } = req.params;

    const key = await withTenantContext({ warehouseId }, async (client) => {
      const result = await client.query(
        `UPDATE staff_keys
         SET active = NOT active, revoked_at = CASE WHEN active THEN now() ELSE NULL END
         WHERE id = $1 AND warehouse_id = $2
         RETURNING id, key_code, name, active, issued_at, revoked_at`,
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
