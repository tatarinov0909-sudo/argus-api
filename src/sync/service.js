const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { HttpError } = require('../middleware/errorHandler');

// Matching rules shared by every push endpoint, in priority order:
//
//   1. by external_id — the 1C identifier. Authoritative once present.
//   2. by natural key (company name / sku / invoice number) but ONLY on rows
//      that have no external_id yet — "adoption". The owner will have created
//      companies and products by hand before the 1C module was ever installed;
//      without this step the first sync would duplicate every one of them.
//      Stamping external_id onto the existing row links the two permanently,
//      so adoption happens at most once per row.
//   3. insert.
//
// Everything here is idempotent: re-pushing the same batch changes nothing the
// second time. 1C polls on a schedule and will re-send after any network
// failure, so this is a correctness requirement, not a nicety.

function signIntegrationToken({ warehouseId, integrationKeyId }) {
  return jwt.sign(
    { role: 'integration', warehouseId, integrationKeyId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.SYNC_TOKEN_EXPIRES_IN || '2h' },
  );
}

function generateKeyCode(warehouseCode) {
  const random = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `1C-${warehouseCode}-${random}`;
}

async function upsertCompanies(client, warehouseId, records) {
  const results = [];
  for (const rec of records) {
    const externalId = rec.externalId?.trim();
    const name = rec.name?.trim();
    if (!externalId || !name) {
      results.push({ externalId: externalId || null, status: 'error', error: 'externalId и name обязательны' });
      continue;
    }

    const byExternal = await client.query(
      `SELECT id FROM companies WHERE warehouse_id = $1 AND external_id = $2`,
      [warehouseId, externalId],
    );
    if (byExternal.rows[0]) {
      await client.query(`UPDATE companies SET name = $2 WHERE id = $1`, [byExternal.rows[0].id, name]);
      results.push({ externalId, id: byExternal.rows[0].id, status: 'updated' });
      continue;
    }

    const byName = await client.query(
      `SELECT id FROM companies
       WHERE warehouse_id = $1 AND name = $2 AND external_id IS NULL
       ORDER BY created_at LIMIT 1`,
      [warehouseId, name],
    );
    if (byName.rows[0]) {
      await client.query(
        `UPDATE companies SET external_id = $2 WHERE id = $1`,
        [byName.rows[0].id, externalId],
      );
      results.push({ externalId, id: byName.rows[0].id, status: 'adopted' });
      continue;
    }

    const inserted = await client.query(
      `INSERT INTO companies (warehouse_id, name, external_id) VALUES ($1, $2, $3) RETURNING id`,
      [warehouseId, name, externalId],
    );
    results.push({ externalId, id: inserted.rows[0].id, status: 'created' });
  }
  return results;
}

// Resolves the company a pushed row belongs to. 1C references its own
// контрагент id, which is meaningless here until that company has been synced,
// so an unresolvable reference is reported per-row rather than failing the
// whole batch — one unknown counterparty must not block every other product.
async function resolveCompany(client, warehouseId, companyExternalId) {
  if (!companyExternalId) return null;
  const result = await client.query(
    `SELECT id FROM companies WHERE warehouse_id = $1 AND external_id = $2`,
    [warehouseId, companyExternalId],
  );
  return result.rows[0]?.id || null;
}

