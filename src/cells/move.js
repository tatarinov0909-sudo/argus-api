const { HttpError } = require('../middleware/errorHandler');
const { requireQty } = require('../middleware/qty');
const { refreshCellFill } = require('./fill');

// Перемещение товара: из ячейки в ячейку и/или из одного состояния в другое.
//
// Два случая из жизни склада, ради которых это существует:
//   1. Товар просто переставили — был в 1.1.1, стал в 2.3.4.
//   2. Перепаковали. Владелец референсной компании описал это прямо: товар с
//      испорченной упаковкой сам по себе хороший, его перепаковывают, и он
//      возвращается в продажу. До этого у состояния «брак упаковки» не было
//      выхода вообще: положить в него можно было, а выйти — нет.
//
// Правило одно и жёсткое: количество не появляется и не исчезает. Сколько
// сняли с одной строки остатка — столько и легло в другую, в той же
// транзакции. Ошибиться в меньшую сторону нельзя (FOR UPDATE + проверка), в
// большую — тем более.
async function moveStock(client, warehouseId, {
  sku, companyId, fromCellBlockId, toCellBlockId, qty,
  fromQuality = 'good', toQuality, workerKeyId = null,
  // Виртуальный склад строк, которые двигаем (02.10.2026): undefined — любые,
  // null — «Основной». Каждая строка уезжает со своим складом.
  vw,
}) {
  if (!sku || !fromCellBlockId) {
    throw new HttpError(400, 'Нужны товар, ячейка-источник и количество');
  }
  const amount = requireQty(qty, 'Количество', { min: 1 });

  const targetCell = toCellBlockId || fromCellBlockId;
  const targetQuality = toQuality || fromQuality;
  if (targetCell === fromCellBlockId && targetQuality === fromQuality) {
    throw new HttpError(400, 'Нечего менять: та же ячейка и то же состояние');
  }

  if (toCellBlockId) {
    const dest = await client.query(
      `SELECT id FROM cell_blocks WHERE id = $1 AND warehouse_id = $2`,
      [toCellBlockId, warehouseId],
    );
    if (!dest.rows[0]) throw new HttpError(404, 'Ячейка назначения не найдена');
  }

  const taken = await takeFromCell(client, warehouseId, {
    cellBlockId: fromCellBlockId, sku, companyId, quality: fromQuality, qty: amount, verb: 'переместить', vw,
  });

  for (const part of taken) {
    // Склад «хранить отдельно» и зоны складов продавца (02.10.2026);
    // подключаем при вызове: модуль складов сам пользуется этим файлом.
    await require('../vwarehouses/separate').checkPut(client, warehouseId, {
      cellBlockId: targetCell, companyId: part.companyId, vw: part.vw, quality: targetQuality,
    });
    await client.query(
      `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty, quality, virtual_warehouse_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [targetCell, warehouseId, part.companyId, sku, part.qty, targetQuality, part.vw],
    );
  }

  await refreshCellFill(client, fromCellBlockId);
  if (targetCell !== fromCellBlockId) await refreshCellFill(client, targetCell);

  // След операции: у перепаковки и перестановки тоже нет накладной, а остаток
  // они двигают. Перепаковку отличаем от простой перестановки по тому, менялось
  // ли состояние товара — для продавца это разные события.
  // След операции — тоже по каждому продавцу отдельно: в истории продавца
  // должно стоять ровно его количество, а не общая сумма по ячейке.
  for (const part of taken) {
    await client.query(
      `INSERT INTO stock_operations
         (warehouse_id, company_id, kind, sku, qty,
          from_cell_block_id, to_cell_block_id, details, worker_key_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [warehouseId, part.companyId, targetQuality === fromQuality ? 'move' : 'repack',
        sku, part.qty, fromCellBlockId, targetCell,
        JSON.stringify({ fromQuality, toQuality: targetQuality }), workerKeyId],
    );
  }

  return {
    sku, qty: amount, fromQuality, toQuality: targetQuality,
    fromCellBlockId, toCellBlockId: targetCell, parts: taken,
  };
}

// Снять товар с полки: строки остатка ячейки, начиная с самой давней, — тем
// же правилом, что и отбор на отгрузке, чтобы товар не «молодел» при
// перестановке. Возвращает, сколько снято у какого продавца с какого
// виртуального склада: [{ companyId, vw, qty }]. Нехватка — отказ до того,
// как что-то сдвинулось. Общая для перестановки, брака и раскладки приёмки
// («Переложить», «Убрать из ячейки», receiving/routes.js).
async function takeFromCell(client, warehouseId, {
  cellBlockId, sku, companyId = null, quality = 'good', qty, verb = 'забрать',
  // newest — снимать с самых свежих строк (раскладка приёмки забирает то, что
  // сама положила); по умолчанию — с самой давней.
  newest = false,
  // Виртуальный склад (02.10.2026): undefined — любой, null — «Основной».
  vw,
}) {
  // Блокируем строки источника: два работника, переставляющие один и тот же
  // товар одновременно, не должны оба пройти проверку остатка.
  const source = await client.query(
    `SELECT id, qty, company_id, virtual_warehouse_id FROM cell_stock
     WHERE cell_block_id = $1 AND warehouse_id = $2 AND sku = $3 AND quality = $4
       AND ($5::uuid IS NULL OR company_id = $5::uuid)
       AND (NOT $6::boolean OR virtual_warehouse_id IS NOT DISTINCT FROM $7::uuid)
       AND qty > 0
     ORDER BY ${newest ? 'placed_at DESC, updated_at DESC' : 'updated_at'}
     FOR UPDATE`,
    [cellBlockId, warehouseId, sku, quality, companyId || null, vw !== undefined, vw || null],
  );
  const available = source.rows.reduce((sum, r) => sum + Number(r.qty), 0);
  if (available <= 0) throw new HttpError(409, 'В этой ячейке нет такого товара в таком состоянии');
  if (qty > available) {
    throw new HttpError(409, `В ячейке только ${available}, ${verb} ${qty} нельзя`);
  }

  // Продавца запоминаем построчно. Один артикул у двух продавцов — обычное
  // дело (коды берутся от поставщика), и раньше всё перемещённое ложилось
  // одной строкой на того, чья строка попалась последней: товар продавца А
  // физически становился товаром продавца Б, и оба видели это как факт —
  // и в остатке, и в истории операций.
  let left = qty;
  const takenBy = new Map();
  for (const row of source.rows) {
    if (left <= 0) break;
    const take = Math.min(left, Number(row.qty));
    const rest = Number(row.qty) - take;
    if (rest === 0) {
      await client.query(`DELETE FROM cell_stock WHERE id = $1`, [row.id]);
    } else {
      await client.query(
        `UPDATE cell_stock SET qty = $2, updated_at = now() WHERE id = $1`,
        [row.id, rest],
      );
    }
    const key = `${row.company_id || ''}\u0000${row.virtual_warehouse_id || ''}`;
    const part = takenBy.get(key) || { companyId: row.company_id || null, vw: row.virtual_warehouse_id || null, qty: 0 };
    part.qty += take;
    takenBy.set(key, part);
    left -= take;
  }
  return [...takenBy.values()];
}

module.exports = { moveStock, takeFromCell };
