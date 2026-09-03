// Кладовщик — rule layer only. "решают правила, ИИ только объясняет":
// this module answers questions with plain DB queries; no LLM here.
// Natural-language explanation is a thin layer on top, added separately
// once there's an API key to call.

// Ищем и по справочнику, и по тому, что физически лежит в ячейках. Только по
// справочнику было мало: товар, приехавший накладной без карточки в 1С,
// существовал на полке, но на вопрос «где он?» Кладовщик отвечал «не найдено».
// На живой базе таких артикулов было двое из 633 — редко, но именно про такой
// товар и спрашивают, когда он потерялся.
async function findProducts(client, warehouseId, query) {
  const products = await client.query(
    `SELECT p.sku, p.name, p.category, p.weight_g
     FROM products p
     WHERE p.warehouse_id = $1 AND p.active AND (p.sku ILIKE $2 OR p.name ILIKE $2)

     UNION

     -- То, что лежит в ячейках, но карточки не имеет. Имя берём из последней
     -- накладной, где этот артикул встречался, — иначе человек увидит голый код.
     SELECT cs.sku, COALESCE(
              (SELECT ii.name FROM invoice_items ii
               WHERE ii.warehouse_id = cs.warehouse_id AND ii.sku = cs.sku
               ORDER BY ii.id DESC LIMIT 1), cs.sku) AS name,
            NULL AS category, NULL AS weight_g
     FROM cell_stock cs
     WHERE cs.warehouse_id = $1 AND cs.qty > 0
       AND NOT EXISTS (SELECT 1 FROM products p2
                       WHERE p2.warehouse_id = cs.warehouse_id AND p2.sku = cs.sku AND p2.active)
       AND (cs.sku ILIKE $2 OR EXISTS (
             SELECT 1 FROM invoice_items ii2
             WHERE ii2.warehouse_id = cs.warehouse_id AND ii2.sku = cs.sku AND ii2.name ILIKE $2))

     ORDER BY name LIMIT 20`,
    [warehouseId, `%${query}%`],
  );

  const results = [];
  for (const p of products.rows) {
    // Суммируем по ячейке: приёмка кладёт по строке на каждое поступление, и
    // одна и та же ячейка возвращалась дважды — человек слышал «94 штуки и ещё
    // 9 там же», хотя ячейка одна и в ней 103.
    const stock = await client.query(
      `SELECT SUM(cs.qty) AS qty, wr.row_num, cb.rack_start, cb.rack_end,
              cb.tier_start, cb.tier_end
       FROM cell_stock cs
       JOIN cell_blocks cb ON cb.id = cs.cell_block_id
       JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
       WHERE cs.warehouse_id = $1 AND cs.sku = $2
       GROUP BY cb.id, wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
       ORDER BY wr.row_num, cb.rack_start, cb.tier_start`,
      [warehouseId, p.sku],
    );
    results.push({
      sku: p.sku,
      name: p.name,
      category: p.category,
      weightG: p.weight_g,
      totalQty: stock.rows.reduce((sum, r) => sum + Number(r.qty), 0),
      locations: stock.rows.map((r) => ({
        row: r.row_num,
        rackFrom: r.rack_start, rackTo: r.rack_end,
        tierFrom: r.tier_start, tierTo: r.tier_end,
        qty: Number(r.qty),
      })),
    });
  }
  return results;
}

function formatBlockLabel(rowNum, block) {
  const rackPart = block.rack_start === block.rack_end ? block.rack_start : `${block.rack_start}–${block.rack_end}`;
  const tierPart = block.tier_start === block.tier_end ? block.tier_start : `${block.tier_start}–${block.tier_end}`;
  return `${rowNum}.${rackPart}.${tierPart}`;
}

