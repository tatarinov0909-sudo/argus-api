// Первичная загрузка остатков по ячейкам.
//
// Товар физически лежит на полках, а в ячейках Аргуса его ноль: склад жил
// в 1С, и Аргус знает только учётное «сколько всего», но не «где сколько».
// Пока ячейки пустые, отбор, лист грузчика и лист комплектации идти некуда —
// у поставки из 149 заказов на листе не было ни одного адреса.
//
// Склад считает полки и приносит файл «ячейка — артикул — количество»,
// владелец загружает его одним заходом. Правила:
//
//   * Количество — только посчитанное на полке. Учётное число 1С сюда не
//     подставляется и по адресам не раскладывается: то, что 1С знает про
//     товар, не значит, что он лежит там в таком количестве.
//   * В 1С ничего не уходит. Ни в очередь обмена, ни косвенно: 1С это
//     количество уже знает, и приход из Аргуса задвоил бы его там.
//   * Повторная загрузка ничего не задваивает. Строку, которую уже загружали
//     с тем же количеством, узнаём по истории загрузок и пропускаем («уже
//     загружено») — даже если товар с тех пор забрали отбором. С другим
//     количеством — ошибка: сначала отменить ту загрузку.
//   * Только в пустое место: если товар лежит там после приёмки или
//     перемещения, строка отклоняется — принятое через Аргус не трогаем.
//   * Всё или ничего: одна ошибка — и не загружено ничего. Половина файла
//     в базе хуже, чем ни одной строки: непонятно, что исправлять.
//   * Ошибку исправляет отмена загрузки целиком — пока её товар никто не
//     трогал: не отбирали, не перемещали, не пересчитывали. Чужие движения в
//     тех же ячейках (приёмка, загрузка другого продавца) отмене не мешают.
//     Пересчёт для исправления не годится: принятый пересчёт ставит разницу
//     в очередь для 1С, а начальный остаток 1С и так знает.
const crypto = require('crypto');
const { HttpError } = require('../middleware/errorHandler');
const { refreshCellFill } = require('./fill');
const { formatBlockLabel } = require('./label');
const { plural } = require('../journal/plural');
const journal = require('../journal/repository');

// Столько строк за раз. У склада ячеек несколько тысяч; больше — частями,
// и каждая часть атомарна.
const MAX_ROWS = 5000;
const MAX_QTY = 1000000;

// Состояние товара словами из бланка. Пусто — годный: так его и считают.
const QUALITY_WORDS = new Map([
  ['', 'good'], ['годный', 'good'], ['годное', 'good'], ['good', 'good'],
  ['брак', 'defective'], ['defective', 'defective'],
  ['брак упаковки', 'packaging_defect'], ['повреждена упаковка', 'packaging_defect'],
  ['packaging_defect', 'packaging_defect'],
]);

// Имя ячейки для сравнения: без регистра, пробелов и ведущих нулей.
// «1-3-11» и «01-03-011» — одна табличка. Разделители при этом значимы:
// «1.3.11» — наш адрес «ряд.ярус.ячейка», это другое место, и совпасть
// с табличкой «01-03-011» оно не должно.
function cellKey(text) {
  return String(text).trim().toUpperCase().replace(/\s+/g, '')
    .replace(/\d+/g, (d) => String(Number(d)));
}

const skuKey = (text) => String(text).trim().toUpperCase();

function parseQty(value) {
  const text = String(value ?? '').replace(/[\s ]/g, '').replace(',', '.');
  if (text === '') return { empty: true };
  const n = Number(text);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > MAX_QTY) {
    return { error: 'количество должно быть целым числом от 1 до миллиона' };
  }
  return n === 0 ? { empty: true } : { qty: n };
}

