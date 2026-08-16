const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const journal = require('../journal/repository');
const outbox = require('../sync/outbox');

const router = express.Router();

// "Кладовщик подсказывает, откуда брать" — the outbound counterpart of
// receiving's cell suggestion. Receiving asks "where is there free space?";
// shipping asks "where does this SKU physically sit right now?", which we can
// answer exactly, because cell placement is our data (1C never knows about
// cells). Ordered by row/rack so the list doubles as a walking route rather
// than sending the worker back and forth across the warehouse.
router.get('/suggest/:invoiceItemId', requireAuth, requireRole('owner', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { invoiceItemId } = req.params;

    const suggestion = await withTenantContext({ warehouseId }, async (client) => {
      // Joined on the natural key rather than a FK — see the products
      // migration for why documents keep their own copy of name/sku. LEFT JOIN
      // because a line can reference a SKU that has no directory card yet
      // (hand-entered invoice, or 1C nomenclature not synced through).
      const itemResult = await client.query(
        `SELECT ii.id, ii.name, ii.sku, ii.declared_qty, ii.company_id,
                p.category, p.length_mm, p.width_mm, p.height_mm, p.weight_g
         FROM invoice_items ii
         LEFT JOIN products p
           ON p.warehouse_id = ii.warehouse_id
          AND p.company_id = ii.company_id
          AND p.sku = ii.sku
         WHERE ii.id = $1 AND ii.warehouse_id = $2`,
        [invoiceItemId, warehouseId],
      );
      const item = itemResult.rows[0];
      if (!item) throw new HttpError(404, 'Позиция накладной не найдена');

      const cellsResult = await client.query(
        `SELECT cs.cell_block_id, SUM(cs.qty) AS available,
                wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
         FROM cell_stock cs
         JOIN cell_blocks cb ON cb.id = cs.cell_block_id
         JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
         WHERE cs.warehouse_id = $1 AND cs.company_id = $2 AND cs.sku = $3 AND cs.qty > 0
         GROUP BY cs.cell_block_id, wr.row_num, cb.rack_start, cb.rack_end,
                  cb.tier_start, cb.tier_end
         HAVING SUM(cs.qty) > 0
         ORDER BY wr.row_num, cb.rack_start, cb.tier_start`,
        [warehouseId, item.company_id, item.sku],
      );

      const alreadyPicked = await client.query(
        `SELECT COALESCE(SUM(picked_qty), 0) AS picked
         FROM shipping_records WHERE invoice_item_id = $1`,
        [invoiceItemId],
      );

      const totalAvailable = cellsResult.rows
        .reduce((sum, r) => sum + Number(r.available), 0);
      const picked = Number(alreadyPicked.rows[0].picked);

      return {
        item: {
          id: item.id,
          name: item.name,
          sku: item.sku,
          declaredQty: Number(item.declared_qty),
          alreadyPicked: picked,
          remaining: Number(item.declared_qty) - picked,
          // null when the SKU has no directory card yet — the caller must treat
          // that as "unknown", not as "no packaging requirements".
          category: item.category,
          dimensions: item.length_mm === null && item.width_mm === null
            && item.height_mm === null && item.weight_g === null
            ? null
            : {
              lengthMm: item.length_mm === null ? null : Number(item.length_mm),
              widthMm: item.width_mm === null ? null : Number(item.width_mm),
              heightMm: item.height_mm === null ? null : Number(item.height_mm),
              weightG: item.weight_g === null ? null : Number(item.weight_g),
            },
        },
        totalAvailable,
        // Flagged up front so the worker learns the warehouse is short before
        // walking to the cells, not after.
        shortfall: Math.max(0, Number(item.declared_qty) - picked - totalAvailable),
        cells: cellsResult.rows.map((r) => ({
          cellBlockId: r.cell_block_id,
          available: Number(r.available),
          rowNum: r.row_num,
          rackStart: r.rack_start,
          rackEnd: r.rack_end,
          tierStart: r.tier_start,
          tierEnd: r.tier_end,
        })),
      };
    });
    res.json(suggestion);
  } catch (err) {
    next(err);
  }
});

