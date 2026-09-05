const { HttpError } = require('../middleware/errorHandler');
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
}) {
  const amount = Number(qty);
  if (!sku || !fromCellBlockId || !amount) {
    throw new HttpError(400, 'Нужны товар, ячейка-источник и количество');
  }
  if (amount <= 0) throw new HttpError(400, 'Количество должно быть больше нуля');

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

  // Блокируем строки источника: два работника, переставляющие один и тот же
  // товар одновременно, не должны оба пройти проверку остатка.
  const source = await client.query(
    `SELECT id, qty, company_id FROM cell_stock
     WHERE cell_block_id = $1 AND warehouse_id = $2 AND sku = $3 AND quality = $4
       AND ($5::uuid IS NULL OR company_id = $5::uuid)
       AND qty > 0
     ORDER BY updated_at
     FOR UPDATE`,
    [fromCellBlockId, warehouseId, sku, fromQuality, companyId || null],
  );
  const available = source.rows.reduce((sum, r) => sum + Number(r.qty), 0);
  if (available <= 0) throw new HttpError(409, 'В этой ячейке нет такого товара в таком состоянии');
  if (amount > available) {
    throw new HttpError(409, `В ячейке только ${available}, переместить ${amount} нельзя`);
  }

  // Списываем со старых строк, начиная с самой давней, — тем же правилом, что
  // и отбор на отгрузке, чтобы товар не «молодел» при перестановке.
  let left = amount;
  let movedCompanyId = companyId || source.rows[0].company_id;
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
    movedCompanyId = row.company_id;
    left -= take;
  }

  await client.query(
    `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty, quality)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [targetCell, warehouseId, movedCompanyId, sku, amount, targetQuality],
  );

  await refreshCellFill(client, fromCellBlockId);
  if (targetCell !== fromCellBlockId) await refreshCellFill(client, targetCell);

  // След операции: у перепаковки и перестановки тоже нет накладной, а остаток
  // они двигают. Перепаковку отличаем от простой перестановки по тому, менялось
  // ли состояние товара — для продавца это разные события.
  await client.query(
    `INSERT INTO stock_operations
       (warehouse_id, company_id, kind, sku, qty,
        from_cell_block_id, to_cell_block_id, details, worker_key_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [warehouseId, movedCompanyId, targetQuality === fromQuality ? 'move' : 'repack',
      sku, amount, fromCellBlockId, targetCell,
      JSON.stringify({ fromQuality, toQuality: targetQuality }), workerKeyId],
  );

  return {
    sku, qty: amount, fromQuality, toQuality: targetQuality,
    fromCellBlockId, toCellBlockId: targetCell,
  };
}

module.exports = { moveStock };
