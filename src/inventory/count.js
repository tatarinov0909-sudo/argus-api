const { HttpError } = require('../middleware/errorHandler');

const QUALITIES = new Set(['good', 'defective', 'packaging_defect']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keyOf = (line) => `${line.sku}|${line.companyId || ''}|${line.quality}`;

function validateCountLines(lines, expected) {
  if (!Array.isArray(lines) || lines.length > 1000) {
    throw new HttpError(400, 'Нужен список посчитанного: не более 1000 строк');
  }
  const seen = new Set();
  const counted = lines.map((line) => {
    if (!line || typeof line !== 'object' || Array.isArray(line)
      || typeof line.sku !== 'string' || !line.sku.trim() || line.sku.length > 200) {
      throw new HttpError(400, 'В каждой строке нужен артикул выбранного товара');
    }
    const companyId = typeof line.companyId === 'string' ? line.companyId.toLowerCase() : null;
    if (!companyId || !UUID.test(companyId)) {
      throw new HttpError(400, 'Выберите продавца для каждой строки пересчёта');
    }
    if (!QUALITIES.has(line.quality)) {
      throw new HttpError(400, 'Укажите состояние товара: годный, брак или брак упаковки');
    }
    if (!Number.isSafeInteger(line.qty) || line.qty < 0) {
      throw new HttpError(400, 'Введите фактически посчитанное целое неотрицательное количество в каждой строке');
    }
    const clean = { sku: line.sku.trim(), companyId, quality: line.quality, qty: line.qty };
    const key = keyOf(clean);
    if (seen.has(key)) throw new HttpError(400, 'Товар этого продавца в таком состоянии повторяется — укажите его одной строкой');
    seen.add(key);
    return clean;
  });
  for (const line of expected || []) {
    if (!seen.has(keyOf(line))) {
      throw new HttpError(400, 'Посчитайте все строки ячейки. Если товара нет, явно укажите ноль');
    }
  }
  return counted;
}

module.exports = { validateCountLines, keyOf };
