const { HttpError } = require('../middleware/errorHandler');
const { refreshCellFill } = require('../cells/fill');

// Пересчёт ячейки: назначение, счёт, решение владельца.
//
// Правило выбирает ячейки, работник считает, владелец решает. Ни один из трёх
// шагов не делает работу другого — в этом весь смысл: счёт без назначения
// съедает смену, а исправление остатка без владельца списывает чужой товар.

const DEFAULTS = { recount_after_days: 90, cells_per_run: 10, min_days_between_runs: 7 };

async function getSettings(client, warehouseId) {
  const r = await client.query(
    'SELECT * FROM inventory_settings WHERE warehouse_id = $1', [warehouseId],
  );
  if (r.rows[0]) return r.rows[0];
  // Строки может не быть: склад заведён раньше, чем появилась инвентаризация.
  // Отдаём умолчания, не создавая строку — запись случится, когда владелец
  // впервые что-то поменяет.
  return { warehouse_id: warehouseId, ...DEFAULTS, updated_at: null };
}

async function saveSettings(client, warehouseId, patch) {
  const current = await getSettings(client, warehouseId);
  const next = {};
  for (const key of Object.keys(DEFAULTS)) {
    const given = patch[key];
    next[key] = given === undefined || given === null ? current[key] : Number(given);
    if (!Number.isInteger(next[key])) {
      throw new HttpError(400, `Значение «${key}» должно быть целым числом`);
    }
  }
  if (next.recount_after_days < 1 || next.recount_after_days > 3650) {
    throw new HttpError(400, 'Периодичность пересчёта — от 1 до 3650 дней');
  }
  if (next.cells_per_run < 1 || next.cells_per_run > 200) {
    throw new HttpError(400, 'За один заход можно назначить от 1 до 200 ячеек');
  }
  if (next.min_days_between_runs < 0 || next.min_days_between_runs > 365) {
    throw new HttpError(400, 'Пауза между заходами — от 0 до 365 дней');
  }

  const r = await client.query(
    `INSERT INTO inventory_settings
       (warehouse_id, recount_after_days, cells_per_run, min_days_between_runs)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (warehouse_id) DO UPDATE SET
       recount_after_days = EXCLUDED.recount_after_days,
       cells_per_run = EXCLUDED.cells_per_run,
       min_days_between_runs = EXCLUDED.min_days_between_runs,
       updated_at = now()
     RETURNING *`,
    [warehouseId, next.recount_after_days, next.cells_per_run, next.min_days_between_runs],
  );
  return r.rows[0];
}

// Какие ячейки считать. Правило, а не жребий: по убыванию того, насколько
// вероятно расхождение именно здесь.
//
//   1. на отборе из ячейки уже не хватало — подозрение уже есть;
//   2. с последнего пересчёта её много трогали — где чаще руки, там чаще ошибка;
//   3. не считали дольше всех или ни разу;
//   4. числится пустой — самая дешёвая проверка и частый источник «потерянного».
//
// Свежепосчитанные исключаются целиком: смысл пересчёта в том, что он редкий.
async function pickCells(client, warehouseId, { recountAfterDays, limit }) {
  const r = await client.query(
    `WITH last_count AS (
       SELECT cell_block_id, MAX(counted_at) AS counted_at
       FROM inventory_tasks
       WHERE warehouse_id = $1 AND counted_at IS NOT NULL
       GROUP BY cell_block_id
     ),
     moves AS (
       SELECT cell_block_id, count(*)::int AS n FROM (
         SELECT cell_block_id, finished_at AS at FROM receiving_records WHERE warehouse_id = $1
         UNION ALL
         SELECT cell_block_id, finished_at FROM shipping_records WHERE warehouse_id = $1
         UNION ALL
         SELECT cell_block_id, finished_at FROM return_records WHERE warehouse_id = $1
         UNION ALL
         SELECT from_cell_block_id, created_at FROM stock_operations WHERE warehouse_id = $1
         UNION ALL
         SELECT to_cell_block_id, created_at FROM stock_operations WHERE warehouse_id = $1
       ) m
       WHERE m.cell_block_id IS NOT NULL
       GROUP BY cell_block_id
     ),
     shortfalls AS (
       SELECT sr.cell_block_id, count(*)::int AS n
       FROM shipping_records sr
       JOIN invoice_items ii ON ii.id = sr.invoice_item_id
       WHERE sr.warehouse_id = $1 AND sr.is_final AND sr.picked_qty < ii.declared_qty
         AND sr.cell_block_id IS NOT NULL
       GROUP BY sr.cell_block_id
     )
     SELECT cb.id,
            wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end,
            lc.counted_at,
            COALESCE(m.n, 0) AS moves,
            COALESCE(s.n, 0) AS shortfalls,
            EXISTS (SELECT 1 FROM cell_stock cs
                    WHERE cs.cell_block_id = cb.id AND cs.qty > 0) AS has_stock
     FROM cell_blocks cb
     JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
     LEFT JOIN last_count lc ON lc.cell_block_id = cb.id
     LEFT JOIN moves m ON m.cell_block_id = cb.id
     LEFT JOIN shortfalls s ON s.cell_block_id = cb.id
     WHERE cb.warehouse_id = $1
       AND (lc.counted_at IS NULL OR lc.counted_at < now() - ($2 || ' days')::interval)
     ORDER BY COALESCE(s.n, 0) DESC,
              COALESCE(m.n, 0) DESC,
              lc.counted_at ASC NULLS FIRST,
              wr.row_num, cb.rack_start, cb.tier_start
     LIMIT $3`,
    [warehouseId, String(recountAfterDays), limit],
  );

  return r.rows.map((row) => ({
    cellBlockId: row.id,
    label: cellLabel(row),
    reason: reasonFor(row),
  }));
}

