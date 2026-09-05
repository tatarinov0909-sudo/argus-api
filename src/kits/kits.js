const { HttpError } = require('../middleware/errorHandler');
const { refreshCellFill } = require('../cells/fill');

// Наборы («сплиты»): один артикул в заказе — несколько разных товаров на полке.
//
// Половина живой очереди Wildberries приходит именно так. Пока склад не знает
// состав, такой заказ выглядит как «товара нет», хотя всё нужное лежит рядом.
//
// Два вопроса, на которые здесь есть ответ, и оба — арифметика, не модель:
//   • сколько наборов можно собрать из того, что есть (минимум по компонентам);
//   • собрать столько-то — списать компоненты, положить наборы в ячейку.
//
// Чего здесь сознательно нет: вложенных наборов. Набор из наборов в матрице
// не встречается, а поддержка рекурсии стоила бы обхода графа и защиты от
// циклов ради случая, которого нет. Появится — увидим по CHECK-ошибке импорта.

// «Из чего собирается» — с остатком по каждому компоненту, годным и всего.
// companyId обязателен: один и тот же код у разных продавцов — разный товар.
async function components(client, warehouseId, companyId, kitSku) {
  const rows = await client.query(
    `SELECT k.component_sku, k.qty,
            COALESCE(p.name, (SELECT ii.name FROM invoice_items ii
                              WHERE ii.warehouse_id = k.warehouse_id
                                AND ii.sku = k.component_sku
                              ORDER BY ii.id DESC LIMIT 1)) AS name,
            COALESCE((SELECT SUM(cs.qty) FROM cell_stock cs
                      WHERE cs.warehouse_id = k.warehouse_id
                        AND cs.company_id = k.company_id
                        AND cs.sku = k.component_sku
                        AND cs.quality = 'good'), 0) AS available
     FROM product_kits k
     LEFT JOIN products p
       ON p.warehouse_id = k.warehouse_id AND p.company_id = k.company_id
      AND p.sku = k.component_sku
     WHERE k.warehouse_id = $1 AND k.company_id = $2 AND k.kit_sku = $3
     ORDER BY k.component_sku`,
    [warehouseId, companyId, kitSku],
  );
  return rows.rows.map((r) => ({
    sku: r.component_sku,
    name: r.name || r.component_sku,
    perKit: Number(r.qty),
    available: Number(r.available),
    // Сколько наборов держит лично этот компонент — сразу видно, кто узкое место.
    enoughFor: Math.floor(Number(r.available) / Number(r.qty)),
  }));
}

// null — это не набор. Отличать от «набор, но собрать нельзя»: в первом случае
// нехватка на отгрузке окончательна, во втором её ещё можно закрыть сборкой.
async function kitInfo(client, warehouseId, companyId, kitSku) {
  const parts = await components(client, warehouseId, companyId, kitSku);
  if (parts.length === 0) return null;
  const buildable = Math.min(...parts.map((p) => p.enoughFor));
  return {
    kitSku,
    components: parts,
    buildable,
    // Кто именно не даёт собрать больше. Ради этой строки всё и считается:
    // «наборов 0» бесполезно, «кончилось овсяное печенье» — команда к действию.
    limitedBy: parts.filter((p) => p.enoughFor === buildable).map((p) => p.sku),
  };
}

// Наборы среди списка артикулов — одним запросом. Нужен там, где иначе на
// каждую строку листа сборки уходил бы отдельный поход в базу.
async function kitSkusAmong(client, warehouseId, skus) {
  if (!skus.length) return new Set();
  const rows = await client.query(
    `SELECT DISTINCT kit_sku FROM product_kits
     WHERE warehouse_id = $1 AND kit_sku = ANY($2::text[])`,
    [warehouseId, skus],
  );
  return new Set(rows.rows.map((r) => r.kit_sku));
}