// Все ячейки склада по всем именам, под которыми их знают люди: табличка
// со стеллажа (label) и наш адрес «ряд.ярус.ячейка» — его показывают карта,
// экран грузчика и выгрузка остатков (formatBlockLabel, решение 24.09.2026).
// У объединённой ячейки наш адрес — любое место внутри неё.
async function cellIndex(client, warehouseId) {
  const r = await client.query(
    `SELECT cb.id, cb.label, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end,
            wr.row_num, wr.label AS row_label
       FROM cell_blocks cb JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
      WHERE cb.warehouse_id = $1`,
    [warehouseId],
  );
  const byKey = new Map();
  const labelOf = new Map();
  const add = (key, id) => {
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key).add(id);
  };
  for (const b of r.rows) {
    labelOf.set(b.id, formatBlockLabel(b.row_num, b));
    if (b.label) add(cellKey(b.label), b.id);
    for (let rack = b.rack_start; rack <= b.rack_end; rack += 1) {
      for (let tier = b.tier_start; tier <= b.tier_end; tier += 1) {
        add(cellKey(`${b.row_num}.${tier}.${rack}`), b.id);
        // Имя ряда, которое владелец дал сам («А»), — так адрес пишет кабинет.
        if (b.row_label) add(cellKey(`${b.row_label}.${tier}.${rack}`), b.id);
      }
    }
  }
  return { byKey, labelOf };
}

async function sellerOf(client, warehouseId, companyId) {
  if (typeof companyId !== 'string' || !companyId) throw new HttpError(400, 'Выберите продавца');
  const r = await client.query(
    `SELECT id, name FROM companies
      WHERE warehouse_id = $1 AND id::text = $2 AND archived_at IS NULL`,
    [warehouseId, companyId],
  );
  if (!r.rows[0]) throw new HttpError(404, 'Продавец не найден');
  return r.rows[0];
}