function cellLabel(r) {
  const rack = r.rack_start === r.rack_end ? r.rack_start : `${r.rack_start}–${r.rack_end}`;
  const tier = r.tier_start === r.tier_end ? r.tier_start : `${r.tier_start}–${r.tier_end}`;
  return `${r.row_num}.${rack}.${tier}`;
}

function reasonFor(row) {
  if (Number(row.shortfalls) > 0) return 'на отборе отсюда уже не хватало';
  if (!row.has_stock) return 'числится пустой — проверить, что это правда';
  if (Number(row.moves) >= 20) return `много движений: ${row.moves}`;
  if (!row.counted_at) return 'ни разу не считали';
  return 'считали дольше всех';
}

async function createRun(client, warehouseId, ownerId) {
  const settings = await getSettings(client, warehouseId);

  // Пауза между заходами — главный ограничитель. Без неё пересчёт станет
  // ежедневным, а ежедневный пересчёт перестают делать честно.
  const last = await client.query(
    `SELECT created_at FROM inventory_runs
     WHERE warehouse_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [warehouseId],
  );
  if (last.rows[0] && settings.min_days_between_runs > 0) {
    const daysSince = (Date.now() - new Date(last.rows[0].created_at).getTime()) / 86400000;
    if (daysSince < settings.min_days_between_runs) {
      const left = Math.ceil(settings.min_days_between_runs - daysSince);
      throw new HttpError(409,
        `Прошлый пересчёт был недавно. Следующий можно назначить через ${left} дн.`);
    }
  }

  // Незакрытые задания с прошлого раза — сначала доделать их.
  const open = await client.query(
    `SELECT count(*)::int AS n FROM inventory_tasks
     WHERE warehouse_id = $1 AND status = 'pending'`,
    [warehouseId],
  );
  if (open.rows[0].n > 0) {
    throw new HttpError(409,
      `С прошлого раза не посчитано ${open.rows[0].n} ячеек — сначала они`);
  }

  const cells = await pickCells(client, warehouseId, {
    recountAfterDays: settings.recount_after_days,
    limit: settings.cells_per_run,
  });
  if (cells.length === 0) {
    throw new HttpError(409,
      `Считать нечего: все ячейки проверяли меньше ${settings.recount_after_days} дней назад`);
  }

  const run = await client.query(
    `INSERT INTO inventory_runs (warehouse_id, created_by_owner_id) VALUES ($1, $2)
     RETURNING id, created_at`,
    [warehouseId, ownerId || null],
  );
  for (const c of cells) {
    await client.query(
      `INSERT INTO inventory_tasks (run_id, warehouse_id, cell_block_id, reason)
       VALUES ($1, $2, $3, $4)`,
      [run.rows[0].id, warehouseId, c.cellBlockId, c.reason],
    );
  }
  return { runId: run.rows[0].id, createdAt: run.rows[0].created_at, cells };
}

// Что лежит в ячейке по данным Аргуса. Один и тот же снимок используется и как
// «ожидаемое» в задании, и как то, что видит работник.
async function cellContents(client, warehouseId, cellBlockId) {
  const r = await client.query(
    `SELECT cs.sku, cs.company_id, cs.quality, SUM(cs.qty)::numeric AS qty,
            COALESCE(p.name, (SELECT ii.name FROM invoice_items ii
                              WHERE ii.warehouse_id = $1 AND ii.sku = cs.sku
                              ORDER BY ii.id DESC LIMIT 1), cs.sku) AS name,
            MAX(cs.updated_at) AS updated_at
     FROM cell_stock cs
     LEFT JOIN products p ON p.warehouse_id = cs.warehouse_id
       AND p.company_id = cs.company_id AND p.sku = cs.sku
     WHERE cs.warehouse_id = $1 AND cs.cell_block_id = $2 AND cs.qty > 0
     GROUP BY cs.sku, cs.company_id, cs.quality, p.name
     ORDER BY name`,
    [warehouseId, cellBlockId],
  );
  return r.rows.map((x) => ({
    sku: x.sku,
    name: x.name,
    companyId: x.company_id,
    quality: x.quality,
    qty: Number(x.qty),
    updatedAt: x.updated_at,
  }));
}

async function listTasks(client, warehouseId, statuses) {
  const r = await client.query(
    `SELECT t.id, t.cell_block_id, t.status, t.reason, t.expected, t.counted, t.note,
            t.counted_at, t.created_at,
            wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
     FROM inventory_tasks t
     JOIN cell_blocks cb ON cb.id = t.cell_block_id
     JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
     WHERE t.warehouse_id = $1 AND t.status = ANY($2::inventory_task_status[])
     ORDER BY wr.row_num, cb.rack_start, cb.tier_start`,
    [warehouseId, statuses],
  );
  return r.rows.map((x) => ({
    id: x.id,
    cellBlockId: x.cell_block_id,
    label: cellLabel(x),
    status: x.status,
    reason: x.reason,
    expected: x.expected,
    counted: x.counted,
    note: x.note,
    countedAt: x.counted_at,
    createdAt: x.created_at,
  }));
}

// Работник открыл ячейку: запоминаем снимок и время. Дальше расхождение
// считается относительно ЭТОГО снимка, а не того, что будет через полчаса.
async function openTask(client, warehouseId, taskId) {
  const t = await client.query(
    `SELECT * FROM inventory_tasks WHERE id = $1 AND warehouse_id = $2`,
    [taskId, warehouseId],
  );
  const task = t.rows[0];
  if (!task) throw new HttpError(404, 'Задание не найдено');
  if (task.status !== 'pending') throw new HttpError(409, 'Это задание уже посчитано');

  const contents = await cellContents(client, warehouseId, task.cell_block_id);
  await client.query(
    `UPDATE inventory_tasks SET expected = $2, opened_at = now() WHERE id = $1`,
    [taskId, JSON.stringify(contents)],
  );
  const label = await client.query(
    `SELECT wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
     FROM cell_blocks cb JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
     WHERE cb.id = $1`, [task.cell_block_id],
  );
  return {
    id: task.id,
    cellBlockId: task.cell_block_id,
    label: cellLabel(label.rows[0]),
    reason: task.reason,
    expected: contents,
  };
}

// Работник посчитал. Здесь ничего не исправляется — только записывается.
async function submitCount(client, warehouseId, taskId, { lines, note, workerKeyId }) {
  const t = await client.query(
    `SELECT * FROM inventory_tasks WHERE id = $1 AND warehouse_id = $2 FOR UPDATE`,
    [taskId, warehouseId],
  );
  const task = t.rows[0];
  if (!task) throw new HttpError(404, 'Задание не найдено');
  if (task.status !== 'pending') throw new HttpError(409, 'Это задание уже посчитано');
  if (!task.opened_at) throw new HttpError(409, 'Сначала откройте ячейку — нужен снимок остатка');
  if (!Array.isArray(lines)) throw new HttpError(400, 'Нужен список посчитанного');

  // Если в ячейке шла работа, пока считали, — счёт устарел. Принять его значит
  // внести ошибку вместо того, чтобы её убрать.
  const moved = await client.query(
    `SELECT 1 FROM cell_stock
     WHERE warehouse_id = $1 AND cell_block_id = $2 AND updated_at > $3 LIMIT 1`,
    [warehouseId, task.cell_block_id, task.opened_at],
  );
  if (moved.rows[0]) {
    throw new HttpError(409, 'В ячейке была работа, пока вы считали — посчитайте заново');
  }

  const counted = lines
    .filter((l) => l && l.sku)
    .map((l) => ({
      sku: String(l.sku),
      companyId: l.companyId || null,
      quality: l.quality || 'good',
      qty: Number(l.qty),
    }));
  if (counted.some((l) => !Number.isFinite(l.qty) || l.qty < 0)) {
    throw new HttpError(400, 'Количество не может быть отрицательным');
  }

  const expected = task.expected || [];
  const cleanNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 500) : null;
  // Отметка «нашёл лишнее» — это расхождение, даже если посчитанное сошлось
  // строка в строку: в ячейке лежит то, чего Аргус не знает.
  const same = sameContents(expected, counted) && !cleanNote;

  await client.query(
    `UPDATE inventory_tasks
     SET counted = $2, note = $3, counted_at = now(), worker_key_id = $4,
         status = $5::inventory_task_status
     WHERE id = $1`,
    [taskId, JSON.stringify(counted), cleanNote, workerKeyId || null,
      same ? 'matched' : 'waiting_owner'],
  );
  return { matched: same, expected, counted, note: cleanNote };
}

// Сравниваем по тройке «артикул + продавец + состояние»: 40 годных и 40
// бракованных того же товара — не одно и то же.
const keyOf = (l) => `${l.sku}|${l.companyId || ''}|${l.quality || 'good'}`;

function sameContents(expected, counted) {
  const a = new Map(expected.map((l) => [keyOf(l), Number(l.qty)]));
  const b = new Map(counted.map((l) => [keyOf(l), Number(l.qty)]));
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

// Разница построчно — то, что увидит владелец, когда будет решать.
function diffOf(expected, counted) {
  const a = new Map((expected || []).map((l) => [keyOf(l), l]));
  const b = new Map((counted || []).map((l) => [keyOf(l), l]));
  const out = [];
  for (const [k, line] of a) {
    const was = Number(line.qty);
    const now = b.has(k) ? Number(b.get(k).qty) : 0;
    if (was !== now) out.push({ ...line, expectedQty: was, countedQty: now, diff: now - was });
  }
  for (const [k, line] of b) {
    if (a.has(k)) continue;
    out.push({ ...line, expectedQty: 0, countedQty: Number(line.qty), diff: Number(line.qty) });
  }
  return out;
}

// Решение владельца. Только здесь остаток вообще меняется.
async function resolveTask(client, warehouseId, taskId, { decision, ownerId }) {
  if (decision !== 'apply' && decision !== 'reject') {
    throw new HttpError(400, 'Решение может быть apply или reject');
  }
  const t = await client.query(
    `SELECT * FROM inventory_tasks WHERE id = $1 AND warehouse_id = $2 FOR UPDATE`,
    [taskId, warehouseId],
  );
  const task = t.rows[0];
  if (!task) throw new HttpError(404, 'Задание не найдено');
  if (task.status !== 'waiting_owner') {
    throw new HttpError(409, 'По этому заданию решать нечего');
  }

  if (decision === 'reject') {
    await client.query(
      `UPDATE inventory_tasks SET status = 'rejected', resolved_at = now(),
       resolved_by_owner_id = $2 WHERE id = $1`,
      [taskId, ownerId || null],
    );
    return { applied: false, changes: [] };
  }

  // Принять пересчёт — значит сделать ячейку такой, какой её увидел человек.
  // Стираем всё, что числилось, и кладём посчитанное: любая попытка «поправить
  // разницу» построчно рано или поздно оставит хвост, которого нет на полке.
  const changes = diffOf(task.expected || [], task.counted || []);
  await client.query(
    `DELETE FROM cell_stock WHERE warehouse_id = $1 AND cell_block_id = $2`,
    [warehouseId, task.cell_block_id],
  );
  for (const line of (task.counted || [])) {
    if (Number(line.qty) <= 0) continue;
    await client.query(
      `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty, quality)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [task.cell_block_id, warehouseId, line.companyId || null, line.sku,
        line.qty, line.quality || 'good'],
    );
  }
  await refreshCellFill(client, task.cell_block_id);

  // След: пересчёт двигает остаток так же, как сборка или перепаковка, и
  // должен быть виден в том же месте.
  for (const line of changes) {
    await client.query(
      `INSERT INTO stock_operations
         (warehouse_id, company_id, kind, sku, qty, to_cell_block_id, details, worker_key_id)
       VALUES ($1, $2, 'inventory', $3, $4, $5, $6, NULL)`,
      [warehouseId, line.companyId || null, line.sku, Math.abs(line.diff), task.cell_block_id,
        JSON.stringify({ expectedQty: line.expectedQty, countedQty: line.countedQty,
          quality: line.quality, taskId })],
    );
  }

  await client.query(
    `UPDATE inventory_tasks SET status = 'applied', resolved_at = now(),
     resolved_by_owner_id = $2 WHERE id = $1`,
    [taskId, ownerId || null],
  );
  return { applied: true, changes };
}

module.exports = {
  DEFAULTS, getSettings, saveSettings, pickCells, createRun,
  cellContents, listTasks, openTask, submitCount, resolveTask, diffOf,
};