// Списать по ячейкам, начиная с самой давней. Компонент, в отличие от отбора
// на отгрузке, ищется по всему складу, а не в одной ячейке: работник и так
// идёт за ним туда, где он есть.
async function consume(client, warehouseId, companyId, sku, qty) {
  const stock = await client.query(
    `SELECT id, qty, cell_block_id FROM cell_stock
     WHERE warehouse_id = $1 AND company_id = $2 AND sku = $3
       AND qty > 0 AND quality = 'good'
     ORDER BY updated_at
     FOR UPDATE`,
    [warehouseId, companyId, sku],
  );
  const available = stock.rows.reduce((sum, r) => sum + Number(r.qty), 0);
  if (available < qty) {
    throw new HttpError(409, `Компонента ${sku} нужно ${qty}, на складе ${available}`);
  }
  let left = qty;
  const touched = new Set();
  for (const row of stock.rows) {
    if (left <= 0) break;
    const take = Math.min(left, Number(row.qty));
    const rest = Number(row.qty) - take;
    if (rest === 0) {
      await client.query(`DELETE FROM cell_stock WHERE id = $1`, [row.id]);
    } else {
      await client.query(
        `UPDATE cell_stock SET qty = $2, updated_at = now() WHERE id = $1`, [row.id, rest],
      );
    }
    touched.add(row.cell_block_id);
    left -= take;
  }
  return touched;
}

// Собрать наборы: компоненты уходят с полки, наборы ложатся в ячейку.
//
// Целиком в одной транзакции и с FOR UPDATE на каждом компоненте — иначе две
// одновременные сборки обе пройдут проверку остатка и уведут его в минус.
// Проверяем ВСЕ компоненты до первого списания: остановиться на середине —
// значит развалить пригодный к продаже товар и не собрать ничего.
async function assembleKit(client, warehouseId, {
  companyId, kitSku, qty, toCellBlockId, workerKeyId = null,
}) {
  const amount = Number(qty);
  if (!companyId || !kitSku || !toCellBlockId) {
    throw new HttpError(400, 'Нужны продавец, набор и ячейка');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpError(400, 'Количество должно быть больше нуля');
  }

  const cell = await client.query(
    `SELECT id FROM cell_blocks WHERE id = $1 AND warehouse_id = $2`,
    [toCellBlockId, warehouseId],
  );
  if (!cell.rows[0]) throw new HttpError(404, 'Ячейка не найдена');

  const parts = await components(client, warehouseId, companyId, kitSku);
  if (parts.length === 0) throw new HttpError(404, 'Состав набора неизвестен');

  const short = parts.filter((p) => p.available < p.perKit * amount);
  if (short.length) {
    const names = short.map((p) => `${p.name}: нужно ${p.perKit * amount}, есть ${p.available}`);
    throw new HttpError(409, `Не хватает компонентов — ${names.join('; ')}`);
  }

  const cellsTouched = new Set([toCellBlockId]);
  for (const p of parts) {
    const from = await consume(client, warehouseId, companyId, p.sku, p.perKit * amount);
    for (const id of from) cellsTouched.add(id);
  }

  await client.query(
    `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty, quality)
     VALUES ($1, $2, $3, $4, $5, 'good')`,
    [toCellBlockId, warehouseId, companyId, kitSku, amount],
  );

  // Пересчитываем заполненность и у ячейки назначения, и у каждой, откуда
  // забирали: иначе карта склада продолжит красить занятыми опустевшие ячейки.
  for (const id of cellsTouched) await refreshCellFill(client, id);

  // След операции. У сборки нет накладной, к которой можно привязаться, —
  // значит без этой записи остаток меняется, а кто и когда, неизвестно. Ровно
  // на это упирается любой спор о недостаче.
  await client.query(
    `INSERT INTO stock_operations
       (warehouse_id, company_id, kind, sku, qty, to_cell_block_id, details, worker_key_id)
     VALUES ($1, $2, 'kit_assemble', $3, $4, $5, $6, $7)`,
    [warehouseId, companyId, kitSku, amount, toCellBlockId,
      JSON.stringify({ components: parts.map((p) => ({ sku: p.sku, taken: p.perKit * amount })) }),
      workerKeyId],
  );

  return { kitSku, qty: amount, toCellBlockId, components: parts.map((p) => ({
    sku: p.sku, name: p.name, taken: p.perKit * amount,
  })) };
}

module.exports = { components, kitInfo, kitSkusAmong, assembleKit };
