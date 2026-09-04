const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const { refreshCellFill } = require('../cells/fill');
const journal = require('../journal/repository');

const router = express.Router();

const BUCKET_LABEL = {
  good: 'хороший товар',
  defective: 'брак',
  packaging_defect: 'брак упаковки',
};

// Worker records one quality-bucket split of a return line: how much of it
// is good/defective/packaging-damaged, and — for a bucket the owner shelves —
// which cell it went into. A single declared line is closed over one or more
// of these calls (one per bucket), mirroring how a shipping pick is closed
// over one call per cell visited.
router.post('/', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const {
      invoiceItemId, qty, qualityBucket, cellBlockId, pausedMs, pauseReasons, defectNote,
    } = req.body;
    if (!invoiceItemId || qty == null || !qualityBucket) {
      throw new HttpError(400, 'Нужны позиция накладной, количество и категория качества');
    }
    if (!BUCKET_LABEL[qualityBucket]) {
      throw new HttpError(400, 'Категория качества может быть good, defective или packaging_defect');
    }
    if (Number(qty) <= 0) {
      throw new HttpError(400, 'Количество должно быть больше нуля');
    }
    // Описание дефекта — свободный текст работника, поэтому режем длину:
    // в журнал и продавцу это уходит целиком, и полотно там никому не нужно.
    const note = typeof defectNote === 'string' ? defectNote.trim().slice(0, 300) : null;

    const record = await withTenantContext({ warehouseId }, async (client) => {
      const itemResult = await client.query(
        `SELECT ii.id, ii.name, ii.sku, ii.declared_qty, ii.company_id, ii.invoice_id,
                i.direction
         FROM invoice_items ii
         JOIN invoices i ON i.id = ii.invoice_id
         WHERE ii.id = $1 AND ii.warehouse_id = $2`,
        [invoiceItemId, warehouseId],
      );
      const item = itemResult.rows[0];
      if (!item) throw new HttpError(404, 'Позиция накладной не найдена');
      if (item.direction !== 'return') {
        throw new HttpError(400, 'Эта накладная не на возврат');
      }

      const soFar = await client.query(
        `SELECT COALESCE(SUM(qty), 0) AS total FROM return_records WHERE invoice_item_id = $1`,
        [invoiceItemId],
      );
      const alreadyLogged = Number(soFar.rows[0].total);
      const declared = Number(item.declared_qty);
      if (alreadyLogged + Number(qty) > declared) {
        throw new HttpError(
          409,
          `По позиции заявлено ${declared}, уже разобрано ${alreadyLogged} — нельзя добавить ещё ${qty}`,
        );
      }

      if (cellBlockId) {
        const blockResult = await client.query(
          `SELECT id FROM cell_blocks WHERE id = $1 AND warehouse_id = $2`,
          [cellBlockId, warehouseId],
        );
        if (!blockResult.rows[0]) throw new HttpError(404, 'Ячейка не найдена');

        // Состояние едет в остаток вместе с количеством: брак на полке обязан
        // отличаться от годного, иначе отгрузка предложит его клиенту.
        await client.query(
          `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty, quality)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [cellBlockId, warehouseId, item.company_id, item.sku, qty, qualityBucket],
        );
        await refreshCellFill(client, cellBlockId);
      }

      const recordResult = await client.query(
        `INSERT INTO return_records
           (invoice_item_id, warehouse_id, company_id, quality_bucket, qty, cell_block_id,
            worker_key_id, paused_ms, pause_reasons, defect_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, quality_bucket, qty, cell_block_id, finished_at, paused_ms, defect_note`,
        [
          invoiceItemId, warehouseId, item.company_id, qualityBucket, qty, cellBlockId || null,
          staffKeyId, pausedMs || 0, JSON.stringify(pauseReasons || []), note || null,
        ],
      );

      const newTotal = alreadyLogged + Number(qty);
      await journal.createEntry(client, {
        warehouseId,
        agent: 'Кладовщик',
        // Причина едет в журнал вместе с количеством: владельцу и продавцу
        // «2 шт брак» без причины решать не помогает.
        actionText: `Разобрал возврат «${item.name}» (${item.sku}): ${qty} шт. — ${BUCKET_LABEL[qualityBucket]}.`
          + (note ? ` Дефект: ${note}` : ''),
        entityType: 'invoice_item',
        entityId: invoiceItemId,
        actorType: 'worker',
        actorId: staffKeyId,
        status: 'auto',
      });

      // The line is done when every declared unit has been sorted into a
      // bucket — same completion shape as receiving (one line closes when its
      // quantity is fully accounted for), generalized to a sum since a return
      // line can take several calls instead of one.
      const remaining = await client.query(
        `SELECT ii.id, ii.declared_qty, COALESCE(SUM(rr.qty), 0) AS total
         FROM invoice_items ii
         LEFT JOIN return_records rr ON rr.invoice_item_id = ii.id
         WHERE ii.invoice_id = $1
         GROUP BY ii.id, ii.declared_qty
         HAVING COALESCE(SUM(rr.qty), 0) < ii.declared_qty`,
        [item.invoice_id],
      );
      const newStatus = remaining.rows.length === 0 ? 'completed' : 'in_progress';
      await client.query(`UPDATE invoices SET status = $2 WHERE id = $1`, [item.invoice_id, newStatus]);

      return { ...recordResult.rows[0], newTotal, declaredQty: declared };
    });
    res.status(201).json(record);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