// Подсказка ячейки при приёмке — чистое правило, без ИИ: сначала предложить
// ячейку, где этот SKU уже лежит (не размазывать один товар по складу),
// потом — просто свободную. Про габариты (влезет/не влезет) правила пока
// нет — у товаров почти всегда пустые размеры (см. argus_1c_sync_status),
// добавится само, когда данные появятся.
async function suggestCells(client, warehouseId, sku, limit = 3) {
  const sameSku = await client.query(
    `SELECT DISTINCT cb.id, wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
     FROM cell_stock cs
     JOIN cell_blocks cb ON cb.id = cs.cell_block_id
     JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
     WHERE cs.warehouse_id = $1 AND cs.sku = $2
     ORDER BY wr.row_num, cb.rack_start, cb.tier_start
     LIMIT $3`,
    [warehouseId, sku, limit],
  );

  const options = sameSku.rows.map((b) => ({
    blockId: b.id,
    label: formatBlockLabel(b.row_num, b),
    reason: 'same_sku',
  }));

  if (options.length < limit) {
    const empty = await client.query(
      `SELECT cb.id, wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
       FROM cell_blocks cb
       JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
       WHERE cb.warehouse_id = $1 AND cb.state = 'empty'
       ORDER BY wr.row_num, cb.rack_start, cb.tier_start
       LIMIT $2`,
      [warehouseId, limit - options.length],
    );
    for (const b of empty.rows) {
      options.push({ blockId: b.id, label: formatBlockLabel(b.row_num, b), reason: 'empty' });
    }
  }

  return options;
}

// ---------------------------------------------------------------------------
// Ниже — остальная работа Кладовщика, которую он давно делает руками работника,
// но о которой до сих пор нельзя было его спросить. Всё те же правила и тот же
// SQL: агент не считает и не решает, он только пересказывает посчитанное.
// ---------------------------------------------------------------------------

const DIRECTION_LABEL = { in: 'приёмка', out: 'отгрузка', return: 'возврат' };
const STATUS_LABEL = {
  open: 'не начата',
  in_progress: 'в работе',
  completed: 'завершена',
  ready: 'собран',
  shipped: 'отгружен',
};

// «Что сейчас в работе», «какие возвраты приехали», «что вчера приняли».
// Незакрытые документы идут первыми: незавершённая работа важнее истории.
async function listInvoices(client, warehouseId, { direction, status, limit = 20 } = {}) {
  const result = await client.query(
    `SELECT i.number, i.direction, i.status, i.created_at, c.name AS company_name,
            COUNT(ii.id)::int AS item_count
     FROM invoices i
     JOIN companies c ON c.id = i.company_id
     LEFT JOIN invoice_items ii ON ii.invoice_id = i.id
     WHERE i.warehouse_id = $1
       AND ($2::invoice_direction IS NULL OR i.direction = $2::invoice_direction)
       AND ($3::invoice_status IS NULL OR i.status = $3::invoice_status)
     GROUP BY i.id, i.number, i.direction, i.status, i.created_at, c.name
     ORDER BY (i.status IN ('completed', 'shipped')) ASC, i.created_at DESC
     LIMIT $4`,
    [warehouseId, direction || null, status || null, Math.min(limit, 50)],
  );
  return result.rows.map((r) => ({
    number: r.number,
    kind: DIRECTION_LABEL[r.direction] || r.direction,
    status: STATUS_LABEL[r.status] || r.status,
    company: r.company_name,
    itemCount: r.item_count,
    createdAt: r.created_at,
  }));
}

// «Что в накладной такой-то» — человек называет номер, не идентификатор.
// Для каждого направления показываем то, что для него имеет смысл: у приёмки
// принятое количество, у отгрузки собранное, у возврата — разбор по состоянию.
async function invoiceDetails(client, warehouseId, number) {
  const inv = await client.query(
    `SELECT i.id, i.number, i.direction, i.status, i.created_at, c.name AS company_name
     FROM invoices i JOIN companies c ON c.id = i.company_id
     WHERE i.warehouse_id = $1 AND i.number ILIKE $2
     ORDER BY i.created_at DESC LIMIT 1`,
    [warehouseId, number],
  );
  if (!inv.rows[0]) return null;
  const doc = inv.rows[0];

  const items = await client.query(
    `SELECT ii.id, ii.name, ii.sku, ii.declared_qty,
            (SELECT SUM(rr.accepted_qty) FROM receiving_records rr WHERE rr.invoice_item_id = ii.id) AS accepted,
            (SELECT SUM(sr.picked_qty) FROM shipping_records sr WHERE sr.invoice_item_id = ii.id) AS picked,
            (SELECT json_agg(json_build_object('bucket', ret.quality_bucket, 'qty', ret.qty))
               FROM return_records ret WHERE ret.invoice_item_id = ii.id) AS buckets
     FROM invoice_items ii
     WHERE ii.invoice_id = $1
     ORDER BY ii.name`,
    [doc.id],
  );

  const bucketLabel = { good: 'хороший', defective: 'брак', packaging_defect: 'брак упаковки' };
  return {
    number: doc.number,
    kind: DIRECTION_LABEL[doc.direction] || doc.direction,
    status: STATUS_LABEL[doc.status] || doc.status,
    company: doc.company_name,
    items: items.rows.map((it) => {
      const row = { name: it.name, sku: it.sku, declaredQty: Number(it.declared_qty) };
      if (doc.direction === 'in') row.acceptedQty = it.accepted === null ? null : Number(it.accepted);
      if (doc.direction === 'out') row.pickedQty = it.picked === null ? null : Number(it.picked);
      if (doc.direction === 'return') {
        row.sorted = (it.buckets || []).map((b) => ({
          state: bucketLabel[b.bucket] || b.bucket, qty: Number(b.qty),
        }));
      }
      return row;
    }),
  };
}

