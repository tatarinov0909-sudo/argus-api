// Загрузка состава наборов из матрицы продавца.
//
// Матрица приходит от продавца таблицей (Excel) и переводится в JSON заранее —
// разбирать xlsx в приложении незачем, это разовая конвертация, а зависимость
// осталась бы навсегда. Формат:
//
//   { "kits": [ { "kitSku": "PB000021141", "kitName": "…",
//                 "components": [ { "sku": "PB000021133", "qty": 1 }, … ] } ] }
//
// Артикулы — НАШИ (КОД ФФ), не коды площадки: перевод делает конвертация,
// а склад живёт в кодах 1С.
//
// Запуск:
//   node scripts/import-kits.js --file kits.json --warehouse <uuid> --company <uuid>
// Без --apply ничего не пишет, только показывает, что изменится.

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
  console.error('Использование: node scripts/import-kits.js --file kits.json '
    + '--warehouse <uuid> --company <uuid> [--apply]');
  process.exit(1);
}

const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
const kits = payload.kits || [];
if (!kits.length) {
  console.error('В файле нет ни одного набора');
  process.exit(1);
}

(async () => {
  const stats = { kits: 0, added: 0, updated: 0, removed: 0, unchanged: 0 };

  await withTenantContext({ warehouseId }, async (client) => {
    // Артикул, которого на складе нет ни в справочнике, ни в ячейках, ни в
    // одной накладной, — почти всегда опечатка в матрице. В живом файле уже
    // нашлось `Pb000021836` вместо `PB…`: сравнение регистрозависимое, и такой
    // компонент навсегда останется «в нуле», а набор — несобираемым. Молча это
    // пропустить нельзя: ошибка проявится через неделю как «почему ноль».
    const mentioned = [...new Set(kits.flatMap((k) => [
      k.kitSku, ...(k.components || []).map((c) => c.sku),
    ]))].filter(Boolean);
    const known = await client.query(
      `SELECT sku FROM products WHERE warehouse_id = $1 AND sku = ANY($2::text[])
       UNION SELECT sku FROM cell_stock WHERE warehouse_id = $1 AND sku = ANY($2::text[])
       UNION SELECT sku FROM invoice_items WHERE warehouse_id = $1 AND sku = ANY($2::text[])`,
      [warehouseId, mentioned],
    );
    const knownSet = new Set(known.rows.map((r) => r.sku));
    const unknown = mentioned.filter((s) => !knownSet.has(s));
    if (unknown.length) {
      const byLower = new Map([...knownSet].map((k) => [k.toLowerCase(), k]));
      console.log(`
Склад не знает таких артикулов (${unknown.length}) — проверьте матрицу:`);
      for (const s of unknown.slice(0, 20)) {
        const near = byLower.get(s.toLowerCase());
        console.log(`  ${s}${near ? `  ← похоже на ${near}, отличается регистром` : ''}`);
      }
      if (unknown.length > 20) console.log(`  …и ещё ${unknown.length - 20}`);
    }

    for (const kit of kits) {
      if (!kit.kitSku || !Array.isArray(kit.components) || !kit.components.length) {
        console.log(`  пропуск ${kit.kitSku || '(без кода)'}: пустой состав`);
        continue;
      }
      stats.kits += 1;

      const existing = await client.query(
        `SELECT component_sku, qty FROM product_kits
         WHERE warehouse_id = $1 AND company_id = $2 AND kit_sku = $3`,
        [warehouseId, companyId, kit.kitSku],
      );
      const was = new Map(existing.rows.map((r) => [r.component_sku, Number(r.qty)]));
      const now = new Map(kit.components.map((c) => [c.sku, Number(c.qty)]));

      for (const [sku, qty] of now) {
        const before = was.get(sku);
        if (before === qty) { stats.unchanged += 1; continue; }
        if (before === undefined) stats.added += 1; else stats.updated += 1;
        if (!apply) continue;
        await client.query(
          `INSERT INTO product_kits (warehouse_id, company_id, kit_sku, component_sku, qty)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (warehouse_id, company_id, kit_sku, component_sku)
           DO UPDATE SET qty = EXCLUDED.qty, updated_at = now()`,
          [warehouseId, companyId, kit.kitSku, sku, qty],
        );
      }

      // Компонент, которого в новой матрице больше нет, надо убрать: иначе
      // «сколько можно собрать» будет упираться в товар, который из набора
      // давно вывели, и покажет ноль там, где собрать можно.
      for (const sku of was.keys()) {
        if (now.has(sku)) continue;
        stats.removed += 1;
        if (!apply) continue;
        await client.query(
          `DELETE FROM product_kits
           WHERE warehouse_id = $1 AND company_id = $2 AND kit_sku = $3 AND component_sku = $4`,
          [warehouseId, companyId, kit.kitSku, sku],
        );
      }
    }
  });

  console.log(`\nНаборов в файле: ${stats.kits}`);
  console.log(`  новых компонентов:   ${stats.added}`);
  console.log(`  изменилось количество: ${stats.updated}`);
  console.log(`  убрано из состава:   ${stats.removed}`);
  console.log(`  без изменений:       ${stats.unchanged}`);
  if (!apply) console.log('\nЭто предпросмотр. Чтобы записать — добавьте --apply');
  await pool.end();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
