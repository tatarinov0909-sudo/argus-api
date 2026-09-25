const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');

// Акты по шаблонам владельца (24.09.2026): «Акт приёмки на хранение» — по
// приходу, «Акт отгрузки с хранения» — по поставке. Здесь только данные;
// бумагу рисует act_print.html. Короба и паллеты Аргус не считает — в акте
// эти клетки заполняют руками.
const router = express.Router();

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const barcodeOf = (name) => (String(name || '').match(/(\d{8,14})\s*$/) || [])[1] || null;

async function warehouseOf(client, warehouseId) {
  const w = (await client.query('SELECT name, city, legal_name FROM warehouses WHERE id = $1', [warehouseId])).rows[0];
  return { name: w.name, city: w.city, legalName: w.legal_name };
}

// Продавец тоже получает акт приёмки — по своему приходу.
router.get('/receipt/:id', requireAuth, requireRole('owner', 'manager', 'seller'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    if (!uuid.test(req.params.id)) throw new HttpError(400, 'Некорректный номер прихода');
    const out = await withTenantContext({ warehouseId }, async (c) => {
      const inv = (await c.query(
        `SELECT i.id, i.number, i.direction, i.status, i.created_at, i.company_id, c.name AS seller
           FROM invoices i JOIN companies c ON c.id = i.company_id
          WHERE i.warehouse_id = $1 AND i.id = $2`, [warehouseId, req.params.id])).rows[0];
      if (!inv || (req.auth.role === 'seller' && inv.company_id !== req.auth.companyId)) {
        throw new HttpError(404, 'Приход не найден');
      }
      if (inv.direction !== 'in') throw new HttpError(400, 'Акт приёмки — только по приходу');
      const items = (await c.query(
        `SELECT ii.sku, ii.name, ii.declared_qty,
                (SELECT SUM(rr.accepted_qty) FROM receiving_records rr WHERE rr.invoice_item_id = ii.id) AS accepted,
                (SELECT MAX(rr.finished_at) FROM receiving_records rr WHERE rr.invoice_item_id = ii.id) AS accepted_at,
                p.barcode, m.mp_article
           FROM invoice_items ii
           LEFT JOIN products p ON p.warehouse_id = ii.warehouse_id AND p.company_id = ii.company_id AND p.sku = ii.sku
           LEFT JOIN LATERAL (SELECT mp_article FROM product_marketplace_skus m
                               WHERE m.company_id = ii.company_id AND m.sku = ii.sku AND m.mp_article IS NOT NULL
                               LIMIT 1) m ON true
          WHERE ii.invoice_id = $1 ORDER BY ii.name`, [inv.id])).rows;
      const acceptedAt = items.map((i) => i.accepted_at).filter(Boolean).sort().pop() || null;
      return {
        kind: 'receipt',
        number: inv.number,
        date: acceptedAt || inv.created_at,
        finished: inv.status === 'completed',
        seller: inv.seller,
        warehouse: await warehouseOf(c, warehouseId),
        items: items.map((i) => ({
          article: i.mp_article || i.sku,
          sku: i.sku,
          name: i.name,
          barcode: i.barcode || barcodeOf(i.name),
          // Принято по факту; пока не принято — заявленное, и акт так и помечен.
          qty: i.accepted === null ? Number(i.declared_qty) : Number(i.accepted),
          declared: Number(i.declared_qty),
          accepted: i.accepted !== null,
        })),
      };
    });
    res.json(out);
  } catch (err) { next(err); }
});

router.get('/shipment/:supplyId', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    if (!uuid.test(req.params.supplyId)) throw new HttpError(400, 'Некорректный номер поставки');
    const out = await withTenantContext({ warehouseId }, async (c) => {
      const s = (await c.query(
        `SELECT s.id, s.number, s.status, s.destination, s.ship_date, s.shipped_at, s.created_at, c.name AS seller
           FROM supplies s JOIN companies c ON c.id = s.company_id
          WHERE s.warehouse_id = $1 AND s.id = $2`, [warehouseId, req.params.supplyId])).rows[0];
      if (!s) throw new HttpError(404, 'Поставка не найдена');
      const items = (await c.query(
        `SELECT ii.sku, max(ii.name) AS name, max(ii.mp_article) AS article, max(ii.mp_barcode) AS barcode,
                max(p.barcode) AS product_barcode, SUM(ii.declared_qty) AS qty
           FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
           LEFT JOIN products p ON p.warehouse_id = ii.warehouse_id AND p.company_id = ii.company_id AND p.sku = ii.sku
          WHERE i.supply_id = $1
          GROUP BY ii.sku ORDER BY max(ii.name)`, [s.id])).rows;
      return {
        kind: 'shipment',
        number: s.number,
        date: s.shipped_at || s.ship_date || s.created_at,
        shipped: s.status === 'shipped',
        seller: s.seller,
        warehouse: await warehouseOf(c, warehouseId),
        // Грузополучатель — сортировочный центр WB, куда уходит поставка.
        consignee: 'Wildberries',
        consigneeAddress: s.destination || null,
        items: items.map((i) => ({
          article: i.article || i.sku,
          sku: i.sku,
          name: i.name,
          barcode: i.barcode || i.product_barcode || barcodeOf(i.name),
          qty: Number(i.qty),
        })),
      };
    });
    res.json(out);
  } catch (err) { next(err); }
});

module.exports = router;