// Проверка файла. С lock=true ячейки из файла блокируются до конца
// транзакции, и проверка «уже лежит» идёт после блокировки: вторая загрузка
// того же файла, нажатая одновременно с первой, дождётся её и получит отказ.
async function plan(client, warehouseId, { companyId, rows }, { lock = false } = {}) {
  const seller = await sellerOf(client, warehouseId, companyId);
  if (!Array.isArray(rows) || rows.length === 0) throw new HttpError(400, 'В файле нет строк');
  if (rows.length > MAX_ROWS) {
    throw new HttpError(400, `За раз — не больше ${MAX_ROWS} строк. Разбейте файл на части`);
  }

  const cells = await cellIndex(client, warehouseId);
  const products = await client.query(
    `SELECT sku, name, barcode, stock_qty_1c FROM products
      WHERE warehouse_id = $1 AND company_id = $2 AND active`,
    [warehouseId, seller.id],
  );
  const bySku = new Map();
  const byBarcode = new Map();
  for (const p of products.rows) {
    const key = skuKey(p.sku);
    bySku.set(key, bySku.has(key) ? null : p);   // null — неоднозначно
    const bc = String(p.barcode || '').trim();
    if (bc) byBarcode.set(bc, byBarcode.has(bc) ? null : p);
  }

  const lines = [];
  let skipped = 0;
  rows.forEach((row, i) => {
    const r = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
    const line = {
      line: Number.isInteger(r.line) && r.line > 0 ? r.line : i + 1,
      cell: String(r.cell ?? '').trim().slice(0, 100),
      sku: String(r.sku ?? '').trim().slice(0, 200),
      qty: null,
      quality: 'good',
      error: null,
    };
    const qty = parseQty(r.qty);
    // Не посчитано — строка бланка, которую не заполнили. Это не ошибка:
    // бланк выдаётся на весь каталог, а посчитать успевают часть.
    if (qty.empty) { skipped += 1; return; }
    lines.push(line);
    if (qty.error) { line.error = qty.error; return; }
    line.qty = qty.qty;

    const seller1 = String(r.seller ?? '').trim();
    if (seller1 && seller1.toLowerCase() !== String(seller.name).trim().toLowerCase()) {
      line.error = `строка другого продавца («${seller1}»): загружаем только «${seller.name}»`;
      return;
    }
    const quality = QUALITY_WORDS.get(String(r.quality ?? '').trim().toLowerCase());
    if (!quality) {
      line.error = 'состояние — «годный», «брак» или «брак упаковки»';
      return;
    }
    line.quality = quality;

    if (r.cellIsDate === true) {
      line.error = 'Excel превратил адрес ячейки в дату. Поставьте колонке «Ячейка» формат «Текстовый» и впишите адрес заново';
      return;
    }
    if (!line.cell) { line.error = 'не указана ячейка'; return; }
    // «01.02.005» — табличка, записанная через точки. Без нулей это наш адрес
    // «1.2.5», то есть совсем другая полка (ярус 10 на карте стоит вторым).
    // Молча положить товар туда хуже, чем переспросить.
    if (line.cell.includes('.') && /(^|\D)0\d/.test(line.cell)) {
      line.error = 'похоже на табличку со стеллажа, записанную через точки, — впишите через дефис, как на табличке (например 01-03-011)';
      return;
    }
    const hits = cells.byKey.get(cellKey(line.cell));
    if (!hits) { line.error = `ячейки «${line.cell}» на складе нет`; return; }
    if (hits.size > 1) {
      line.error = `адрес «${line.cell}» подходит к ${hits.size} ячейкам — укажите имя с таблички`;
      return;
    }
    line.cellId = [...hits][0];
    line.cellLabel = cells.labelOf.get(line.cellId);

    if (!line.sku) { line.error = 'не указан артикул'; return; }
    let product = bySku.get(skuKey(line.sku));
    if (product === undefined) product = byBarcode.get(line.sku);
    if (product === undefined) {
      line.error = `у «${seller.name}» нет товара «${line.sku}»`;
      return;
    }
    if (product === null) {
      line.error = `«${line.sku}» подходит к нескольким товарам — укажите артикул точно`;
      return;
    }
    line.sku = product.sku;
    line.name = product.name;
  });

  // Повтор в самом файле: одну полку посчитали дважды. Складывать нельзя —
  // так двое, посчитавшие одну ячейку, удвоили бы товар.
  const seen = new Map();
  for (const l of lines) {
    if (l.error) continue;
    const key = `${l.cellId}|${l.sku}|${l.quality}`;
    if (seen.has(key)) {
      l.error = `повтор строки ${seen.get(key)}: этот товар в этой ячейке уже есть в файле`;
    } else {
      seen.set(key, l.line);
    }
  }

  const cellIds = [...new Set(lines.filter((l) => l.cellId).map((l) => l.cellId))].sort();
  if (lock && cellIds.length) {
    await client.query(
      `SELECT id FROM cell_blocks WHERE warehouse_id = $1 AND id = ANY($2::uuid[])
        ORDER BY id FOR UPDATE`,
      [warehouseId, cellIds],
    );
  }

  if (cellIds.length) {
    const keyOf = (cell, sku, quality) => `${cell}|${sku}|${quality}`;
    // Что уже загружали сюда раньше (не считая отменённых загрузок). По этому
    // повторная загрузка узнаёт свои строки, даже если товар с тех пор
    // забрали отбором и в ячейке пусто.
    const history = await client.query(
      `SELECT op.to_cell_block_id AS cell, op.sku, COALESCE(op.details->>'quality', 'good') AS quality,
              SUM(op.qty) AS qty, MAX(op.created_at) AS at,
              array_agg(op.details->>'cellStockId') FILTER (WHERE op.details ? 'cellStockId') AS stock_ids
         FROM stock_operations op
        WHERE op.warehouse_id = $1 AND op.company_id = $2 AND op.kind = 'initial_load'
          AND op.to_cell_block_id = ANY($3::uuid[])
          AND NOT EXISTS (SELECT 1 FROM stock_operations u
                           WHERE u.warehouse_id = $1 AND u.kind = 'initial_load_undo'
                             AND u.details->>'batch' = op.details->>'batch')
        GROUP BY 1, 2, 3`,
      [warehouseId, seller.id, cellIds],
    );
    const before = new Map(history.rows.map((h) => [keyOf(h.cell, h.sku, h.quality),
      { qty: Number(h.qty), at: h.at }]));
    // «Уже лежит» — то, что положили приёмка, возврат или перемещение, в любом
    // состоянии: брак, посчитанный поверх принятого годного, — это те же
    // штуки, а не новые. Строки, положенные прошлыми загрузками, не в счёт:
    // их узнаёт история выше.
    const fromLoads = history.rows.flatMap((h) => h.stock_ids || []);
    const existing = await client.query(
      `SELECT cell_block_id, sku, SUM(qty) AS qty FROM cell_stock
        WHERE warehouse_id = $1 AND company_id = $2 AND cell_block_id = ANY($3::uuid[]) AND qty > 0
          AND NOT (id::text = ANY($4::text[]))
        GROUP BY 1, 2`,
      [warehouseId, seller.id, cellIds, fromLoads],
    );
    const lying = new Map(existing.rows.map((e) => [`${e.cell_block_id}|${e.sku}`, Number(e.qty)]));
    // Назначен пересчёт — ячейку не трогаем: снимок задания устарел бы, и
    // посчитанное расхождение ушло бы в никуда.
    const counting = await client.query(
      `SELECT DISTINCT cell_block_id FROM inventory_tasks
        WHERE warehouse_id = $1 AND cell_block_id = ANY($2::uuid[])
          AND status IN ('pending', 'waiting_owner')`,
      [warehouseId, cellIds],
    );
    const busy = new Set(counting.rows.map((c) => c.cell_block_id));
    const day = (at) => new Date(at).toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });
    for (const l of lines) {
      if (l.error || !l.cellId) continue;
      const key = keyOf(l.cellId, l.sku, l.quality);
      const prior = before.get(key);
      if (prior && prior.qty === l.qty) {
        l.already = day(prior.at);
      } else if (prior) {
        l.error = `${day(prior.at)} сюда уже загрузили ${prior.qty} шт. этого товара — `
          + 'если там ошибка, отмените ту загрузку и загрузите заново; если отменить уже нельзя, уберите строку из файла';
      } else if (busy.has(l.cellId)) {
        l.error = 'по этой ячейке назначен пересчёт — сначала закройте задание, потом загружайте';
      } else if (lying.has(`${l.cellId}|${l.sku}`)) {
        l.error = `здесь уже лежит ${lying.get(`${l.cellId}|${l.sku}`)} шт. этого товара, принятых через Аргус, — `
          + 'загрузка кладёт только в пустое место; уберите строку из файла';
      }
    }
  }

  const ok = lines.filter((l) => !l.error && !l.already);
  const loaded = new Map();
  for (const l of ok) loaded.set(l.sku, (loaded.get(l.sku) || 0) + l.qty);
  // Что уже лежит у продавца во всех ячейках: файл грузят частями, и сверка
  // одной части без уже разложенного врёт — «загружаете 10, по 1С 30», когда
  // остальные 20 легли вчера.
  const inCellsRows = await client.query(
    `SELECT sku, SUM(qty) AS qty FROM cell_stock
      WHERE warehouse_id = $1 AND company_id = $2 AND qty > 0 GROUP BY sku`,
    [warehouseId, seller.id],
  );
  const inCells = new Map(inCellsRows.rows.map((r) => [r.sku, Number(r.qty)]));
  // Сверка с 1С — только для глаз: ничего не меняет и ничего не решает,
  // но расхождение владелец увидит до загрузки, а не после.
  const vs1c = products.rows
    .filter((p) => loaded.has(p.sku) && p.stock_qty_1c != null
      && Number(p.stock_qty_1c) !== loaded.get(p.sku) + (inCells.get(p.sku) || 0))
    .map((p) => ({ sku: p.sku, name: p.name, loaded: loaded.get(p.sku),
      inCells: inCells.get(p.sku) || 0, stock1c: Number(p.stock_qty_1c) }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ru'));
  const notInFile = products.rows
    .filter((p) => Number(p.stock_qty_1c) > 0 && !loaded.has(p.sku) && !inCells.has(p.sku)).length;

  return {
    seller: { id: seller.id, name: seller.name },
    lines,
    summary: {
      lines: lines.length,
      ok: ok.length,
      errors: lines.filter((l) => l.error).length,
      already: lines.filter((l) => l.already).length,
      skipped,
      units: ok.reduce((s, l) => s + l.qty, 0),
      cells: new Set(ok.map((l) => l.cellId)).size,
      products: loaded.size,
      vs1c,
      notInFile,
    },
  };
}

// basis — откуда количество: 'count' — посчитано на полке (так грузит окно),
// 'accounting' — учётное число 1С, разложенное по плану. Второе пишется в
// журнал прямо так: «не пересчёт». Выдавать план за подсчёт нельзя.
async function apply(client, warehouseId, body, { ownerId, basis = 'count' }) {
  const checked = await plan(client, warehouseId, body, { lock: true });
  if (checked.summary.errors > 0 || checked.summary.ok === 0) {
    return { applied: false, ...checked };
  }
  // Загружаем ровно то, что владелец видел в проверке и подтвердил. Если за
  // это время план изменился (отменили прошлую загрузку в другом окне,
  // приняли товар), цифры в подтверждении были бы уже не про это.
  const expect = body.expect;
  if (expect && (Number(expect.ok) !== checked.summary.ok || Number(expect.units) !== checked.summary.units)) {
    return { applied: false, stale: true, ...checked };
  }
  const batch = crypto.randomUUID();
  const ok = checked.lines.filter((l) => !l.error && !l.already);
  for (const l of ok) {
    // source=NULL: это наблюдение склада — посчитано на полке, а не выведено
    // из учёта. Происхождение видно в stock_operations.
    const inserted = await client.query(
      `INSERT INTO cell_stock (warehouse_id, company_id, cell_block_id, sku, qty, quality, source)
       VALUES ($1, $2, $3, $4, $5, $6, NULL) RETURNING id`,
      [warehouseId, checked.seller.id, l.cellId, l.sku, l.qty, l.quality],
    );
    l.cellStockId = inserted.rows[0].id;
  }
  const cellIds = [...new Set(ok.map((l) => l.cellId))].sort();
  for (const l of ok) {
    // cellStockId — строка остатка, которую положила эта загрузка. По ней
    // отмена узнаёт свой товар и видит, трогали ли его с тех пор.
    await client.query(
      `INSERT INTO stock_operations (warehouse_id, company_id, kind, sku, qty, to_cell_block_id, details)
       VALUES ($1, $2, 'initial_load', $3, $4, $5, $6::jsonb)`,
      [warehouseId, checked.seller.id, l.sku, l.qty, l.cellId,
        JSON.stringify({ batch, line: l.line, quality: l.quality, ownerId, cellStockId: l.cellStockId, basis })],
    );
  }
  for (const id of cellIds) await refreshCellFill(client, id);

  const s = checked.summary;
  // Одна запись на загрузку, а не на строку: журнал только дописывается,
  // и тысяча строк утопила бы в нём всё остальное.
  await journal.createEntry(client, {
    warehouseId,
    agent: 'Кладовщик',
    actionText: `Загружены остатки по ячейкам, продавец «${checked.seller.name}»: `
      + `${s.units} шт., ${s.products} ${plural(s.products, 'товар', 'товара', 'товаров')} `
      + `в ${s.cells} ${plural(s.cells, 'ячейке', 'ячейках', 'ячейках')}. `
      + (basis === 'accounting'
        ? 'Количество — по учёту 1С, разложено по плану раскладки, а не посчитано на полках; в 1С ничего не отправлялось.'
        : 'Количество — по пересчёту склада; в 1С ничего не отправлялось.'),
    entityType: 'company',
    entityId: checked.seller.id,
    actorType: 'owner',
    actorId: ownerId,
  });
  return { applied: true, batch, seller: checked.seller, summary: s };
}

// Последние загрузки — чтобы было что отменить.
//
// Отменить можно, пока товар загрузки никто не трогал: каждая её строка
// остатка на месте — та же ячейка, продавец, товар, состояние и количество.
// Чужие движения в тех же ячейках отмене не мешают.
async function batches(client, warehouseId) {
  const r = await client.query(
    `SELECT b.*,
            EXISTS (SELECT 1 FROM stock_operations u
                     WHERE u.warehouse_id = $1 AND u.kind = 'initial_load_undo'
                       AND u.details->>'batch' = b.batch) AS undone,
            EXISTS (SELECT 1 FROM inventory_tasks t
                     WHERE t.warehouse_id = $1 AND t.cell_block_id = ANY(b.cell_ids)
                       AND t.status IN ('pending', 'waiting_owner')) AS counting
       FROM (SELECT op.details->>'batch' AS batch, MIN(op.created_at) AS at, op.company_id,
                    MAX(c.name) AS company_name, SUM(op.qty) AS units, COUNT(*)::int AS lines,
                    COUNT(DISTINCT op.to_cell_block_id)::int AS cells,
                    array_agg(DISTINCT op.to_cell_block_id) AS cell_ids,
                    BOOL_OR(NOT (op.details ? 'cellStockId')) AS legacy,
                    BOOL_AND(cs.id IS NOT NULL AND cs.cell_block_id = op.to_cell_block_id
                             AND cs.company_id = op.company_id AND cs.sku = op.sku
                             AND cs.quality::text = COALESCE(op.details->>'quality', 'good')
                             AND cs.qty = op.qty) AS intact
               FROM stock_operations op
               LEFT JOIN companies c ON c.id = op.company_id
               LEFT JOIN cell_stock cs ON cs.id::text = op.details->>'cellStockId'
              WHERE op.warehouse_id = $1 AND op.kind = 'initial_load'
              GROUP BY 1, op.company_id) b
      ORDER BY b.at DESC
      LIMIT 20`,
    [warehouseId],
  );
  return r.rows.map((b) => ({
    batch: b.batch,
    at: b.at,
    companyId: b.company_id,
    companyName: b.company_name,
    units: Number(b.units),
    lines: b.lines,
    cells: b.cells,
    undone: b.undone,
    // Почему нельзя — одним словом для окна: legacy (до появления отмены),
    // touched (товар трогали), counting (назначен пересчёт).
    blocked: b.undone ? null : b.legacy ? 'legacy' : b.intact !== true ? 'touched' : b.counting ? 'counting' : null,
    canUndo: !b.undone && !b.legacy && b.intact === true && !b.counting,
  }));
}

async function undo(client, warehouseId, batch, { ownerId }) {
  if (typeof batch !== 'string' || !/^[0-9a-f-]{36}$/i.test(batch)) {
    throw new HttpError(404, 'Загрузка не найдена');
  }
  const ops = await client.query(
    `SELECT op.id, op.company_id, op.sku, op.qty, op.to_cell_block_id, op.details, op.created_at,
            c.name AS company_name
       FROM stock_operations op LEFT JOIN companies c ON c.id = op.company_id
      WHERE op.warehouse_id = $1 AND op.kind = 'initial_load' AND op.details->>'batch' = $2`,
    [warehouseId, batch],
  );
  if (!ops.rows.length) throw new HttpError(404, 'Загрузка не найдена');
  if (ops.rows.some((o) => !o.details.cellStockId)) {
    throw new HttpError(409, 'Эта загрузка сделана до появления отмены — отменить её нельзя');
  }
  if (ops.rows.some((o) => !o.to_cell_block_id)) {
    throw new HttpError(409, 'Одну из ячеек этой загрузки уже удалили — отменить загрузку нельзя');
  }
  const cellIds = [...new Set(ops.rows.map((o) => o.to_cell_block_id))].sort();
  // Та же очерёдность блокировок, что у загрузки: ячейки по возрастанию id.
  const locked = await client.query(
    `SELECT id FROM cell_blocks WHERE warehouse_id = $1 AND id = ANY($2::uuid[])
      ORDER BY id FOR UPDATE`,
    [warehouseId, cellIds],
  );
  if (locked.rows.length !== cellIds.length) {
    throw new HttpError(409, 'Одну из ячеек этой загрузки уже удалили — отменить загрузку нельзя');
  }
  // «Уже отменена» — после блокировки: вторая одновременная отмена дождётся
  // первой и получит честный ответ, а не «товар трогали».
  const done = await client.query(
    `SELECT 1 FROM stock_operations
      WHERE warehouse_id = $1 AND kind = 'initial_load_undo' AND details->>'batch' = $2 LIMIT 1`,
    [warehouseId, batch],
  );
  if (done.rows.length) throw new HttpError(409, 'Эта загрузка уже отменена');

  const ids = ops.rows.map((o) => o.details.cellStockId);
  const rows = await client.query(
    `SELECT id, cell_block_id, company_id, sku, quality::text AS quality, qty FROM cell_stock
      WHERE warehouse_id = $1 AND id::text = ANY($2::text[]) ORDER BY id FOR UPDATE`,
    [warehouseId, ids],
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r]));
  const touched = ops.rows.filter((o) => {
    const r = byId.get(o.details.cellStockId);
    return !r || r.cell_block_id !== o.to_cell_block_id || r.company_id !== o.company_id
      || r.sku !== o.sku || r.quality !== (o.details.quality || 'good') || Number(r.qty) !== Number(o.qty);
  });
  if (touched.length) {
    throw new HttpError(409, `Товар этой загрузки уже трогали — отбирали, перемещали или пересчитывали `
      + `(${touched.length} ${plural(touched.length, 'строка', 'строки', 'строк')}). Отменить загрузку целиком нельзя`);
  }
  const counting = await client.query(
    `SELECT 1 FROM inventory_tasks WHERE warehouse_id = $1 AND cell_block_id = ANY($2::uuid[])
        AND status IN ('pending', 'waiting_owner') LIMIT 1`,
    [warehouseId, cellIds],
  );
  if (counting.rows.length) {
    throw new HttpError(409, 'По ячейкам этой загрузки назначен пересчёт — сначала закройте задание');
  }

  await client.query('DELETE FROM cell_stock WHERE warehouse_id = $1 AND id::text = ANY($2::text[])',
    [warehouseId, ids]);
  for (const o of ops.rows) {
    await client.query(
      `INSERT INTO stock_operations (warehouse_id, company_id, kind, sku, qty, from_cell_block_id, details)
       VALUES ($1, $2, 'initial_load_undo', $3, $4, $5, $6::jsonb)`,
      [warehouseId, o.company_id, o.sku, o.qty, o.to_cell_block_id,
        JSON.stringify({ batch, quality: o.details.quality || 'good', ownerId })],
    );
  }
  for (const id of cellIds) await refreshCellFill(client, id);

  const units = ops.rows.reduce((s, o) => s + Number(o.qty), 0);
  const when = new Date(ops.rows[0].created_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow',
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  await journal.createEntry(client, {
    warehouseId,
    agent: 'Кладовщик',
    actionText: `Отменена загрузка остатков от ${when}, продавец «${ops.rows[0].company_name}»: `
      + `${units} шт. сняты из ${cellIds.length} ${plural(cellIds.length, 'ячейки', 'ячеек', 'ячеек')}. `
      + 'В 1С ничего не отправлялось.',
    entityType: 'company',
    entityId: ops.rows[0].company_id,
    actorType: 'owner',
    actorId: ownerId,
  });
  return { undone: true, batch, units, cells: cellIds.length };
}

