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
    // ?direction=in|out|return — the worker's receiving, picking, and returns
    // screens are separate views over the same table. Omitted means
    // "everything", so the owner's existing all-invoices list keeps working
    // untouched.
    const { direction } = req.query;
    if (direction && !['in', 'out', 'return'].includes(direction)) {
      throw new HttpError(400, 'direction может быть только in, out или return');
    }
    const rows = await withTenantContext(ctx, async (client) => {
      const result = await client.query(
        `SELECT i.id, i.number, i.status, i.direction, i.created_at, i.company_id,
                c.name AS company_name
         FROM invoices i JOIN companies c ON c.id = i.company_id
         WHERE ($1::invoice_direction IS NULL OR i.direction = $1::invoice_direction)
         ORDER BY i.created_at DESC`,
        [direction || null],
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
        `SELECT i.id, i.number, i.status, i.direction, i.created_at, i.company_id,
                c.name AS company_name
         FROM invoices i JOIN companies c ON c.id = i.company_id WHERE i.id = $1`,
        [id],
      );
      const inv = invoiceResult.rows[0];
      if (!inv) return null;

      // Returns aggregate like outbound does — one declared line can split
      // across several quality buckets, not just several cells.
      if (inv.direction === 'return') {
        const itemsResult = await client.query(
          `SELECT ii.id, ii.name, ii.sku, ii.declared_qty,
                  COALESCE(SUM(rr.qty), 0) AS returned_qty,
                  COALESCE(
                    json_agg(
                      json_build_object(
                        'id', rr.id,
                        'qty', rr.qty,
                        'qualityBucket', rr.quality_bucket,
                        'finishedAt', rr.finished_at
                      ) ORDER BY rr.finished_at
                    ) FILTER (WHERE rr.id IS NOT NULL),
                    '[]'
                  ) AS buckets
           FROM invoice_items ii
           LEFT JOIN return_records rr ON rr.invoice_item_id = ii.id
           WHERE ii.invoice_id = $1
           GROUP BY ii.id, ii.name, ii.sku, ii.declared_qty
           ORDER BY ii.id`,
          [id],
        );
        return { ...inv, items: itemsResult.rows };
      }

      // Inbound keeps the flat one-record-per-item shape it always had.
      // Outbound aggregates instead, because one line can be picked from
      // several cells (see the shipping migration for why).
      if (inv.direction === 'out') {
        const itemsResult = await client.query(
          `SELECT ii.id, ii.name, ii.sku, ii.declared_qty,
                  COALESCE(SUM(sr.picked_qty), 0) AS picked_qty,
                  COALESCE(BOOL_OR(sr.is_final), false) AS closed,
                  COALESCE(
                    json_agg(
                      json_build_object(
                        'id', sr.id,
                        'pickedQty', sr.picked_qty,
                        'finishedAt', sr.finished_at,
                        'rowNum', wr.row_num,
                        'rackStart', cb.rack_start,
                        'rackEnd', cb.rack_end,
                        'tierStart', cb.tier_start,
                        'tierEnd', cb.tier_end
                      ) ORDER BY sr.finished_at
                    ) FILTER (WHERE sr.id IS NOT NULL),
                    '[]'
                  ) AS picks
           FROM invoice_items ii
           LEFT JOIN shipping_records sr ON sr.invoice_item_id = ii.id
           LEFT JOIN cell_blocks cb ON cb.id = sr.cell_block_id
           LEFT JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
           WHERE ii.invoice_id = $1
           GROUP BY ii.id, ii.name, ii.sku, ii.declared_qty
           ORDER BY ii.id`,
          [id],
        );
        return { ...inv, items: itemsResult.rows };
      }

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
// Defaults to 'in' so every existing caller keeps creating receiving documents
// without change; pass direction:'out' to create a shipment order.
router.post('/', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { companyId, number, items, direction = 'in' } = req.body;
    if (!companyId || !number || !Array.isArray(items) || items.length === 0) {
      throw new HttpError(400, 'Укажите компанию, номер накладной и хотя бы одну позицию');
    }
    if (!['in', 'out', 'return'].includes(direction)) {
      throw new HttpError(400, 'direction может быть только in, out или return');
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
        `INSERT INTO invoices (warehouse_id, company_id, number, direction)
         VALUES ($1, $2, $3, $4)
         RETURNING id, number, status, direction, created_at, company_id`,
        [warehouseId, companyId, number, direction],
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
