const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { pool, withTenantContext } = require('../src/db/pool');

function arg(name, required = true) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (required && (!value || value.startsWith('--'))) throw new Error(`Не указан --${name}`);
  return value;
}

function normalize(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Файл должен содержать непустой массив');
  const seen = new Set();
  return raw.map((item, index) => {
    const sku = String(item.sku || '').trim();
    const quantity = Number(item.qty ?? item.quantity);
    if (!sku) throw new Error(`Строка ${index + 1}: не указан sku`);
    if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error(`Строка ${index + 1}: некорректное количество`);
    if (seen.has(sku)) throw new Error(`Дублируется артикул ${sku}`);
    seen.add(sku);
    return { sku, quantity };
  }).sort((a, b) => a.sku.localeCompare(b.sku));
}

(async () => {
  const companyId = arg('company-id');
  const warehouseId = arg('warehouse-id');
  const filename = arg('file');
  const sourceLabel = arg('source-label');
  const observedAt = arg('observed-at', false);
  const expectedCount = Number(arg('expected-count'));
  const expectedTotal = Number(arg('expected-total'));
  const apply = process.argv.includes('--apply');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL не задан');

  const items = normalize(JSON.parse(fs.readFileSync(filename, 'utf8')));
  const total = items.reduce((sum, item) => sum + item.quantity, 0);
  if (items.length !== expectedCount || total !== expectedTotal) {
    throw new Error(`Контрольная сумма не совпала: ${items.length} позиций, ${total} шт.`);
  }
  const contentHash = createHash('sha256').update(JSON.stringify(items)).digest('hex');

  const summary = await withTenantContext({ warehouseId }, async (client) => {
    const company = (await client.query(
      `SELECT id,warehouse_id,name FROM companies
        WHERE id=$1 AND warehouse_id=$2 AND archived_at IS NULL`,
      [companyId, warehouseId],
    )).rows[0];
    if (!company) throw new Error('Активная компания не найдена на указанном складе');
    const products = (await client.query(
      `SELECT sku FROM products WHERE company_id=$1 AND active=true AND sku=ANY($2::text[])`,
      [company.id, items.map(item => item.sku)],
    )).rows;
    const found = new Set(products.map(row => row.sku));
    const missing = items.filter(item => !found.has(item.sku)).map(item => item.sku);
    if (missing.length) throw new Error(`Не найдены активные товары: ${missing.join(', ')}`);
    if (!apply) return { company: company.name, count: items.length, total, contentHash, applied: false };

    const current = (await client.query(
      `SELECT id,accepted_at,item_count,total_qty,content_hash
         FROM seller_inventory_snapshots
        WHERE company_id=$1 AND status='accepted'
        ORDER BY accepted_at DESC,id DESC LIMIT 1`,
      [company.id],
    )).rows[0];
    if (current && current.content_hash === contentHash
      && Number(current.item_count) === expectedCount
      && Number(current.total_qty) === expectedTotal) {
      return { company: company.name, snapshotId: current.id, count: expectedCount,
        total: expectedTotal, contentHash, acceptedAt: current.accepted_at,
        applied: false, reused: true };
    }

    await client.query(
      `UPDATE seller_inventory_snapshots
          SET status='superseded'
        WHERE company_id=$1 AND status='accepted'`,
      [company.id],
    );
    const snapshot = (await client.query(
      `INSERT INTO seller_inventory_snapshots
         (warehouse_id,company_id,source_kind,source_label,observed_at,accepted_at,status,item_count,total_qty,content_hash,note)
       VALUES($1,$2,'file',$3,$4,now(),'accepted',$5,$6,$7,$8)
       RETURNING id,accepted_at`,
      [company.warehouse_id, company.id, sourceLabel, observedAt || null,
        items.length, total, contentHash, 'Принятый контрольный снимок продавца'],
    )).rows[0];
    for (const item of items) {
      await client.query(
        `INSERT INTO seller_inventory_snapshot_items
           (snapshot_id,warehouse_id,company_id,sku,quantity)
         VALUES($1,$2,$3,$4,$5)`,
        [snapshot.id, company.warehouse_id, company.id, item.sku, item.quantity],
      );
    }
    const check = (await client.query(
      `SELECT count(*)::int AS count,COALESCE(sum(quantity),0)::numeric AS total
         FROM seller_inventory_snapshot_items WHERE snapshot_id=$1`,
      [snapshot.id],
    )).rows[0];
    if (check.count !== expectedCount || Number(check.total) !== expectedTotal) {
      throw new Error('Проверка записанного снимка не прошла');
    }
    return { company: company.name, snapshotId: snapshot.id, count: check.count,
      total: Number(check.total), contentHash, acceptedAt: snapshot.accepted_at, applied: true };
  });
  console.log(JSON.stringify(summary));
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