// «Насколько склад полон», «сколько свободных ячеек», «сколько всего брака».
// Один запрос на каждую цифру — считает база, не агент.
async function warehouseSummary(client, warehouseId) {
  const cells = await client.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE state = 'occupied')::int AS occupied,
            COALESCE(ROUND(AVG(fill_pct) FILTER (WHERE state = 'occupied')), 0)::int AS avg_fill
     FROM cell_blocks WHERE warehouse_id = $1`,
    [warehouseId],
  );
  const stock = await client.query(
    `SELECT COUNT(DISTINCT sku)::int AS skus, COALESCE(SUM(qty), 0) AS units
     FROM cell_stock WHERE warehouse_id = $1`,
    [warehouseId],
  );
  const returns = await client.query(
    `SELECT quality_bucket, COALESCE(SUM(qty), 0) AS qty
     FROM return_records WHERE warehouse_id = $1
     GROUP BY quality_bucket`,
    [warehouseId],
  );
  const openDocs = await client.query(
    `SELECT COUNT(*)::int AS n FROM invoices
     WHERE warehouse_id = $1 AND status NOT IN ('completed', 'shipped')`,
    [warehouseId],
  );

  const bucketLabel = { good: 'хороший', defective: 'брак', packaging_defect: 'брак упаковки' };
  const c = cells.rows[0];
  return {
    cellsTotal: c.total,
    cellsOccupied: c.occupied,
    cellsFree: c.total - c.occupied,
    averageFillOfOccupiedPct: c.avg_fill,
    distinctSkus: stock.rows[0].skus,
    totalUnits: Number(stock.rows[0].units),
    openDocuments: openDocs.rows[0].n,
    returned: returns.rows.map((r) => ({
      state: bucketLabel[r.quality_bucket] || r.quality_bucket, qty: Number(r.qty),
    })),
  };
}

// «Что ждёт моего решения» — расхождения, которые приёмка и отгрузка отправили
// владельцу. Журнал только на чтение: подтверждать и откатывать можно в
// кабинете, где видно всю карточку, а не одной фразой в чате.
async function listDiscrepancies(client, warehouseId, { limit = 15 } = {}) {
  const result = await client.query(
    `SELECT je.action_text, je.created_at, je.agent
     FROM journal_entries je
     WHERE je.warehouse_id = $1 AND je.status = 'pending'
     ORDER BY je.created_at DESC
     LIMIT $2`,
    [warehouseId, Math.min(limit, 50)],
  );
  return result.rows.map((r) => ({
    what: r.action_text, agent: r.agent, at: r.created_at,
  }));
}

// Единственное место, где имя инструмента превращается в вызов. Модель называет
// имя и аргументы, а что выполнится — решает эта таблица: имя не из списка
// просто не выполняется. Транзакцию открывает вызывающий (см. routes.js) —
// здесь только раздача, чтобы одно и то же поведение проверялось тестами и
// работало на проде.
function runTool(client, warehouseId, name, args = {}) {
  switch (name) {
    case 'find_products':
      return findProducts(client, warehouseId, String(args.query || ''));
    case 'suggest_cell':
      return suggestCells(client, warehouseId, String(args.sku || ''));
    case 'list_invoices':
      return listInvoices(client, warehouseId, { direction: args.direction, status: args.status });
    case 'invoice_details':
      return invoiceDetails(client, warehouseId, String(args.number || ''));
    case 'warehouse_summary':
      return warehouseSummary(client, warehouseId);
    case 'list_discrepancies':
      return listDiscrepancies(client, warehouseId, {});
    default:
      return Promise.resolve({ error: 'неизвестный инструмент' });
  }
}

module.exports = {
  findProducts, suggestCells, listInvoices, invoiceDetails, warehouseSummary,
  listDiscrepancies, runTool,
};

