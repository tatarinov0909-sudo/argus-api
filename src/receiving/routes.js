const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const { refreshCellFill } = require('../cells/fill');
const journal = require('../journal/repository');
const kladovshchik = require('../agents/kladovshchik');
const outbox = require('../sync/outbox');

const router = express.Router();

// Worker submits one line item: actual quantity, which cell it went into
// (nullable — "своё место" text-only entries aren't tied to a real
// cell_block yet, matching today's mockup), and the pause tally the
// client already tracked locally during the session.
router.post('/', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const {
      invoiceItemId, acceptedQty, cellBlockId, pausedMs, pauseReasons, suggestionId,
    } = req.body;
    if (!invoiceItemId || acceptedQty == null) {
      throw new HttpError(400, 'Не хватает данных о принятой позиции');
    }

    const record = await withTenantContext({ warehouseId }, async (client) => {
      // Invoice and company are joined in for the sync payload, so the outbox
      // row carries the 1C identifiers without a second round trip.
      const itemResult = await client.query(
        `SELECT ii.id, ii.name, ii.sku, ii.declared_qty, ii.company_id, ii.invoice_id,
                ii.external_id,
                i.number AS invoice_number, i.external_id AS invoice_external_id,
                c.external_id AS company_external_id
         FROM invoice_items ii
         JOIN invoices i ON i.id = ii.invoice_id
         JOIN companies c ON c.id = ii.company_id
         WHERE ii.id = $1 AND ii.warehouse_id = $2`,
        [invoiceItemId, warehouseId],
      );
      const item = itemResult.rows[0];
      if (!item) throw new HttpError(404, 'Позиция накладной не найдена');

      const existing = await client.query(
        `SELECT id FROM receiving_records WHERE invoice_item_id = $1`,
        [invoiceItemId],
      );
      if (existing.rows[0]) throw new HttpError(409, 'Эта позиция уже принята');

      if (cellBlockId) {
        const blockResult = await client.query(
          `SELECT id FROM cell_blocks WHERE id = $1 AND warehouse_id = $2`,
          [cellBlockId, warehouseId],
        );
        if (!blockResult.rows[0]) throw new HttpError(404, 'Ячейка не найдена');

        await client.query(
          `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty)
           VALUES ($1, $2, $3, $4, $5)`,
          [cellBlockId, warehouseId, item.company_id, item.sku, acceptedQty],
        );
        // Процент считается от того, сколько штук в ячейке, а не ставится в
        // сотню при любом приходе: иначе ячейка с пятью штуками горит на карте
        // так же, как забитая под завязку.
        await refreshCellFill(client, cellBlockId);
      }

      const recordResult = await client.query(
        `INSERT INTO receiving_records
           (invoice_item_id, warehouse_id, company_id, accepted_qty, cell_block_id,
            worker_key_id, finished_at, paused_ms, pause_reasons)
         VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8)
         RETURNING id, accepted_qty, finished_at, paused_ms, pause_reasons`,
        [
          invoiceItemId, warehouseId, item.company_id, acceptedQty, cellBlockId || null,
          staffKeyId, pausedMs || 0, JSON.stringify(pauseReasons || []),
        ],
      );

      const hasDiscrepancy = Number(acceptedQty) !== Number(item.declared_qty);
      const actionText = hasDiscrepancy
        ? `Нашёл расхождение по «${item.name}» (${item.sku}): заявлено ${item.declared_qty}, по факту ${acceptedQty}.`
        : `Принял «${item.name}» (${item.sku}) по факту ${acceptedQty} — расхождений не найдено.`;
      await journal.createEntry(client, {
        warehouseId,
        agent: 'Кладовщик',
        actionText,
        entityType: 'invoice_item',
        entityId: invoiceItemId,
        invoiceId: item.invoice_id,
        cellBlockId: cellBlockId || null,
        actorType: 'worker',
        actorId: staffKeyId,
        status: hasDiscrepancy ? 'pending' : 'auto',
      });

      // Same transaction as the stock movement above — a receiving record can
      // never exist without the event that tells 1C about it.
      await outbox.appendReceiving(client, {
        warehouseId,
        item,
        invoice: {
          id: item.invoice_id,
          number: item.invoice_number,
          external_id: item.invoice_external_id,
        },
        company: { id: item.company_id, external_id: item.company_external_id },
        actualQty: acceptedQty,
      });

      // Чем кончилась подсказка: согласился работник или положил по-своему.
      // Выводов пока никаких — сначала факты, потом правило.
      await kladovshchik.recordSuggestionOutcome(client, warehouseId, suggestionId, cellBlockId);

      const remaining = await client.query(
        `SELECT COUNT(*)::int AS n FROM invoice_items ii
         WHERE ii.invoice_id = $1 AND NOT EXISTS (
           SELECT 1 FROM receiving_records rr WHERE rr.invoice_item_id = ii.id
         )`,
        [item.invoice_id],
      );
      const newStatus = remaining.rows[0].n === 0 ? 'completed' : 'in_progress';
      await client.query(`UPDATE invoices SET status = $2 WHERE id = $1`, [item.invoice_id, newStatus]);

      return recordResult.rows[0];
    });
    res.status(201).json(record);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
