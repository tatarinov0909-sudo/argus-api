const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const { tenantContextFromAuth } = require('../auth/tenantContext');

const router = express.Router();

// Owner, worker, and seller all hit this — RLS (via tenantContextFromAuth)
// is what actually narrows a seller down to their own company's invoices.
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const ctx = tenantContextFromAuth(req.auth);
    const rows = await withTenantContext(ctx, async (client) => {
      const result = await client.query(
        `SELECT i.id, i.number, i.status, i.created_at, i.company_id, c.name AS company_name
         FROM invoices i JOIN companies c ON c.id = i.company_id
         ORDER BY i.created_at DESC`,
      );
      return result.rows;
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const ctx = tenantContextFromAuth(req.auth);
    const { id } = req.params;

    const invoice = await withTenantContext(ctx, async (client) => {
      const invoiceResult = await client.query(
        `SELECT i.id, i.number, i.status, i.created_at, i.company_id, c.name AS company_name
         FROM invoices i JOIN companies c ON c.id = i.company_id WHERE i.id = $1`,
        [id],
      );
      const inv = invoiceResult.rows[0];
      if (!inv) return null;

      const itemsResult = await client.query(
        `SELECT ii.id, ii.name, ii.sku, ii.declared_qty,
                rr.id AS receiving_id, rr.accepted_qty, rr.finished_at, rr.pause_reasons,
                cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end, wr.row_num
         FROM invoice_items ii
         LEFT JOIN receiving_records rr ON rr.invoice_item_id = ii.id
         LEFT JOIN cell_blocks cb ON cb.id = rr.cell_block_id
         LEFT JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
         WHERE ii.invoice_id = $1
         ORDER BY ii.id`,
        [id],
      );
      return { ...inv, items: itemsResult.rows };
    });
    if (!invoice) throw new HttpError(404, 'Накладная не найдена');
    res.json(invoice);
  } catch (err) {
    next(err);
  }
});

// Manual invoice entry — stands in for the 1C sync that doesn't exist yet.
router.post('/', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { companyId, number, items } = req.body;
    if (!companyId || !number || !Array.isArray(items) || items.length === 0) {
      throw new HttpError(400, 'Укажите компанию, номер накладной и хотя бы одну позицию');
    }
    for (const it of items) {
      if (!it.name || !it.sku || it.declaredQty == null) {
        throw new HttpError(400, 'У каждой позиции должны быть название, SKU и заявленное количество');
      }
    }

    const invoice = await withTenantContext({ warehouseId }, async (client) => {
      const companyResult = await client.query(
        `SELECT id FROM companies WHERE id = $1 AND warehouse_id = $2`,
        [companyId, warehouseId],
      );
      if (!companyResult.rows[0]) throw new HttpError(404, 'Компания не найдена');

      const invoiceResult = await client.query(
        `INSERT INTO invoices (warehouse_id, company_id, number) VALUES ($1, $2, $3)
         RETURNING id, number, status, created_at, company_id`,
        [warehouseId, companyId, number],
      );
      const inv = invoiceResult.rows[0];

      const createdItems = [];
      for (const it of items) {
        const itemResult = await client.query(
          `INSERT INTO invoice_items (invoice_id, warehouse_id, company_id, name, sku, declared_qty)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, sku, declared_qty`,
          [inv.id, warehouseId, companyId, it.name, it.sku, it.declaredQty],
        );
        createdItems.push(itemResult.rows[0]);
      }
      return { ...inv, items: createdItems };
    });
    res.status(201).json(invoice);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