// Worker records one pick: how much was taken out of which cell. Called once
// per cell visited, with isFinal on the last one to close the line item.
router.post('/', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const {
      invoiceItemId, pickedQty, cellBlockId, isFinal = true, pausedMs, pauseReasons,
    } = req.body;
    if (!invoiceItemId || pickedQty == null || !cellBlockId) {
      throw new HttpError(400, 'Нужны позиция накладной, количество и ячейка');
    }
    if (Number(pickedQty) <= 0) {
      throw new HttpError(400, 'Количество должно быть больше нуля');
    }

    const record = await withTenantContext({ warehouseId }, async (client) => {
      const itemResult = await client.query(
        `SELECT ii.id, ii.name, ii.sku, ii.declared_qty, ii.company_id, ii.invoice_id,
                ii.external_id,
                i.direction, i.number AS invoice_number,
                i.external_id AS invoice_external_id,
                c.external_id AS company_external_id
         FROM invoice_items ii
         JOIN invoices i ON i.id = ii.invoice_id
         JOIN companies c ON c.id = ii.company_id
         WHERE ii.id = $1 AND ii.warehouse_id = $2`,
        [invoiceItemId, warehouseId],
      );
      const item = itemResult.rows[0];
      if (!item) throw new HttpError(404, 'Позиция накладной не найдена');
      // Guard against a receiving invoice being picked as if it were a
      // shipment — that would silently drain stock that was just accepted.
      if (item.direction !== 'out') {
        throw new HttpError(400, 'Эта накладная не на отгрузку');
      }

      const closed = await client.query(
        `SELECT id FROM shipping_records WHERE invoice_item_id = $1 AND is_final = true`,
        [invoiceItemId],
      );
      if (closed.rows[0]) throw new HttpError(409, 'Эта позиция уже отгружена');

      // Lock the stock rows for this cell/sku so two workers picking the same
      // cell at once can't both pass the availability check and drive qty
      // negative — the second one waits here and then sees the real remainder.
      const stockResult = await client.query(
        `SELECT id, qty FROM cell_stock
         WHERE cell_block_id = $1 AND warehouse_id = $2 AND company_id = $3 AND sku = $4
           AND qty > 0
         ORDER BY updated_at
         FOR UPDATE`,
        [cellBlockId, warehouseId, item.company_id, item.sku],
      );
      const availableInCell = stockResult.rows
        .reduce((sum, r) => sum + Number(r.qty), 0);
      if (availableInCell <= 0) {
        throw new HttpError(409, 'В этой ячейке нет такого товара');
      }
      if (Number(pickedQty) > availableInCell) {
        throw new HttpError(
          409,
          `В ячейке только ${availableInCell}, нельзя забрать ${pickedQty}`,
        );
      }

      // Receiving INSERTs a fresh cell_stock row per acceptance, so one cell
      // can hold several rows for the same SKU. Draw down oldest-first.
      let toTake = Number(pickedQty);
      for (const row of stockResult.rows) {
        if (toTake <= 0) break;
        const take = Math.min(toTake, Number(row.qty));
        const left = Number(row.qty) - take;
        if (left === 0) {
          await client.query(`DELETE FROM cell_stock WHERE id = $1`, [row.id]);
        } else {
          await client.query(
            `UPDATE cell_stock SET qty = $2, updated_at = now() WHERE id = $1`,
            [row.id, left],
          );
        }
        toTake -= take;
      }

      // A block with nothing left in it goes back to being free space, so the
      // map and the receiving-side cell suggestions stay truthful.
      const remainingInBlock = await client.query(
        `SELECT COALESCE(SUM(qty), 0) AS qty FROM cell_stock WHERE cell_block_id = $1`,
        [cellBlockId],
      );
      if (Number(remainingInBlock.rows[0].qty) === 0) {
        await client.query(
          `UPDATE cell_blocks SET state = 'empty', fill_pct = 0, updated_at = now()
           WHERE id = $1`,
          [cellBlockId],
        );
      }

      const recordResult = await client.query(
        `INSERT INTO shipping_records
           (invoice_item_id, warehouse_id, company_id, picked_qty, cell_block_id,
            worker_key_id, is_final, finished_at, paused_ms, pause_reasons)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9)
         RETURNING id, picked_qty, cell_block_id, is_final, finished_at, paused_ms`,
        [
          invoiceItemId, warehouseId, item.company_id, pickedQty, cellBlockId,
          staffKeyId, isFinal, pausedMs || 0, JSON.stringify(pauseReasons || []),
        ],
      );

      const totalsResult = await client.query(
        `SELECT COALESCE(SUM(picked_qty), 0) AS picked
         FROM shipping_records WHERE invoice_item_id = $1`,
        [invoiceItemId],
      );
      const totalPicked = Number(totalsResult.rows[0].picked);
      const declared = Number(item.declared_qty);

      // Only a closed line can be short — a partial pick mid-walk is normal
      // and must not be reported to the owner as a discrepancy.
      const hasDiscrepancy = isFinal && totalPicked !== declared;
      const actionText = hasDiscrepancy
        ? `Расхождение при отгрузке «${item.name}» (${item.sku}): нужно ${declared}, собрано ${totalPicked}.`
        : `Собрал «${item.name}» (${item.sku}) — ${pickedQty} шт.${isFinal ? ` Позиция закрыта, итого ${totalPicked}.` : ''}`;
      await journal.createEntry(client, {
        warehouseId,
        agent: 'Кладовщик',
        actionText,
        entityType: 'invoice_item',
        entityId: invoiceItemId,
        actorType: 'worker',
        actorId: staffKeyId,
        status: hasDiscrepancy ? 'pending' : 'auto',
      });

      // Only on the pick that closes the line. A partial pick mid-walk is not a
      // completed movement — emitting one per cell visited would have 1C post
      // the same shipment two or three times.
      if (isFinal) {
        await outbox.appendShipping(client, {
          warehouseId,
          item,
          invoice: {
            id: item.invoice_id,
            number: item.invoice_number,
            external_id: item.invoice_external_id,
          },
          company: { id: item.company_id, external_id: item.company_external_id },
          actualQty: totalPicked,
        });
      }

      // The invoice is done when every line has been explicitly closed.
      const remaining = await client.query(
        `SELECT COUNT(*)::int AS n FROM invoice_items ii
         WHERE ii.invoice_id = $1 AND NOT EXISTS (
           SELECT 1 FROM shipping_records sr
           WHERE sr.invoice_item_id = ii.id AND sr.is_final = true
         )`,
        [item.invoice_id],
      );
      const newStatus = remaining.rows[0].n === 0 ? 'completed' : 'in_progress';
      await client.query(`UPDATE invoices SET status = $2 WHERE id = $1`, [item.invoice_id, newStatus]);

      return { ...recordResult.rows[0], totalPicked, declaredQty: declared };
    });
    res.status(201).json(record);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
