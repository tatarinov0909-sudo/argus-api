// Выбор из каталога и один атомарный пакет переносов. Остатки считает сервер.
const crypto = require('node:crypto');
const { HttpError } = require('../middleware/errorHandler');
const vw = require('./service');

const MAX_ITEMS = 200;
const MAX_QTY = 2147483647;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function id(value, label, nullable = false) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, `${label}: некорректный идентификатор`);
  return value.toLowerCase();
}
function text(value, label, max = 200) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, `${label}: нужно текстовое значение до ${max} знаков`);
  return value.trim();
}
function quantity(value) {
  const n = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_QTY ? n : null;
}
function input(body, { canonical = false } = {}) {
  const companyId = id(body?.companyId, 'Клиент');
  if (body?.toVw === undefined) throw new HttpError(400, 'Выберите целевой виртуальный склад');
  const toVw = id(body.toVw, 'Целевой склад', true);
  if (!Array.isArray(body.items) || !body.items.length) throw new HttpError(400, 'Выберите товары для переноса');
  if (body.items.length > MAX_ITEMS) throw new HttpError(400, `За один перенос — не больше ${MAX_ITEMS} товаров. Уменьшите список.`, { code: 'too_many_items', maxItems: MAX_ITEMS });
  const items = body.items.map((r, index) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new HttpError(400, `Строка ${index + 1}: укажите товар и количество`);
    const sku = text(r.sku, 'Артикул'), barcode = text(r.barcode, 'Штрихкод');
    const qty = quantity(r.qty), fromVw = id(r.fromVw, 'Исходный склад', true);
    if (canonical && (!sku || qty === null || barcode)) throw new HttpError(400, `Строка ${index + 1}: нужен точный артикул и положительное целое количество до ${MAX_QTY}`);
    return { row: index + 1, sku, barcode, qty, fromVw };
  });
  if (canonical && new Set(items.map(r => r.sku)).size !== items.length) throw new HttpError(400, 'Один товар указан несколько раз. Оставьте одну строку на артикул.', { code: 'duplicate_sku' });
  return { companyId, toVw, items, note: text(body.note, 'Комментарий', 300) };
}
async function context(client, warehouseId, companyId, toVw, sources, lock = false) {
  const company = (await client.query(`SELECT id, ff_rights FROM companies
    WHERE id=$1 AND warehouse_id=$2 AND archived_at IS NULL${lock ? ' FOR SHARE' : ''}`, [companyId, warehouseId])).rows[0];
  if (!company) throw new HttpError(404, 'Клиент не найден');
  const ids = [...new Set([toVw, ...sources].filter(Boolean))];
  const warehouses = (await client.query(`SELECT id, name, keep_separate FROM virtual_warehouses
    WHERE warehouse_id=$1 AND company_id=$2 AND id=ANY($3::uuid[]) AND archived_at IS NULL
    ORDER BY id${lock ? ' FOR SHARE' : ''}`, [warehouseId, companyId, ids])).rows;
  if (warehouses.length !== ids.length) throw new HttpError(404, 'Виртуальный склад не найден у выбранного клиента');
  // Адресное хранение выключено (06.10.2026): переносы без перекладки.
  const addressOff = await require('../cells/addressing').isOff(client, warehouseId);
  return { company, warehouses: new Map(warehouses.map(w => [w.id, w])), addressOff };
}

