const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');

const router = express.Router();

// Full layout: rows -> blocks -> stock, everything the frontend needs to
// render the floorplan and rack grids in one round trip.
router.get('/rows', requireAuth, requireRole('owner', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const rows = await withTenantContext({ warehouseId }, async (client) => {
      const rowsResult = await client.query(
        `SELECT id, row_num, rack_count, tier_count FROM warehouse_rows
         WHERE warehouse_id = $1 ORDER BY row_num ASC`,
        [warehouseId],
      );
      const blocksResult = await client.query(
        `SELECT cb.id, cb.warehouse_row_id, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end,
                cb.state, cb.fill_pct,
                COALESCE(json_agg(json_build_object(
                  'id', cs.id, 'companyId', cs.company_id, 'sku', cs.sku, 'qty', cs.qty
                ) ORDER BY cs.updated_at) FILTER (WHERE cs.id IS NOT NULL), '[]') AS stock
         FROM cell_blocks cb
         LEFT JOIN cell_stock cs ON cs.cell_block_id = cb.id
         WHERE cb.warehouse_id = $1
         GROUP BY cb.id`,
        [warehouseId],
      );
      const blocksByRow = new Map();
      for (const block of blocksResult.rows) {
        const list = blocksByRow.get(block.warehouse_row_id) || [];
        list.push(block);
        blocksByRow.set(block.warehouse_row_id, list);
      }
      return rowsResult.rows.map((row) => ({ ...row, blocks: blocksByRow.get(row.id) || [] }));
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Replaces the entire layout — this is what "Построить карту" (constructor)
// and the simulated document-upload flow both call. New rows start as all
// empty atomic (1x1) blocks: there is no real stock yet on a freshly built
// warehouse, so nothing here is randomly pre-filled the way the old mockup was.
router.post('/rows', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { configs } = req.body; // [{ rackCount, tierCount }, ...]
    if (!Array.isArray(configs) || configs.length === 0) {
      throw new HttpError(400, 'Добавьте хотя бы один ряд');
    }

    const rows = await withTenantContext({ warehouseId }, async (client) => {
      await client.query(
        `DELETE FROM warehouse_rows WHERE warehouse_id = $1`, // cascades to cell_blocks/cell_stock
        [warehouseId],
      );

      const createdRows = [];
      for (let i = 0; i < configs.length; i++) {
        const { rackCount, tierCount } = configs[i];
        const rackN = Math.max(1, parseInt(rackCount, 10) || 1);
        const tierN = Math.max(1, parseInt(tierCount, 10) || 1);
        const rowNum = i + 1;

        const rowResult = await client.query(
          `INSERT INTO warehouse_rows (warehouse_id, row_num, rack_count, tier_count)
           VALUES ($1, $2, $3, $4) RETURNING id, row_num, rack_count, tier_count`,
          [warehouseId, rowNum, rackN, tierN],
        );
        const row = rowResult.rows[0];

        const values = [];
        const params = [];
        let p = 1;
        for (let r = 1; r <= rackN; r++) {
          for (let t = 1; t <= tierN; t++) {
            values.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
            params.push(row.id, warehouseId, r, r, t, t);
          }
        }
        await client.query(
          `INSERT INTO cell_blocks (warehouse_row_id, warehouse_id, rack_start, rack_end, tier_start, tier_end)
           VALUES ${values.join(', ')}`,
          params,
        );

        createdRows.push({ ...row, blocks: [] });
      }
      return createdRows;
    });
    res.status(201).json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/blocks/merge', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { blockAId, blockBId } = req.body;
    if (!blockAId || !blockBId) throw new HttpError(400, 'Не указаны ячейки для объединения');

    const merged = await withTenantContext({ warehouseId }, async (client) => {
      const result = await client.query(
        `SELECT id, warehouse_row_id, rack_start, rack_end, tier_start, tier_end
         FROM cell_blocks WHERE id = ANY($1::uuid[]) AND warehouse_id = $2`,
        [[blockAId, blockBId], warehouseId],
      );
      if (result.rows.length !== 2) throw new HttpError(404, 'Ячейки не найдены');
      const [a, b] = result.rows;
      if (a.warehouse_row_id !== b.warehouse_row_id) {
        throw new HttpError(400, 'Можно объединять только ячейки одного ряда');
      }

      const rackStart = Math.min(a.rack_start, b.rack_start);
      const rackEnd = Math.max(a.rack_end, b.rack_end);
      const tierStart = Math.min(a.tier_start, b.tier_start);
      const tierEnd = Math.max(a.tier_end, b.tier_end);

      await client.query(`DELETE FROM cell_blocks WHERE id = ANY($1::uuid[])`, [[blockAId, blockBId]]);
      const insertResult = await client.query(
        `INSERT INTO cell_blocks (warehouse_row_id, warehouse_id, rack_start, rack_end, tier_start, tier_end)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, warehouse_row_id, rack_start, rack_end, tier_start, tier_end, state, fill_pct`,
        [a.warehouse_row_id, warehouseId, rackStart, rackEnd, tierStart, tierEnd],
      );
      return insertResult.rows[0];
    });
    res.status(201).json(merged);
  } catch (err) {
    next(err);
  }
});

router.post('/blocks/:id/split', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { id } = req.params;

    const cells = await withTenantContext({ warehouseId }, async (client) => {
      const blockResult = await client.query(
        `SELECT id, warehouse_row_id, rack_start, rack_end, tier_start, tier_end
         FROM cell_blocks WHERE id = $1 AND warehouse_id = $2`,
        [id, warehouseId],
      );
      const block = blockResult.rows[0];
      if (!block) throw new HttpError(404, 'Ячейка не найдена');

      await client.query(`DELETE FROM cell_blocks WHERE id = $1`, [id]); // cascades cell_stock

      const created = [];
      for (let r = block.rack_start; r <= block.rack_end; r++) {
        for (let t = block.tier_start; t <= block.tier_end; t++) {
          const insertResult = await client.query(
            `INSERT INTO cell_blocks (warehouse_row_id, warehouse_id, rack_start, rack_end, tier_start, tier_end)
             VALUES ($1, $2, $3, $3, $4, $4)
             RETURNING id, warehouse_row_id, rack_start, rack_end, tier_start, tier_end, state, fill_pct`,
            [block.warehouse_row_id, warehouseId, r, t],
          );
          created.push(insertResult.rows[0]);
        }
      }
      return created;
    });
    res.status(201).json(cells);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
