// Адресное хранение (владелец 06.10.2026): включено — товар лежит по ячейкам,
// как раньше; выключено — весь товар в одном общем месте «Склад» (ряд 0,
// одна ячейка с отметкой general). Ячейки не выбирают ни при приёмке, ни при
// сборке; сборка сверх учёта уводит «Склад» в минус — владелец поправит.
// Подпись «Склад» — src/cells/label.js (ряд 0).
const journal = require('../journal/repository');
const { refreshCellFill } = require('./fill');

const GENERAL_LABEL = 'Склад';

async function isOff(client, warehouseId) {
  const r = await client.query('SELECT address_storage FROM warehouses WHERE id = $1', [warehouseId]);
  return r.rows[0] ? r.rows[0].address_storage === false : false;
}

// «Склад» — ряд 0 с одной ячейкой; заводится при первом выключении.
async function ensureGeneral(client, warehouseId) {
  const found = await client.query('SELECT id FROM cell_blocks WHERE warehouse_id = $1 AND general', [warehouseId]);
  if (found.rows[0]) return found.rows[0].id;
  const row = (await client.query(
    `INSERT INTO warehouse_rows (warehouse_id, row_num, rack_count, tier_count, label)
     VALUES ($1, 0, 1, 1, $2)
     ON CONFLICT (warehouse_id, row_num) DO UPDATE SET label = EXCLUDED.label
     RETURNING id`, [warehouseId, GENERAL_LABEL])).rows[0];
  return (await client.query(
    `INSERT INTO cell_blocks (warehouse_row_id, warehouse_id, rack_start, rack_end, tier_start, tier_end, general)
     VALUES ($1, $2, 1, 1, 1, 1, true) RETURNING id`, [row.id, warehouseId])).rows[0].id;
}

async function generalId(client, warehouseId) {
  return (await client.query('SELECT id FROM cell_blocks WHERE warehouse_id = $1 AND general', [warehouseId])).rows[0]?.id || null;
}

// Куда класть или откуда брать: при выключенном хранении — всегда «Склад».
async function place(client, warehouseId, cellBlockId) {
  return (await isOff(client, warehouseId)) ? ensureGeneral(client, warehouseId) : cellBlockId;
}

// Включить или выключить. Выключение переносит весь товар склада в «Склад»
// (ячейки остаются пустыми — схему можно перестроить); включение только
// меняет настройку: товар лежит в «Складе», пока его не разложат.
async function setAddressStorage(client, warehouseId, on, actor = {}) {
  const cur = await client.query('SELECT address_storage FROM warehouses WHERE id = $1 FOR UPDATE', [warehouseId]);
  if (!cur.rows[0]) return null;
  if (cur.rows[0].address_storage === on) return { on, moved: 0, units: 0 };
  let moved = 0;
  let units = 0;
  let canceledTasks = 0;
  if (!on) {
    const general = await ensureGeneral(client, warehouseId);
    // Строки ячеек — под блокировку: приёмка и сборка ждут переноса.
    const rows = (await client.query(
      `SELECT id, cell_block_id, company_id, sku, qty FROM cell_stock
        WHERE warehouse_id = $1 AND cell_block_id <> $2 ORDER BY id FOR UPDATE`, [warehouseId, general])).rows;
    for (const r of rows) {
      await client.query('UPDATE cell_stock SET cell_block_id = $2, updated_at = now() WHERE id = $1', [r.id, general]);
      if (Number(r.qty) > 0) {
        await client.query(
          `INSERT INTO stock_operations (warehouse_id, company_id, kind, sku, qty, from_cell_block_id, to_cell_block_id, details)
           VALUES ($1, $2, 'address_off', $3, $4, $5, $6, '{}'::jsonb)`,
          [warehouseId, r.company_id, r.sku, r.qty, r.cell_block_id, general]);
        units += Number(r.qty);
      }
      moved += 1;
    }
    for (const cell of new Set(rows.map((r) => r.cell_block_id))) await refreshCellFill(client, cell);
    await refreshCellFill(client, general);
    // Незаконченный пересчёт полок теряет смысл: товар уже в «Складе», а
    // принятый пересчёт полки лёг бы туда второй раз (проверка 07.10, Н2).
    const dropped = await client.query(
      `UPDATE inventory_tasks SET status = 'rejected', resolved_at = now()
        WHERE warehouse_id = $1 AND status IN ('pending', 'waiting_owner') AND cell_block_id <> $2`,
      [warehouseId, general]);
    canceledTasks = dropped.rowCount;
  }
  await client.query('UPDATE warehouses SET address_storage = $2 WHERE id = $1', [warehouseId, on]);
  await journal.createEntry(client, {
    warehouseId, agent: 'Кладовщик', actorType: actor.type || 'owner', actorId: actor.id || null,
    actionText: on
      ? 'Адресное хранение включено: товар снова кладут в ячейки. Лежащее в «Складе» остаётся там, пока его не разложат.'
      : `Адресное хранение выключено: весь товар (${units.toLocaleString('ru-RU')} шт.) перенесён в общее место «Склад», `
        + 'ячейки не выбирают ни при приёмке, ни при сборке.'
        + (canceledTasks ? ` Незаконченный пересчёт ячеек отменён (${canceledTasks}) — считать теперь «Склад».` : ''),
  });
  return { on, moved, units };
}

module.exports = { GENERAL_LABEL, isOff, ensureGeneral, generalId, place, setAddressStorage };
