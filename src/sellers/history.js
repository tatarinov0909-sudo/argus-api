const { HttpError } = require('../middleware/errorHandler');

function readPage(query, companyId, sku) {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if ((query.limit !== undefined && !['string','number'].includes(typeof query.limit)) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, 'Размер страницы истории должен быть от 1 до 100');
  }
  let cursor = null;
  if (query.cursor !== undefined) {
    try {
      if (typeof query.cursor !== 'string' || query.cursor.length > 1600 || !/^[\w-]+$/.test(query.cursor)) throw Error();
      cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (cursor.v !== 1 || cursor.company !== companyId || cursor.sku !== sku ||
          typeof cursor.key !== 'string' || !/^(received|picked|shipped|returned|stock):[0-9a-f-]{36}$/.test(cursor.key) ||
          (cursor.at !== null && (typeof cursor.at !== 'string' || cursor.at.length > 64 || !Number.isFinite(Date.parse(cursor.at))))) throw Error();
    } catch {
      throw new HttpError(400, 'Страница истории устарела. Откройте товар заново.');
    }
  }
  return { limit, cursor };
}

// Event identities include their source: the same shipping record contributes
// a pick and, only after confirmed departure, a separate shipment.
const EVENTS_SQL = `
  SELECT rr.id, 'received:' || rr.id AS event_key, rr.finished_at AS at, 'received' AS kind,
         rr.accepted_qty AS qty, i.number AS document, NULL::text AS note, NULL::text AS quality,
         i.status::text AS status, NULL::uuid AS from_cell_id, rr.cell_block_id AS to_cell_id,
         NULL::text AS supply_number
    FROM receiving_records rr JOIN invoice_items ii ON ii.id=rr.invoice_item_id AND ii.company_id=$1
    JOIN invoices i ON i.id=ii.invoice_id AND i.company_id=$1
   WHERE rr.company_id=$1 AND ii.sku=$2 AND rr.accepted_qty IS NOT NULL
  UNION ALL
  SELECT sr.id, 'picked:' || sr.id, sr.finished_at, 'picked', sr.picked_qty, i.number, NULL, NULL,
         i.status::text, sr.cell_block_id, NULL, NULL
    FROM shipping_records sr JOIN invoice_items ii ON ii.id=sr.invoice_item_id AND ii.company_id=$1
    JOIN invoices i ON i.id=ii.invoice_id AND i.company_id=$1
   WHERE sr.company_id=$1 AND ii.sku=$2 AND sr.picked_qty IS NOT NULL
  UNION ALL
  SELECT sr.id, 'shipped:' || sr.id, COALESCE(i.shipped_at,s.shipped_at), 'shipped', sr.picked_qty,
         i.number, NULL, NULL, i.status::text, sr.cell_block_id, NULL, s.number
    FROM shipping_records sr JOIN invoice_items ii ON ii.id=sr.invoice_item_id AND ii.company_id=$1
    JOIN invoices i ON i.id=ii.invoice_id AND i.company_id=$1
    LEFT JOIN supplies s ON s.id=i.supply_id AND s.company_id=$1 AND s.warehouse_id=i.warehouse_id AND s.status='shipped'
   WHERE sr.company_id=$1 AND ii.sku=$2 AND sr.picked_qty>0 AND i.status='shipped'
     AND COALESCE(i.shipped_at,s.shipped_at) IS NOT NULL
  UNION ALL
  SELECT rr.id, 'returned:' || rr.id, rr.finished_at, 'returned', rr.qty, i.number, rr.defect_note,
         rr.quality_bucket::text, i.status::text, NULL, rr.cell_block_id, NULL
    FROM return_records rr JOIN invoice_items ii ON ii.id=rr.invoice_item_id AND ii.company_id=$1
    JOIN invoices i ON i.id=ii.invoice_id AND i.company_id=$1
   WHERE rr.company_id=$1 AND ii.sku=$2
  UNION ALL
  SELECT op.id, 'stock:' || op.id, op.created_at, op.kind, op.qty, NULL, NULL, NULL, NULL,
         op.from_cell_block_id, op.to_cell_block_id, NULL
    FROM stock_operations op WHERE op.company_id=$1 AND op.sku=$2`;

function cellFields(alias, rowAlias) {
  return `CASE WHEN ${alias}.id IS NULL THEN NULL ELSE json_build_object(
    'id',${alias}.id,'label',${alias}.label,'rowNum',${rowAlias}.row_num,
    'rackStart',${alias}.rack_start,'rackEnd',${alias}.rack_end,
    'tierStart',${alias}.tier_start,'tierEnd',${alias}.tier_end) END`;
}

async function loadHistory(client, companyId, sku, page) {
  const { cursor, limit } = page;
  const result = await client.query(`WITH events AS (${EVENTS_SQL}), page AS (
    SELECT * FROM events WHERE ($3::boolean IS FALSE OR
      CASE WHEN $4::timestamptz IS NULL THEN at IS NULL AND event_key<$5
           ELSE at<$4::timestamptz OR at IS NULL OR (at=$4::timestamptz AND event_key<$5) END)
    ORDER BY at DESC NULLS LAST,event_key DESC LIMIT $6
  ) SELECT p.*,p.at::text AS cursor_at,
           ${cellFields('fc','fr')} AS from_cell, ${cellFields('tc','tr')} AS to_cell
      FROM page p
      LEFT JOIN cell_blocks fc ON fc.id=p.from_cell_id
      LEFT JOIN warehouse_rows fr ON fr.id=fc.warehouse_row_id
      LEFT JOIN cell_blocks tc ON tc.id=p.to_cell_id
      LEFT JOIN warehouse_rows tr ON tr.id=tc.warehouse_row_id
     ORDER BY p.at DESC NULLS LAST,p.event_key DESC`,
  [companyId, sku, !!cursor, cursor?.at ?? null, cursor?.key ?? null, limit+1]);
  const rows = result.rows.slice(0, limit);
  const hasMore = result.rows.length > limit;
  const last = rows[rows.length-1];
  const nextCursor = hasMore ? Buffer.from(JSON.stringify({
    v:1, company:companyId, sku, at:last.cursor_at, key:last.event_key,
  })).toString('base64url') : null;
  return { events:rows.map(r => ({
    id:r.id, eventKey:r.event_key, at:r.at, kind:r.kind, qty:Number(r.qty), document:r.document,
    note:r.note, quality:r.quality, status:r.status, fromCell:r.from_cell, toCell:r.to_cell,
    supplyNumber:r.supply_number,
  })), hasMore, nextCursor };
}

module.exports = { readPage, loadHistory };
