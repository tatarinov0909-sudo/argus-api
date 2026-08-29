const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const { normalizeName } = require('../warehouses/naming');

const router = express.Router();

// Зон на складе столько же порядка, сколько рядов, и создаются они по одной
// вставке — потолок нужен только чтобы поймать опечатку.
const MAX_ZONES = 60;

router.get('/', requireAuth, requireRole('owner', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const zones = await withTenantContext({ warehouseId }, async (client) => {
      const result = await client.query(
        `SELECT dz.id, dz.zone_num, dz.label,
                COALESCE(json_agg(json_build_object(
                  'id', di.id, 'companyId', di.company_id, 'sku', di.sku, 'qty', di.qty, 'direction', di.direction
                ) ORDER BY di.created_at) FILTER (WHERE di.id IS NOT NULL), '[]') AS items
         FROM dropzones dz
         LEFT JOIN dropzone_items di ON di.dropzone_id = dz.id
         WHERE dz.warehouse_id = $1
         GROUP BY dz.id ORDER BY dz.zone_num ASC`,
        [warehouseId],
      );
      return result.rows;
    });
    res.json(zones);
  } catch (err) {
    next(err);
  }
});

// Replaces all zones — called alongside POST /api/cells/rows when the
// owner (re)builds the warehouse via the constructor or a document upload.
router.post('/', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { count, labels: rawLabels } = req.body;
    const zoneCount = Math.max(0, parseInt(count, 10) || 0);
    if (zoneCount > MAX_ZONES) throw new HttpError(400, `Зон не больше ${MAX_ZONES}`);

    // Имена приходят вместе с зонами из конструктора: человек называет их на
    // схеме, а не идёт переименовывать по одной после постройки.
    const given = Array.isArray(rawLabels) ? rawLabels : [];
    const labels = [];
    const seen = new Set();
    for (let i = 0; i < zoneCount; i++) {
      let label;
      try {
        label = normalizeName(given[i], { what: 'зоны' });
      } catch (err) {
        throw new HttpError(err.status || 400, `Зона ${i + 1}: ${err.message}`);
      }
      if (label) {
        const key = label.toLowerCase();
        if (seen.has(key)) throw new HttpError(409, `Зона ${i + 1}: имя «${label}» уже занято другой зоной`);
        seen.add(key);
      }
      labels.push(label);
    }

    const zones = await withTenantContext({ warehouseId }, async (client) => {
      await client.query(`DELETE FROM dropzones WHERE warehouse_id = $1`, [warehouseId]);
      const created = [];
      for (let i = 1; i <= zoneCount; i++) {
        const result = await client.query(
          `INSERT INTO dropzones (warehouse_id, zone_num, label) VALUES ($1, $2, $3)
           RETURNING id, zone_num, label`,
          [warehouseId, i, labels[i - 1]],
        );
        created.push({ ...result.rows[0], items: [] });
      }
      return created;
    });
    res.status(201).json(zones);
  } catch (err) {
    next(err);
  }
});

// Своё имя для зоны. Пустое имя стирает название и возвращает номер.
router.patch('/:zoneId/name', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { zoneId } = req.params;
    const label = normalizeName(req.body?.label, { what: 'зоны' });

    const zone = await withTenantContext({ warehouseId }, async (client) => {
      try {
        const result = await client.query(
          `UPDATE dropzones SET label = $3
           WHERE id = $1 AND warehouse_id = $2
           RETURNING id, zone_num, label`,
          [zoneId, warehouseId, label],
        );
        return result.rows[0] || null;
      } catch (err) {
        if (err.code === '23505') {
          throw new HttpError(409, `Зона с названием «${label}» уже есть`);
        }
        throw err;
      }
    });
    if (!zone) throw new HttpError(404, 'Зона не найдена');
    res.json(zone);
  } catch (err) {
    next(err);
  }
});

router.post('/:zoneId/items', requireAuth, requireRole('owner', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { zoneId } = req.params;
    const { companyId, sku, qty, direction } = req.body;
    if (!sku || qty == null || !['in', 'out'].includes(direction)) {
      throw new HttpError(400, 'Не хватает данных для позиции в зоне сортировки');
    }

    const item = await withTenantContext({ warehouseId }, async (client) => {
      const zoneResult = await client.query(
        `SELECT id FROM dropzones WHERE id = $1 AND warehouse_id = $2`,
        [zoneId, warehouseId],
      );
      if (!zoneResult.rows[0]) throw new HttpError(404, 'Зона не найдена');

      const result = await client.query(
        `INSERT INTO dropzone_items (dropzone_id, warehouse_id, company_id, sku, qty, direction)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, company_id, sku, qty, direction`,
        [zoneId, warehouseId, companyId || null, sku, qty, direction],
      );
      return result.rows[0];
    });
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
});

router.delete('/items/:itemId', requireAuth, requireRole('owner', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { itemId } = req.params;
    const deleted = await withTenantContext({ warehouseId }, async (client) => {
      const result = await client.query(
        `DELETE FROM dropzone_items WHERE id = $1 AND warehouse_id = $2 RETURNING id`,
        [itemId, warehouseId],
      );
      return result.rows[0];
    });
    if (!deleted) throw new HttpError(404, 'Позиция не найдена');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
