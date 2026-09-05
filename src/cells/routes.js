const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const { LIMITS, normalizeName } = require('../warehouses/naming');
const { CELL_CAPACITY_UNITS } = require('./fill');
const { moveStock } = require('./move');
const journal = require('../journal/repository');

const router = express.Router();

// Full layout: rows -> blocks -> stock, everything the frontend needs to
// render the floorplan and rack grids in one round trip.
router.get('/rows', requireAuth, requireRole('owner', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const rows = await withTenantContext({ warehouseId }, async (client) => {
      const rowsResult = await client.query(
        `SELECT id, row_num, rack_count, tier_count, label, aisle_after FROM warehouse_rows
         WHERE warehouse_id = $1 ORDER BY row_num ASC`,
        [warehouseId],
      );
      const blocksResult = await client.query(
        `SELECT cb.id, cb.warehouse_row_id, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end,
                cb.state, cb.fill_pct,
                COALESCE(json_agg(json_build_object(
                  'id', cs.id, 'companyId', cs.company_id, 'sku', cs.sku, 'qty', cs.qty,
                  'quality', cs.quality
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
    const { configs } = req.body; // [{ rackCount, tierCount, aisleAfter, label }, ...]
    if (!Array.isArray(configs) || configs.length === 0) {
      throw new HttpError(400, 'Добавьте хотя бы один ряд');
    }
    if (configs.length > LIMITS.rows) {
      throw new HttpError(400, `Рядов не больше ${LIMITS.rows}`);
    }

    // Потолки нужны здесь, а не только в браузере: ячейки создаются одной
    // вставкой rackCount × tierCount строк, и запрос с парой лишних нулей
    // положил бы базу. Раньше сервер принял бы любое число.
    let cellsTotal = 0;
    configs.forEach((c, i) => {
      const racks = Math.max(1, parseInt(c.rackCount, 10) || 1);
      const tiers = Math.max(1, parseInt(c.tierCount, 10) || 1);
      if (racks > LIMITS.racksPerRow) {
        throw new HttpError(400, `Ряд ${i + 1}: стеллажей не больше ${LIMITS.racksPerRow}`);
      }
      if (tiers > LIMITS.tiersPerRack) {
        throw new HttpError(400, `Ряд ${i + 1}: ярусов не больше ${LIMITS.tiersPerRack}`);
      }
      cellsTotal += racks * tiers;
    });
    // Имена разбираем заранее, до первой вставки: если восьмой ряд назван
    // занятым именем, откатывать уже построенные семь неоткуда — запрос
    // обязан упасть до того, как что-то создано.
    const labels = configs.map((c, i) => {
      try {
        return normalizeName(c.label, { what: 'ряда' });
      } catch (err) {
        throw new HttpError(err.status || 400, `Ряд ${i + 1}: ${err.message}`);
      }
    });
    const seen = new Set();
    labels.forEach((label, i) => {
      if (!label) return;
      const key = label.toLowerCase();
      if (seen.has(key)) {
        throw new HttpError(409, `Ряд ${i + 1}: имя «${label}» уже занято другим рядом`);
      }
      seen.add(key);
    });

    if (cellsTotal > LIMITS.cellsTotal) {
      throw new HttpError(400, `Всего мест получается ${cellsTotal.toLocaleString('ru-RU')} — больше ${LIMITS.cellsTotal.toLocaleString('ru-RU')} склад не потянет`);
    }

    const rows = await withTenantContext({ warehouseId }, async (client) => {
      await client.query(
        `DELETE FROM warehouse_rows WHERE warehouse_id = $1`, // cascades to cell_blocks/cell_stock
        [warehouseId],
      );

      const createdRows = [];
      for (let i = 0; i < configs.length; i++) {
        const { rackCount, tierCount, aisleAfter } = configs[i];
        const rackN = Math.max(1, parseInt(rackCount, 10) || 1);
        const tierN = Math.max(1, parseInt(tierCount, 10) || 1);
        const rowNum = i + 1;

        const rowResult = await client.query(
          `INSERT INTO warehouse_rows (warehouse_id, row_num, rack_count, tier_count, aisle_after, label)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, row_num, rack_count, tier_count, aisle_after, label`,
          // Проход после последнего ряда — это уже не проход, а край склада.
          [warehouseId, rowNum, rackN, tierN, aisleAfter === true && i < configs.length - 1, labels[i]],
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

// Расстановка проходов. Массив идёт по порядку рядов: aisles[i] — есть ли
// проход после ряда i+1. Последний элемент игнорируется: за последним рядом
// проход нарисовать негде.
router.patch('/rows/aisles', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { aisles } = req.body;
    if (!Array.isArray(aisles)) throw new HttpError(400, 'Ожидается список проходов');

    const rows = await withTenantContext({ warehouseId }, async (client) => {
      const existing = await client.query(
        `SELECT row_num FROM warehouse_rows WHERE warehouse_id = $1 ORDER BY row_num ASC`,
        [warehouseId],
      );
      if (existing.rows.length !== aisles.length) {
        throw new HttpError(400, `Рядов на складе ${existing.rows.length}, а проходов прислано ${aisles.length}`);
      }
      // Один UPDATE вместо запроса на ряд: расстановка меняется целиком, и
      // частично применённая — это чужая схема склада.
      const result = await client.query(
        `UPDATE warehouse_rows AS wr SET aisle_after = v.flag
         FROM unnest($2::int[], $3::boolean[]) AS v(row_num, flag)
         WHERE wr.warehouse_id = $1 AND wr.row_num = v.row_num
         RETURNING wr.row_num, wr.aisle_after`,
        [
          warehouseId,
          existing.rows.map((r) => r.row_num),
          aisles.map((flag, i) => flag === true && i < aisles.length - 1),
        ],
      );
      return result.rows.sort((a, b) => a.row_num - b.row_num);
    });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Своё имя для ряда. Пустое имя стирает название и возвращает номер.
router.patch('/rows/:rowNum/name', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const rowNum = Number(req.params.rowNum);
    if (!Number.isInteger(rowNum) || rowNum < 1) throw new HttpError(400, 'Неверный номер ряда');
    const label = normalizeName(req.body?.label, { what: 'ряда' });

    const row = await withTenantContext({ warehouseId }, async (client) => {
      try {
        const result = await client.query(
          `UPDATE warehouse_rows SET label = $3
           WHERE warehouse_id = $1 AND row_num = $2
           RETURNING id, row_num, rack_count, tier_count, label`,
          [warehouseId, rowNum, label],
        );
        return result.rows[0] || null;
      } catch (err) {
        // Уникальный индекс по (склад, имя) — единственное место, где имя
        // нельзя занять дважды даже двумя одновременными запросами.
        if (err.code === '23505') {
          throw new HttpError(409, `Ряд с названием «${label}» уже есть — адреса ячеек стали бы неоднозначными`);
        }
        throw err;
      }
    });
    if (!row) throw new HttpError(404, 'Ряд не найден');
    res.json(row);
  } catch (err) {
    next(err);
  }
});

// Wipe the layout entirely and go back to "склад не настроен".
//
// Deleting warehouse_rows cascades to cell_blocks and on to cell_stock, so
// this also erases the record of whatever is on the shelves. That is fine when
// the shelves are empty and destructive when they are not, and the owner can't
// tell which from the button — so a wipe that would take goods with it is
// refused unless the request says so explicitly. The UI turns that refusal
// into a warning naming what would be lost, instead of a generic "are you
// sure?" that teaches people to click through.
router.delete('/rows', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const confirmed = req.query.confirm === 'true';

    const result = await withTenantContext({ warehouseId }, async (client) => {
      // Зоны сортировки — такая же часть схемы, и в них тоже числится товар,
      // поэтому считаем и сносим их вместе с ячейками.
      const stock = await client.query(
        `SELECT
           (SELECT count(*)::int FROM cell_stock WHERE warehouse_id = $1)
           + (SELECT count(*)::int FROM dropzone_items WHERE warehouse_id = $1) AS positions,
           (SELECT coalesce(sum(qty), 0)::int FROM cell_stock WHERE warehouse_id = $1)
           + (SELECT coalesce(sum(qty), 0)::int FROM dropzone_items WHERE warehouse_id = $1) AS units`,
        [warehouseId],
      );
      const { positions, units } = stock.rows[0];

      if (positions > 0 && !confirmed) {
        throw new HttpError(409, `В ячейках и зонах числится товар: ${positions} позиций, ${units} шт. Удаление схемы сотрёт эти записи.`);
      }

      const deleted = await client.query(
        `DELETE FROM warehouse_rows WHERE warehouse_id = $1`, [warehouseId],
      );
      await client.query(`DELETE FROM dropzones WHERE warehouse_id = $1`, [warehouseId]);
      return { deletedRows: deleted.rowCount, clearedPositions: positions, clearedUnits: units };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Merge every block inside a rectangle into one, atomically.
//
// Replaced the old pairwise /blocks/merge, which was removed rather than kept
// alongside: it took a bounding box of two arbitrary blocks without checking
// that they were adjacent (so merging racks 1 and 5 produced a block sitting
// on top of the untouched blocks 2-4), and it lost stock through the cascade
// described below. A 1x2 rectangle covers everything it could legitimately do.
//
// This replaces pairwise merging for the UI: dragging a rectangle is a single
// gesture, so it has to be a single server call. A chain of pairwise merges
// driven from the browser leaves the layout half-merged whenever one step
// fails, and a half-merged shelf is something a human has to untangle by hand.
//
// Unlike the old pairwise endpoint, this one EXPANDS one existing block and
// moves the others' stock into it, instead of deleting every block and
// inserting a fresh one. That is not a style preference: cell_stock is wired
// to cell_blocks with ON DELETE CASCADE, so delete-then-insert silently
// destroys the record of goods that are still physically on the shelf.
router.post('/blocks/merge-rect', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { rowNum, rackStart, rackEnd, tierStart, tierEnd } = req.body || {};

    const bounds = [rowNum, rackStart, rackEnd, tierStart, tierEnd].map(Number);
    if (bounds.some((n) => !Number.isInteger(n) || n < 1)) {
      throw new HttpError(400, 'Неверно задана область объединения');
    }
    const [row, r0, r1, t0, t1] = bounds;
    // Accept a rectangle dragged in any direction.
    const rackLo = Math.min(r0, r1), rackHi = Math.max(r0, r1);
    const tierLo = Math.min(t0, t1), tierHi = Math.max(t0, t1);
    const area = (rackHi - rackLo + 1) * (tierHi - tierLo + 1);
    if (area < 2) throw new HttpError(400, 'Выделите хотя бы две ячейки');

    const merged = await withTenantContext({ warehouseId }, async (client) => {
      const rowResult = await client.query(
        `SELECT id, rack_count, tier_count FROM warehouse_rows
         WHERE warehouse_id = $1 AND row_num = $2`,
        [warehouseId, row],
      );
      const warehouseRow = rowResult.rows[0];
      if (!warehouseRow) throw new HttpError(404, 'Ряд не найден');
      if (rackHi > warehouseRow.rack_count || tierHi > warehouseRow.tier_count) {
        throw new HttpError(400, 'Область выходит за границы ряда');
      }

      // FOR UPDATE so two owners dragging overlapping rectangles at once can't
      // both pass the coverage check below and corrupt the layout.
      const blocksResult = await client.query(
        `SELECT id, rack_start, rack_end, tier_start, tier_end
         FROM cell_blocks
         WHERE warehouse_row_id = $1 AND warehouse_id = $2
           AND rack_start <= $4 AND rack_end >= $3
           AND tier_start <= $6 AND tier_end >= $5
         ORDER BY tier_start, rack_start
         FOR UPDATE`,
        [warehouseRow.id, warehouseId, rackLo, rackHi, tierLo, tierHi],
      );
      const blocks = blocksResult.rows;
      if (blocks.length === 0) throw new HttpError(404, 'В этой области нет ячеек');

      // A block that pokes outside the selection can't be swallowed without
      // silently resizing the part the owner didn't select.
      const sticksOut = blocks.some((b) => (
        b.rack_start < rackLo || b.rack_end > rackHi
        || b.tier_start < tierLo || b.tier_end > tierHi
      ));
      if (sticksOut) {
        throw new HttpError(400, 'Выделение задевает объединённую ячейку — захватите её целиком');
      }

      // Blocks never overlap, so equal areas prove the rectangle is exactly tiled.
      const covered = blocks.reduce((sum, b) => (
        sum + (b.rack_end - b.rack_start + 1) * (b.tier_end - b.tier_start + 1)
      ), 0);
      if (covered !== area) throw new HttpError(400, 'В выделении есть пропуски');

      if (blocks.length === 1) return blocks[0]; // already one block — nothing to do

      const [keeper, ...absorbed] = blocks;
      const absorbedIds = absorbed.map((b) => b.id);

      // Move stock BEFORE deleting, or ON DELETE CASCADE takes it with them.
      await client.query(
        `UPDATE cell_stock SET cell_block_id = $1, updated_at = now()
         WHERE cell_block_id = ANY($2::uuid[])`,
        [keeper.id, absorbedIds],
      );
      await client.query(`DELETE FROM cell_blocks WHERE id = ANY($1::uuid[])`, [absorbedIds]);

      const updated = await client.query(
        `UPDATE cell_blocks
         SET rack_start = $2, rack_end = $3, tier_start = $4, tier_end = $5,
             state = CASE WHEN EXISTS (SELECT 1 FROM cell_stock WHERE cell_block_id = $1)
                          THEN 'occupied'::cell_state ELSE 'empty'::cell_state END,
             fill_pct = COALESCE((SELECT LEAST(100, GREATEST(1, round(SUM(qty) / $6::numeric * 100)::int))
                                  FROM cell_stock WHERE cell_block_id = $1), 0),
             updated_at = now()
         WHERE id = $1
         RETURNING id, warehouse_row_id, rack_start, rack_end, tier_start, tier_end, state, fill_pct`,
        [keeper.id, rackLo, rackHi, tierLo, tierHi, CELL_CAPACITY_UNITS],
      );
      return updated.rows[0];
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

      // Splitting an occupied block is refused rather than guessed at. The
      // goods sit somewhere inside the merged space; nothing in the data says
      // which of the resulting cells that is, and the delete below cascades
      // cell_stock — so guessing would either invent a location or quietly
      // erase goods that are still on the shelf.
      const stockResult = await client.query(
        `SELECT count(*)::int AS n FROM cell_stock WHERE cell_block_id = $1`, [id],
      );
      if (stockResult.rows[0].n > 0) {
        throw new HttpError(409, 'В ячейке лежит товар — разберите её после того, как товар заберут');
      }

      await client.query(`DELETE FROM cell_blocks WHERE id = $1`, [id]);

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

const QUALITY_LABEL = {
  good: 'годный',
  defective: 'брак',
  packaging_defect: 'брак упаковки',
};

// Переставить товар в другую ячейку и/или сменить его состояние.
// Главный случай — перепаковка: «брак упаковки» после перепаковки становится
// годным и возвращается в продажу. Работник, а не владелец: это физическое
// действие на складе, как приёмка и отбор.
router.post('/move', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const {
      sku, companyId, fromCellBlockId, toCellBlockId, qty, fromQuality = 'good', toQuality,
    } = req.body;

    for (const q of [fromQuality, toQuality].filter(Boolean)) {
      if (!QUALITY_LABEL[q]) {
        throw new HttpError(400, 'Состояние может быть good, defective или packaging_defect');
      }
    }

    const moved = await withTenantContext({ warehouseId }, async (client) => {
      const result = await moveStock(client, warehouseId, {
        sku, companyId, fromCellBlockId, toCellBlockId, qty, fromQuality, toQuality,
        workerKeyId: req.auth.staffKeyId || null,
      });

      const changedState = result.toQuality !== result.fromQuality;
      const changedCell = result.toCellBlockId !== result.fromCellBlockId;
      const parts = [];
      if (changedState) {
        parts.push(`состояние: ${QUALITY_LABEL[result.fromQuality]} → ${QUALITY_LABEL[result.toQuality]}`);
      }
      if (changedCell) parts.push('переставил в другую ячейку');
      await journal.createEntry(client, {
        warehouseId,
        agent: 'Кладовщик',
        actionText: `Переместил «${result.sku}», ${result.qty} шт. — ${parts.join(', ')}.`,
        entityType: 'cell_block',
        entityId: result.toCellBlockId,
        // Место, куда товар лёг: именно туда владелец пойдёт смотреть.
        cellBlockId: result.toCellBlockId,
        actorType: 'worker',
        actorId: staffKeyId,
        status: 'auto',
      });

      return result;
    });
    res.status(201).json(moved);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