function numeric(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function upsertProducts(client, warehouseId, records, options = {}) {
  const results = [];
  for (const rec of records) {
    const externalId = rec.externalId?.trim();
    const sku = rec.sku?.trim();
    const name = rec.name?.trim();
    if (!externalId || !sku || !name) {
      results.push({ externalId: externalId || null, status: 'error', error: 'externalId, sku и name обязательны' });
      continue;
    }

    // Некоторые базы (в частности старые УТ 10.3) не связывают номенклатуру
    // с контрагентом вообще — тогда весь пуш идёт под одну явно указанную
    // владельцем компанию, а не по externalId на каждую запись.
    const companyId = (await resolveCompany(client, warehouseId, rec.companyExternalId)) || options.defaultCompanyId || null;
    if (!companyId) {
      results.push({
        externalId, status: 'error',
        error: `Компания ${rec.companyExternalId || '(не указана)'} не найдена — синхронизируйте контрагентов`,
      });
      continue;
    }

    const fields = {
      name,
      category: rec.category?.trim() || null,
      length_mm: numeric(rec.lengthMm),
      width_mm: numeric(rec.widthMm),
      height_mm: numeric(rec.heightMm),
      weight_g: numeric(rec.weightG),
      active: rec.active === undefined ? true : Boolean(rec.active),
    };

    const byExternal = await client.query(
      `SELECT id FROM products WHERE warehouse_id = $1 AND external_id = $2`,
      [warehouseId, externalId],
    );
    const target = byExternal.rows[0] || (await client.query(
      `SELECT id FROM products
       WHERE warehouse_id = $1 AND company_id = $2 AND sku = $3 AND external_id IS NULL`,
      [warehouseId, companyId, sku],
    )).rows[0];

    if (target) {
      await client.query(
        `UPDATE products SET name = $2, category = $3, length_mm = $4, width_mm = $5,
                             height_mm = $6, weight_g = $7, active = $8,
                             external_id = $9, updated_at = now()
         WHERE id = $1`,
        [
          target.id, fields.name, fields.category, fields.length_mm, fields.width_mm,
          fields.height_mm, fields.weight_g, fields.active, externalId,
        ],
      );
      results.push({
        externalId, id: target.id, status: byExternal.rows[0] ? 'updated' : 'adopted',
      });
      continue;
    }

    // SAVEPOINT, not just try/catch: the whole batch runs inside one
    // transaction (withTenantContext), and Postgres poisons the entire
    // transaction after any failed statement — every query after it errors
    // with "current transaction is aborted" even though the JS exception
    // was caught. The savepoint gives one bad row something to roll back to
    // without taking the other 499 rows in the batch down with it.
    await client.query('SAVEPOINT sp_insert_product');
    try {
      const inserted = await client.query(
        `INSERT INTO products
           (warehouse_id, company_id, sku, name, category,
            length_mm, width_mm, height_mm, weight_g, active, external_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          warehouseId, companyId, sku, fields.name, fields.category,
          fields.length_mm, fields.width_mm, fields.height_mm, fields.weight_g,
          fields.active, externalId,
        ],
      );
      await client.query('RELEASE SAVEPOINT sp_insert_product');
      results.push({ externalId, id: inserted.rows[0].id, status: 'created' });
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT sp_insert_product');
      // 1C "Код" isn't guaranteed unique across the whole catalog the way a
      // real SKU would be — a second item can collide with (company, sku)
      // once the first has already claimed it.
      if (err.code === '23505') {
        results.push({ externalId, status: 'error', error: `Дубликат SKU "${sku}" для этой компании` });
        continue;
      }
      throw err;
    }
  }
  return results;
}

async function upsertInvoices(client, warehouseId, records, options = {}) {
  const results = [];
  for (const rec of records) {
    const externalId = rec.externalId?.trim();
    const number = rec.number?.trim();
    const direction = rec.direction === 'out' ? 'out' : 'in';
    if (!externalId || !number || !Array.isArray(rec.items) || rec.items.length === 0) {
      results.push({
        externalId: externalId || null, status: 'error',
        error: 'externalId, number и хотя бы одна позиция обязательны',
      });
      continue;
    }

    // Та же оговорка, что и у товаров: базы без связи документа с
    // контрагентом (в частности старая УТ 10.3) шлют весь пуш под одну
    // явно указанную владельцем компанию, не по externalId на запись.
    const companyId = (await resolveCompany(client, warehouseId, rec.companyExternalId)) || options.defaultCompanyId || null;
    if (!companyId) {
      results.push({
        externalId, status: 'error',
        error: `Компания ${rec.companyExternalId || '(не указана)'} не найдена — синхронизируйте контрагентов`,
      });
      continue;
    }

    // source = '1c' во всех трёх запросах ниже — граница между источниками.
    // Внешний номер уникален теперь по тройке (склад, источник, номер), и без
    // этого условия обмен нашёл бы заказ, приехавший с маркетплейса, и
    // переписал бы его как свой. Один заказ — один источник, это решение
    // принято отдельно и здесь оно исполняется.
    const existing = await client.query(
      `SELECT id, status FROM invoices
       WHERE warehouse_id = $1 AND source = '1c' AND external_id = $2`,
      [warehouseId, externalId],
    );
    const found = existing.rows[0] || (await client.query(
      `SELECT id, status FROM invoices
       WHERE warehouse_id = $1 AND source = '1c' AND number = $2 AND external_id IS NULL`,
      [warehouseId, number],
    )).rows[0];

    if (found) {
      // The load-bearing guard in this whole module. A worker may already be
      // halfway through counting this delivery; replacing its lines would
      // destroy receiving_records' FK targets and silently discard the counts
      // already entered. 1C re-sends documents on every poll, so this is the
      // normal case, not an edge case.
      if (found.status !== 'open') {
        results.push({ externalId, id: found.id, status: 'skipped_in_progress' });
        continue;
      }
      await client.query(
        `UPDATE invoices SET number = $2, direction = $3, company_id = $4, external_id = $5
         WHERE id = $1`,
        [found.id, number, direction, companyId, externalId],
      );
      await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [found.id]);
      await insertItems(client, warehouseId, companyId, found.id, rec.items);
      results.push({ externalId, id: found.id, status: existing.rows[0] ? 'updated' : 'adopted' });
      continue;
    }

    const inserted = await client.query(
      `INSERT INTO invoices (warehouse_id, company_id, number, direction, external_id, source)
       VALUES ($1, $2, $3, $4, $5, '1c') RETURNING id`,
      [warehouseId, companyId, number, direction, externalId],
    );
    await insertItems(client, warehouseId, companyId, inserted.rows[0].id, rec.items);
    results.push({ externalId, id: inserted.rows[0].id, status: 'created' });
  }
  return results;
}

async function insertItems(client, warehouseId, companyId, invoiceId, items) {
  for (const it of items) {
    const sku = it.sku?.trim();
    const name = it.name?.trim() || sku;
    if (!sku || it.declaredQty == null) {
      throw new HttpError(400, `Позиция без артикула или количества в накладной`);
    }
    await client.query(
      `INSERT INTO invoice_items
         (invoice_id, warehouse_id, company_id, name, sku, declared_qty, external_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [invoiceId, warehouseId, companyId, name, sku, it.declaredQty, it.externalId?.trim() || null],
    );
  }
}

module.exports = {
  signIntegrationToken,
  generateKeyCode,
  upsertCompanies,
  upsertProducts,
  upsertInvoices,
};
