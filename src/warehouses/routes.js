const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');

const router = express.Router();

router.get('/me', requireAuth, requireRole('owner', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const warehouse = await withTenantContext({ warehouseId }, async (client) => {
      const result = await client.query(
        `SELECT id, name, city, warehouse_code, created_at FROM warehouses WHERE id = $1`,
        [warehouseId],
      );
      return result.rows[0];
    });
    if (!warehouse) return res.status(404).json({ error: 'Склад не найден' });
    res.json(warehouse);
  } catch (err) {
    next(err);
  }
});

router.patch('/me', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { name, city } = req.body;
    const warehouse = await withTenantContext({ warehouseId }, async (client) => {
      const result = await client.query(
        `UPDATE warehouses SET name = COALESCE($2, name), city = COALESCE($3, city)
         WHERE id = $1 RETURNING id, name, city, warehouse_code`,
        [warehouseId, name ?? null, city ?? null],
      );
      return result.rows[0];
    });
    res.json(warehouse);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
