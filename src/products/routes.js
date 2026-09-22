const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const { tenantContextFromAuth } = require('../auth/tenantContext');
const journal = require('../journal/repository');

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
         JOIN companies c ON c.id = p.company_id AND c.archived_at IS NULL
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

// Новый товар — заводится в Аргусе, не дожидаясь 1С (решение владельца 22.09).
// Карточка без external_id; когда такой же артикул того же продавца придёт из
// 1С, обмен сам свяжет их (sync/service.js, «adoption»). Заводит владелец или
// менеджер: приход товара открыт обоим, и новый товар часто появляется
// именно на приходе.
router.post('/', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { warehouseId, role, ownerId, staffKeyId } = req.auth;
    const {
      companyId, sku, name, category, barcode,
      lengthMm, widthMm, heightMm, weightG, externalId,
    } = req.body;

    if (!companyId || typeof sku !== 'string' || !sku.trim() || typeof name !== 'string' || !name.trim()) {
      throw new HttpError(400, 'Укажите продавца, артикул и название товара');
    }
    if (sku.trim().length > 100 || name.trim().length > 300) {
      throw new HttpError(400, 'Артикул — до 100 знаков, название — до 300');
    }
    const code = typeof barcode === 'string' && barcode.trim() ? barcode.trim() : null;
    if (code && !/^[0-9A-Za-z-]{4,64}$/.test(code)) {
      throw new HttpError(400, 'Штрихкод — цифры (или латиница), от 4 до 64 знаков');
    }
    const dims = {
      length_mm: optionalNumber(lengthMm, 'длина'),
      width_mm: optionalNumber(widthMm, 'ширина'),
      height_mm: optionalNumber(heightMm, 'высота'),
      weight_g: optionalNumber(weightG, 'вес'),
    };

    const product = await withTenantContext({ warehouseId }, async (client) => {
      const companyResult = await client.query(
        `SELECT id, name FROM companies WHERE id::text = $1 AND warehouse_id = $2 AND archived_at IS NULL`,
        [String(companyId), warehouseId],
      );
      if (!companyResult.rows[0]) throw new HttpError(404, 'Продавец не найден');

      // Без учёта регистра: «pb000021144» и «PB000021144» — один товар, и две
      // карточки разделили бы его остаток и заказы надвое.
      const existing = await client.query(
        `SELECT id, sku, name FROM products WHERE warehouse_id = $1 AND company_id = $2 AND lower(sku) = lower($3)`,
        [warehouseId, companyId, sku.trim()],
      );
      if (existing.rows[0]) {
        throw new HttpError(409, `У этого продавца уже есть товар с артикулом ${existing.rows[0].sku} — «${existing.rows[0].name}»`);
      }

      const result = await client.query(
        `INSERT INTO products
           (warehouse_id, company_id, sku, name, category,
            length_mm, width_mm, height_mm, weight_g, external_id, barcode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id, company_id, sku, name, category, barcode,
                   length_mm, width_mm, height_mm, weight_g,
                   active, external_id, created_at, updated_at`,
        [
          warehouseId, companyId, sku.trim(), name.trim(), category?.trim() || null,
          dims.length_mm, dims.width_mm, dims.height_mm, dims.weight_g,
          // Связь с 1С ставит только обмен; руками — лишь владелец (так
          // заводили карточки до модуля 1С).
          role === 'owner' ? (externalId || null) : null, code,
        ],
      );
      await journal.createEntry(client, {
        warehouseId,
        agent: 'Кладовщик',
        actionText: `Заведён товар «${name.trim()}» (${sku.trim()}) продавца «${companyResult.rows[0].name}» — вручную в Аргусе. `
          + 'Когда такой артикул придёт из 1С, карточки свяжутся сами.',
        entityType: 'product',
        entityId: result.rows[0].id,
        actorType: role === 'manager' ? 'manager' : 'owner',
        actorId: role === 'manager' ? staffKeyId : ownerId,
      });
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