// Все выбранные SKU/источники одним SQL, то же правило, что service.transferable.
async function availability(client, warehouseId, companyId, items, toVw = undefined) {
  if (!items.length) return new Map();
  const records = items.map(r => ({ sku: r.sku, from_vw: r.fromVw }));
  const rows = (await client.query(`WITH requested AS (
      SELECT * FROM jsonb_to_recordset($3::jsonb) AS r(sku text, from_vw uuid)
    ), stock AS (
      SELECT r.sku,r.from_vw,COALESCE(SUM(cs.qty),0) AS qty FROM requested r
      LEFT JOIN cell_stock cs ON cs.warehouse_id=$1 AND cs.company_id=$2 AND cs.sku=r.sku
        AND cs.virtual_warehouse_id IS NOT DISTINCT FROM r.from_vw AND cs.quality='good' AND cs.qty>0
      GROUP BY r.sku,r.from_vw
    ), picking AS (
      SELECT r.sku,r.from_vw,SUM(GREATEST(ii.declared_qty-COALESCE(p.picked,0),0)) AS qty
      FROM requested r JOIN invoice_items ii ON ii.company_id=$2 AND ii.sku=r.sku
        AND ii.virtual_warehouse_id IS NOT DISTINCT FROM r.from_vw
      JOIN invoices i ON i.id=ii.invoice_id AND i.warehouse_id=$1
      LEFT JOIN LATERAL (SELECT SUM(sr.picked_qty) AS picked FROM shipping_records sr WHERE sr.invoice_item_id=ii.id) p ON true
      WHERE i.direction='out' AND i.status IN ('open','in_progress') AND i.mp_closed_at IS NULL
        AND (i.supply_id IS NOT NULL OR i.source='1c' OR (i.source='direct' AND ii.virtual_warehouse_id IS NOT NULL))
        AND NOT EXISTS (SELECT 1 FROM shipping_records f WHERE f.invoice_item_id=ii.id AND f.is_final)
      GROUP BY r.sku,r.from_vw
    ), promised AS (
      SELECT r.sku,r.from_vw,SUM(t.qty-t.moved) AS qty FROM requested r JOIN vw_move_tasks t
        ON t.warehouse_id=$1 AND t.company_id=$2 AND t.sku=r.sku
        AND t.from_vw IS NOT DISTINCT FROM r.from_vw AND t.status='open' AND t.kind='transfer' AND t.quality='good'
      GROUP BY r.sku,r.from_vw
    ), destination AS (
      SELECT cs.sku,SUM(cs.qty) AS qty FROM cell_stock cs
      WHERE cs.warehouse_id=$1 AND cs.company_id=$2 AND cs.quality='good' AND cs.qty>0
        AND cs.virtual_warehouse_id IS NOT DISTINCT FROM $4::uuid
        AND cs.sku IN (SELECT sku FROM requested) GROUP BY cs.sku
    ) SELECT s.sku,s.from_vw,s.qty AS in_cells,COALESCE(p.qty,0) AS to_pick,COALESCE(m.qty,0) AS promised,
        COALESCE(d.qty,0) AS in_destination
      FROM stock s LEFT JOIN picking p ON p.sku=s.sku AND p.from_vw IS NOT DISTINCT FROM s.from_vw
      LEFT JOIN promised m ON m.sku=s.sku AND m.from_vw IS NOT DISTINCT FROM s.from_vw
      LEFT JOIN destination d ON d.sku=s.sku`,
  [warehouseId, companyId, JSON.stringify(records), toVw ?? null])).rows;
  return new Map(rows.map(r => {
    const inCells = Number(r.in_cells), toPick = Number(r.to_pick), promised = Number(r.promised);
    return [key(r.sku, r.from_vw), { inCells, toPick, promised, free: Math.max(0, inCells-toPick-promised),
      ...(toVw !== undefined ? { inDestination:Number(r.in_destination) } : {}) }];
  }));
}
const key = (sku, source) => JSON.stringify([sku, source || null]);
function predicted(ctx, source, target) {
  if (!vw.rightsOf(ctx.company).decide) return 'waiting_seller';
  if (ctx.addressOff) return 'done';
  return ctx.warehouses.get(source)?.keep_separate || ctx.warehouses.get(target)?.keep_separate ? 'to_move' : 'done';
}
async function candidates(client, warehouseId, query) {
  const companyId = id(query.companyId, 'Клиент'), toVw = id(query.toVw, 'Целевой склад', true), fromVw = id(query.fromVw, 'Исходный склад', true);
  if (query.toVw === undefined) throw new HttpError(400, 'Выберите целевой виртуальный склад');
  if (fromVw === toVw) throw new HttpError(400, 'Выберите другой исходный склад');
  await context(client, warehouseId, companyId, toVw, [fromVw]);
  const q = text(query.q, 'Поиск', 120), limit = query.limit === undefined ? 100 : quantity(query.limit);
  if (!limit || limit > MAX_ITEMS) throw new HttpError(400, `Размер страницы — от 1 до ${MAX_ITEMS}`);
  const scope = hash([warehouseId, companyId, fromVw, toVw, q]);
  let after = null;
  if (query.cursor) {
    try {
      if (typeof query.cursor !== 'string' || query.cursor.length > 2048) throw new Error();
      const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (cursor.scope !== scope || typeof cursor.sku !== 'string' || cursor.sku.length > 200) throw new Error();
      after = cursor.sku;
    } catch (_) { throw new HttpError(400, 'Некорректная страница товаров — обновите список'); }
  }
  const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
  const rows = (await client.query(`SELECT sku,name,barcode FROM products
    WHERE warehouse_id=$1 AND company_id=$2 AND active
      AND ($3::text IS NULL OR sku COLLATE "C">$3 COLLATE "C")
      AND ($4='' OR sku ILIKE $5 OR name ILIKE $5 OR barcode ILIKE $5)
    ORDER BY sku COLLATE "C" LIMIT $6`, [warehouseId, companyId, after, q, like, limit+1])).rows;
  const page = rows.slice(0, limit), free = await availability(client, warehouseId, companyId, page.map(p => ({ sku:p.sku, fromVw })), toVw);
  return { companyId, toVw, fromVw, items:page.map(p => ({ ...p, ...free.get(key(p.sku, fromVw)) })),
    nextCursor:rows.length > limit ? Buffer.from(JSON.stringify({ scope, sku:page[page.length-1].sku })).toString('base64url') : null };
}
async function preview(client, warehouseId, body) {
  const b = input(body), ctx = await context(client, warehouseId, b.companyId, b.toVw, b.items.map(r => r.fromVw));
  // Те же ключи, что у прихода из Excel (проверка 05.10): артикул без учёта
  // регистра, артикул продавца и штрихкод WB. Угадывания нет — ключ должен
  // указывать ровно на один товар.
  const cat = await require('../sellers/inbound').catalogIndex(client, b.companyId);
  const products = new Map(cat.products.map(p => [p.sku,p]));
  const exact = new Map(cat.products.map(p => [p.sku.toUpperCase(),p.sku]));
  const bySku = { get: (code) => {
    const up = String(code).toUpperCase(), own = exact.get(up), set = cat.byArticle.get(up);
    return products.get(own || (set && set.size === 1 ? [...set][0] : null)) || null;
  } };
  const byBarcode = { get: (code) => [...(cat.byBarcode.get(code) || [])].map(s => products.get(s)) };
  const errors = [], seen = new Set(), resolved = [];
  const add = (r, code, message, extra = {}) => errors.push({ row:r.row, code, message, ...extra });
  for (const r of b.items) {
    let p = r.sku ? bySku.get(r.sku) : null;
    // Артикул WB, общий у размеров: штрихкод строки выбирает размер, иначе —
    // «у нескольких», а не «не найден» (проверка 07.10, замечание 5).
    const several = r.sku && !p ? cat.byArticle.get(String(r.sku).toUpperCase()) : null;
    if (several && several.size > 1) {
      const both = (r.barcode ? byBarcode.get(r.barcode) : []).filter(x => several.has(x.sku));
      if (both.length === 1) p = both[0];
      else add(r,'ambiguous_article','Этот артикул у нескольких товаров (например, размеров) — укажите штрихкод');
    } else if (r.sku && !p) add(r,'unknown_sku','Артикул не найден в активном каталоге этого клиента');
    if (!r.sku) {
      const matches = byBarcode.get(r.barcode) || [];
      if (!r.barcode) add(r,'missing_identifier','Укажите артикул Аргуса или штрихкод');
      else if (!matches.length) add(r,'unknown_barcode','Штрихкод не найден в каталоге этого клиента');
      else if (matches.length > 1) add(r,'ambiguous_barcode','Этот штрихкод принадлежит нескольким товарам — укажите артикул Аргуса');
      else p = matches[0];
    } else if (p && r.barcode && !byBarcode.get(r.barcode).some(x => x.sku === p.sku)) add(r,'identifier_mismatch','Артикул и штрихкод указывают на разные товары');
    if (r.qty === null) add(r,'invalid_qty',`Количество — положительное целое число до ${MAX_QTY}`);
    if (r.fromVw === b.toVw) add(r,'same_warehouse','Исходный и целевой склад совпадают');
    if (p) {
      if (seen.has(p.sku)) add(r,'duplicate_sku','Товар уже указан в другой строке', { sku:p.sku });
      seen.add(p.sku);
    }
    resolved.push({ ...r, ...(p ? {sku:p.sku,name:p.name,barcode:p.barcode} : {}), toVw:b.toVw });
  }
  const unique = [...new Map(resolved.filter(r => r.name !== undefined).map(r => [key(r.sku,r.fromVw),r])).values()];
  const free = await availability(client, warehouseId, b.companyId, unique, b.toVw);
  const items = resolved.map(r => {
    const amount = free.get(key(r.sku,r.fromVw));
    if (amount && r.qty !== null && r.qty > amount.free) add(r,'insufficient_stock',`Можно перенести только ${amount.free} шт.`,{sku:r.sku,free:amount.free});
    return {...r,...amount,expectedStatus:predicted(ctx,r.fromVw,b.toVw)};
  });
  return { companyId:b.companyId,toVw:b.toVw,canCommit:errors.length === 0,items,errors };
}
async function commit(client, warehouseId, body, actor) {
  const b = input(body, {canonical:true}), requestId = id(body.requestId,'Номер операции');
  const ordered = [...b.items].sort((a,b) => a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);
  const payloadHash = hash({companyId:b.companyId,toVw:b.toVw,note:b.note,items:ordered.map(({sku,qty,fromVw})=>({sku,qty,fromVw}))});
  const inserted = (await client.query(`INSERT INTO vw_transfer_batches (warehouse_id,company_id,request_id,payload_hash)
    VALUES ($1,$2,$3,$4) ON CONFLICT (warehouse_id,company_id,request_id) DO NOTHING RETURNING id`,
  [warehouseId,b.companyId,requestId,payloadHash])).rows[0];
  if (!inserted) {
    const prior = (await client.query(`SELECT payload_hash,result FROM vw_transfer_batches
      WHERE warehouse_id=$1 AND company_id=$2 AND request_id=$3 FOR UPDATE`,[warehouseId,b.companyId,requestId])).rows[0];
    if (!prior || prior.payload_hash !== payloadHash) throw new HttpError(409,'Этот номер операции уже использован для другого списка товаров',{code:'request_changed'});
    if (!prior.result) throw new HttpError(409,'Операция ещё выполняется — повторите запрос');
    return {...prior.result,replayed:true};
  }
  await context(client,warehouseId,b.companyId,b.toVw,b.items.map(r=>r.fromVw),true);
  const catalog = (await client.query(`SELECT sku FROM products WHERE warehouse_id=$1 AND company_id=$2 AND active
    AND sku=ANY($3::text[]) ORDER BY sku COLLATE "C" FOR SHARE`,[warehouseId,b.companyId,ordered.map(r=>r.sku)])).rows;
  if (catalog.length !== ordered.length) throw new HttpError(400,'В списке есть товар вне активного каталога выбранного клиента',{code:'unknown_sku'});
  // Один порядок advisory locks даже при обратном порядке строк и коллизиях hashtext.
  const locks = (await client.query(`SELECT DISTINCT hashtext('vw-transfer:' || $1::text || ':' || sku) AS lock_key
    FROM unnest($2::text[]) AS sku ORDER BY lock_key`,[b.companyId,ordered.map(r=>r.sku)])).rows;
  for (const lock of locks) await client.query('SELECT pg_advisory_xact_lock($1::bigint)',[lock.lock_key]);
  const free = await availability(client,warehouseId,b.companyId,ordered);
  const errors = ordered.filter(r=>r.fromVw===b.toVw || r.qty>free.get(key(r.sku,r.fromVw)).free)
    .map(r=>({row:r.row,sku:r.sku,code:r.fromVw===b.toVw?'same_warehouse':'insufficient_stock',free:free.get(key(r.sku,r.fromVw)).free}));
  if(errors.length) throw new HttpError(409,'Товары не перенесены: проверьте исходный склад и доступное количество',{errors});
  const items=[];
  for(const r of ordered) items.push(await vw.transfer(client,{warehouseId,companyId:b.companyId,toVw:b.toVw,...r,note:b.note,actor}));
  const result={requestId,replayed:false,items};
  await client.query('UPDATE vw_transfer_batches SET result=$2::jsonb WHERE id=$1',[inserted.id,JSON.stringify(result)]);
  return result;
}
module.exports={candidates,preview,commit,availability,MAX_ITEMS};
