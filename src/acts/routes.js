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
      // Последний день приёмки — сравниваем время, а не текст даты: «Thu Oct 01»
      // как текст раньше «Wed Sep 30» (проверка 25.09.2026).
      const acceptedAt = items.map((i) => i.accepted_at).filter(Boolean)
        .reduce((last, d) => (!last || new Date(d) > new Date(last) ? d : last), null);
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
        `SELECT s.id, s.number, s.status, s.destination, to_char(s.ship_date, 'YYYY-MM-DD') AS ship_date, s.shipped_at, s.created_at, c.name AS seller
           FROM supplies s JOIN companies c ON c.id = s.company_id
          WHERE s.warehouse_id = $1 AND s.id = $2`, [warehouseId, req.params.supplyId])).rows[0];
      if (!s) throw new HttpError(404, 'Поставка не найдена');
      const items = (await c.query(
        `SELECT ii.sku, max(ii.name) AS name, max(ii.mp_article) AS article, max(ii.mp_barcode) AS barcode,
                max(p.barcode) AS product_barcode, SUM(ii.declared_qty) AS declared,
                COALESCE(SUM(sr.picked), 0) AS picked
           FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
           LEFT JOIN products p ON p.warehouse_id = ii.warehouse_id AND p.company_id = ii.company_id AND p.sku = ii.sku
           LEFT JOIN LATERAL (SELECT SUM(picked_qty) AS picked FROM shipping_records
                               WHERE invoice_item_id = ii.id) sr ON true
          WHERE i.supply_id = $1
          GROUP BY ii.sku ORDER BY max(ii.name)`, [s.id])).rows;
      // Уехавшая поставка — сколько собрано и увезено: позицию закрывают и с
      // нехваткой («взяли 3 из 5»), а акт — юридическая бумага (проверка
      // 25.09.2026). До отгрузки акт — план, по заказам.
      const shipped = s.status === 'shipped';
      return {
        kind: 'shipment',
        number: s.number,
        date: s.shipped_at || s.ship_date || s.created_at,
        shipped,
        seller: s.seller,
        warehouse: await warehouseOf(c, warehouseId),
        // Грузополучатель — сортировочный центр WB, куда уходит поставка.
        consignee: 'Wildberries',
        consigneeAddress: s.destination || null,
        items: items.filter((i) => !shipped || Number(i.picked) > 0).map((i) => ({
          article: i.article || i.sku,
          sku: i.sku,
          name: i.name,
          barcode: i.barcode || i.product_barcode || barcodeOf(i.name),
          qty: Number(shipped ? i.picked : i.declared),
          declared: Number(i.declared),
        })),
      };
    });
    res.json(out);
  } catch (err) { next(err); }
});

module.exports = router;
