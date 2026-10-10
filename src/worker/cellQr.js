const { HttpError } = require('../middleware/errorHandler');
const { blockLabelSql } = require('../cells/label');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PREFIX = 'argus:cell:v1:';
const QR = new RegExp(`^${PREFIX}(${UUID}):(${UUID})$`, 'i');
const ID = new RegExp(`^${UUID}$`, 'i');

function parse(value) {
  const match = typeof value === 'string' && QR.exec(value.trim());
  if (!match) throw new HttpError(400, 'Нужен QR ячейки Аргуса', { code: 'invalid_cell_qr' });
  return { warehouseId: match[1].toLowerCase(), cellBlockId: match[2].toLowerCase() };
}

async function cell(client, warehouseId, cellBlockId) {
  if (!ID.test(String(cellBlockId || ''))) throw new HttpError(404, 'Ячейка не найдена');
  const row = (await client.query(
    `SELECT cb.id, ${blockLabelSql('cb', 'wr')} AS label
       FROM cell_blocks cb JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
      WHERE cb.id = $1 AND cb.warehouse_id = $2 FOR SHARE OF cb`, [cellBlockId, warehouseId],
  )).rows[0];
  if (!row) throw new HttpError(404, 'Ячейка не найдена', { code: 'cell_not_found' });
  return { cellBlockId: row.id, label: row.label, qr: `${PREFIX}${warehouseId}:${row.id}` };
}

async function verify(client, warehouseId, value, expectedCellId) {
  const scanned = parse(value);
  if (scanned.warehouseId !== warehouseId.toLowerCase()) {
    throw new HttpError(409, 'Это ячейка другого склада', { code: 'wrong_cell_warehouse' });
  }
  if (expectedCellId && scanned.cellBlockId !== String(expectedCellId).toLowerCase()) {
    throw new HttpError(409, 'Отсканирована другая ячейка — проверьте адрес', { code: 'wrong_cell' });
  }
  return cell(client, warehouseId, scanned.cellBlockId);
}

module.exports = { PREFIX, parse, cell, verify };
