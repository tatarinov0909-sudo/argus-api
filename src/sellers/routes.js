const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const { transliteratePrefix } = require('../auth/service');

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
