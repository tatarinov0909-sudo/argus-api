const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const { tenantContextFromAuth } = require('../auth/tenantContext');

const router = express.Router();

// Numeric-but-optional fields: absent means "unknown", which is different from
// zero. Reject a value that is present but not a usable number so a typo in the
// 1C card can't quietly become 0 mm and make everything look like it fits.
function optionalNumber(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new HttpError(400, `Поле «${field}» должно быть неотрицательным числом`);
  }
  return n;
}

// Owner and workers see the whole warehouse catalogue; a seller sees only their
// own goods — enforced by RLS via tenantContextFromAuth, not by this query.
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const ctx = tenantContextFromAuth(req.auth);
    const { companyId, includeInactive } = req.query;

    const rows = await withTenantContext(ctx, async (client) => {
      const result = await client.query(
        `SELECT p.id, p.company_id, c.name AS company_name, p.sku, p.name, p.category,
                p.length_mm, p.width_mm, p.height_mm, p.weight_g,
                p.active, p.external_id, p.created_at, p.updated_at
         FROM products p
         JOIN companies c ON c.id = p.company_id
         WHERE ($1::uuid IS NULL OR p.company_id = $1::uuid)
           AND ($2::boolean IS TRUE OR p.active = true)
         ORDER BY c.name, p.name`,
        [companyId || null, includeInactive === 'true'],
      );
      return result.rows;
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Manual entry — the same stand-in role the manual invoice form plays until
// the 1C module exists. Rows created here carry no external_id; the sync will
// later match them by (company, sku) and fill it in.
router.post('/', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const {
      companyId, sku, name, category,
      lengthMm, widthMm, heightMm, weightG, externalId,
    } = req.body;

    if (!companyId || !sku || !sku.trim() || !name || !name.trim()) {
      throw new HttpError(400, 'Укажите компанию, артикул и название товара');
    }
    const dims = {
      length_mm: optionalNumber(lengthMm, 'длина'),
      width_mm: optionalNumber(widthMm, 'ширина'),
      height_mm: optionalNumber(heightMm, 'высота'),
      weight_g: optionalNumber(weightG, 'вес'),
    };

    const product = await withTenantContext({ warehouseId }, async (client) => {
      const companyResult = await client.query(
        `SELECT id FROM companies WHERE id = $1 AND warehouse_id = $2`,
        [companyId, warehouseId],
      );
      if (!companyResult.rows[0]) throw new HttpError(404, 'Компания не найдена');

      const existing = await client.query(
        `SELECT id FROM products WHERE warehouse_id = $1 AND company_id = $2 AND sku = $3`,
        [warehouseId, companyId, sku.trim()],
      );
      if (existing.rows[0]) {
        throw new HttpError(409, 'Товар с таким артикулом у этой компании уже есть');
      }

      const result = await client.query(
        `INSERT INTO products
           (warehouse_id, company_id, sku, name, category,
            length_mm, width_mm, height_mm, weight_g, external_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, company_id, sku, name, category,
                   length_mm, width_mm, height_mm, weight_g,
                   active, external_id, created_at, updated_at`,
        [
          warehouseId, companyId, sku.trim(), name.trim(), category?.trim() || null,
          dims.length_mm, dims.width_mm, dims.height_mm, dims.weight_g,
          externalId || null,
        ],
      );
      return result.rows[0];
    });
    res.status(201).json(product);
  } catch (err) {
    next(err);
  }
});

// Partial update. sku is deliberately not editable: it is the key that ties a
// product to stock and to historical invoice lines, and renaming it here would
// silently orphan both.
router.patch('/:id', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { id } = req.params;
    const {
      name, category, lengthMm, widthMm, heightMm, weightG, active, externalId,
    } = req.body;

    const fields = [];
    const values = [];
    const push = (column, value) => {
      values.push(value);
      fields.push(`${column} = $${values.length}`);
    };

    if (name !== undefined) {
      if (!name || !name.trim()) throw new HttpError(400, 'Название не может быть пустым');
      push('name', name.trim());
    }
    if (category !== undefined) push('category', category?.trim() || null);
    if (lengthMm !== undefined) push('length_mm', optionalNumber(lengthMm, 'длина'));
    if (widthMm !== undefined) push('width_mm', optionalNumber(widthMm, 'ширина'));
    if (heightMm !== undefined) push('height_mm', optionalNumber(heightMm, 'высота'));
    if (weightG !== undefined) push('weight_g', optionalNumber(weightG, 'вес'));
    if (active !== undefined) push('active', Boolean(active));
    if (externalId !== undefined) push('external_id', externalId || null);

    if (fields.length === 0) throw new HttpError(400, 'Нечего обновлять');
    fields.push('updated_at = now()');

    const product = await withTenantContext({ warehouseId }, async (client) => {
      values.push(id, warehouseId);
      const result = await client.query(
        `UPDATE products SET ${fields.join(', ')}
         WHERE id = $${values.length - 1} AND warehouse_id = $${values.length}
         RETURNING id, company_id, sku, name, category,
                   length_mm, width_mm, height_mm, weight_g,
                   active, external_id, created_at, updated_at`,
        values,
      );
      return result.rows[0] || null;
    });
    if (!product) throw new HttpError(404, 'Товар не найден');
    res.json(product);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
