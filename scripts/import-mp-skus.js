// Загрузка сопоставления «артикул площадки ↔ наш код» из матрицы продавца.
//
// Формат файла:
//   { "items": [ { "sku": "PB000021199", "marketplace": "wb",
//                  "mpSku": "272959925",       // номер карточки (nmId)
//                  "mpArticle": "1201010212",  // артикул продавца
//                  "mpBarcode": "2041518833245" } ] }
//
// Запуск:
//   node scripts/import-mp-skus.js --file mpskus.json --warehouse <uuid> --company <uuid>
// Без --apply только показывает, что изменится.

require('dotenv').config();
const fs = require('fs');
const { withTenantContext, pool } = require('../src/db/pool');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

const file = arg('file');
const warehouseId = arg('warehouse');
const companyId = arg('company');
const apply = process.argv.includes('--apply');

if (!file || !warehouseId || !companyId) {
  console.error('Использование: node scripts/import-mp-skus.js --file mpskus.json '
    + '--warehouse <uuid> --company <uuid> [--apply]');
  process.exit(1);
}

const all = JSON.parse(fs.readFileSync(file, 'utf8')).items || [];

// Номер карточки у Wildberries всегда числовой. В матрице на его месте у
// компонентов наборов стоит подпись «--- нет МП ---»: такой товар на площадке
// не продаётся отдельно. Принять её за номер значит схлопнуть все такие
// товары в одну строку — на первой загрузке ровно это и случилось с 46 из них.
const cardNumber = (v) => (v && /^[0-9]+$/.test(String(v).trim()) ? String(v).trim() : null);

const items = all
  .filter((i) => i.sku && i.marketplace)
  .map((i) => ({ ...i, mpSku: cardNumber(i.mpSku) }))
  .filter((i) => i.mpSku || i.mpArticle || i.mpBarcode);

const noCard = items.filter((i) => !i.mpSku).length;
if (noCard) {
  console.log(`Без карточки на площадке (компоненты наборов): ${noCard} — `
    + 'сохраняем по артикулу и штрихкоду');
}

if (!items.length) {
  console.error('В файле нет ни одной пригодной строки');
  process.exit(1);
}

(async () => {
  const stats = { added: 0, updated: 0, unchanged: 0 };

  await withTenantContext({ warehouseId }, async (client) => {
    // Тот же контроль, что и при загрузке наборов: код, которого склад не
    // знает ни в справочнике, ни в ячейках, ни в накладных, почти наверняка
    // опечатка — и проявится она как «заказ пришёл, а собрать нечего».
    const skus = [...new Set(items.map((i) => i.sku))];
    const known = await client.query(
      `SELECT sku FROM products WHERE warehouse_id = $1 AND sku = ANY($2::text[])
       UNION SELECT sku FROM cell_stock WHERE warehouse_id = $1 AND sku = ANY($2::text[])
       UNION SELECT sku FROM invoice_items WHERE warehouse_id = $1 AND sku = ANY($2::text[])`,
      [warehouseId, skus],
    );
    const knownSet = new Set(known.rows.map((r) => r.sku));
    const unknown = skus.filter((s) => !knownSet.has(s));
    if (unknown.length) {
      console.log(`\nСклад не знает таких кодов (${unknown.length}):`);
      for (const s of unknown.slice(0, 20)) console.log(`  ${s}`);
      if (unknown.length > 20) console.log(`  …и ещё ${unknown.length - 20}`);
    }

    for (const it of items) {
      const existing = await client.query(
        `SELECT sku, mp_article, mp_barcode FROM product_marketplace_skus
         WHERE warehouse_id = $1 AND marketplace = $2
           AND COALESCE(mp_sku, '') = COALESCE($3, '')
           AND COALESCE(mp_article, '') = COALESCE($4, '')`,
        [warehouseId, it.marketplace, it.mpSku, it.mpArticle || null],
      );
      const before = existing.rows[0];
      const same = before
        && before.sku === it.sku
        && (before.mp_article || null) === (it.mpArticle || null)
        && (before.mp_barcode || null) === (it.mpBarcode || null);
      if (same) { stats.unchanged += 1; continue; }
      if (before) stats.updated += 1; else stats.added += 1;
      if (!apply) continue;

      await client.query(
        `INSERT INTO product_marketplace_skus
           (warehouse_id, company_id, sku, marketplace, mp_sku, mp_article, mp_barcode)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (warehouse_id, marketplace, COALESCE(mp_sku, ''), COALESCE(mp_article, ''))
         DO UPDATE SET sku = EXCLUDED.sku,
                       company_id = EXCLUDED.company_id,
                       mp_barcode = EXCLUDED.mp_barcode,
                       updated_at = now()`,
        [warehouseId, companyId, it.sku, it.marketplace,
          it.mpSku, it.mpArticle || null, it.mpBarcode || null],
      );
    }
  });

  console.log(`\nСтрок в файле: ${items.length}`);
  console.log(`  новых:         ${stats.added}`);
  console.log(`  обновлено:     ${stats.updated}`);
  console.log(`  без изменений: ${stats.unchanged}`);
  if (!apply) console.log('\nЭто предпросмотр. Чтобы записать — добавьте --apply');
  await pool.end();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