// Бланк для обхода: весь каталог продавца, ячейка — там, где её знает 1С.
// Количество пустое — его вписывают у полки. Учёт 1С стоит отдельной колонкой
// «для сверки», в «Количество» он не подставляется.
async function template(client, warehouseId, companyId) {
  const seller = await sellerOf(client, warehouseId, companyId);
  const r = await client.query(
    `SELECT p.sku, p.name, p.barcode, p.stock_qty_1c,
            COALESCE(array_agg(DISTINCT pc.cell_name ORDER BY pc.cell_name)
                     FILTER (WHERE pc.cell_name IS NOT NULL), '{}') AS cells_1c
       FROM products p
       LEFT JOIN product_cells_1c pc
              ON pc.warehouse_id = p.warehouse_id AND pc.company_id = p.company_id AND pc.sku = p.sku
      WHERE p.warehouse_id = $1 AND p.company_id = $2 AND p.active
      GROUP BY p.id
      ORDER BY (COALESCE(p.stock_qty_1c, 0) > 0) DESC, p.name`,
    [warehouseId, seller.id],
  );
  return {
    seller: { id: seller.id, name: seller.name },
    products: r.rows.map((p) => ({
      sku: p.sku,
      name: p.name,
      barcode: p.barcode || null,
      stock1c: p.stock_qty_1c == null ? null : Number(p.stock_qty_1c),
      cells1c: p.cells_1c,
    })),
  };
}

module.exports = { plan, apply, template, batches, undo, cellKey, MAX_ROWS };
