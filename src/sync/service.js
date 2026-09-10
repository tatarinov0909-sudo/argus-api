const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { HttpError } = require('../middleware/errorHandler');

const trimmed = (value) => typeof value === 'string' ? value.trim() : '';

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
    const externalId = trimmed(rec.externalId);
    const name = trimmed(rec.name);
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

// Справочник контрагентов нужен владельцу для одноразового сопоставления с
// компаниями Argus. Сам по себе контрагент 1С не становится продавцом: в УТ
// здесь также лежат перевозчики, поставщики услуг и архивные организации.
async function upsertCounterparties(client, warehouseId, records) {
  const results = [];
  for (const rec of records) {
    const externalId = trimmed(rec.externalId);
    const name = trimmed(rec.name);
    if (!externalId || !name) {
      results.push({ externalId: externalId || null, status: 'error', error: 'externalId и name обязательны' });
      continue;
    }
    await client.query(
      `INSERT INTO integration_counterparties (warehouse_id, external_id, name, last_seen_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (warehouse_id, external_id)
       DO UPDATE SET name = EXCLUDED.name, last_seen_at = now()`,
      [warehouseId, externalId, name],
    );
    results.push({ externalId, status: 'updated' });
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

async function resolveProductForRecord(client, warehouseId, rec, companyId = null) {
  const externalId = trimmed(rec.productExternalId);
  const sku = trimmed(rec.sku);

  if (externalId) {
    const found = await client.query(
      `SELECT id, company_id, sku, external_id FROM products
       WHERE warehouse_id = $1 AND external_id = $2 FOR UPDATE`,
      [warehouseId, externalId],
    );
    if (found.rows[0] && sku && found.rows[0].sku !== sku) {
      return { code: 'product_identity_conflict', error: 'Идентификатор 1С и артикул указывают на разные товары; запись не изменена' };
    }
    return found.rows[0]
      ? { product: found.rows[0] }
      : { code: 'product_not_found', error: 'Товар не найден по идентификатору 1С — сначала выгрузите номенклатуру' };
  }

  if (!sku) return { error: 'sku или productExternalId обязателен' };
  const found = await client.query(
    `SELECT id, company_id, sku, external_id FROM products
     WHERE warehouse_id = $1 AND sku = $2
     ORDER BY (company_id = $3::uuid) DESC NULLS LAST, id`,
    [warehouseId, sku, companyId],
  );
  if (found.rows.length === 0) {
    return { error: 'Товар не найден — сначала выгрузите номенклатуру' };
  }
  if (found.rows.length > 1) {
    const exact = companyId ? found.rows.filter((row) => row.company_id === companyId) : [];
    if (exact.length === 1) return { product: exact[0] };
    return { error: 'Артикул встречается у нескольких продавцов — нужен productExternalId из 1С' };
  }
  return { product: found.rows[0] };
}

function finiteNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function numeric(value) {
  const n = finiteNumber(value);
  return n !== null && n >= 0 ? n : null;
}

// Остатки из 1С.
//
// Приходит «сколько всего этого артикула на складе» — то, что 1С знает точно.
// Кладём рядом с карточкой, а не в ячейки: в какой ячейке товар лежит, знает
// только Аргус, и узнаёт он это, когда работник туда что-то положил.
// Разложить итог по ячейкам самим означало бы выдумать адреса — ровно то, из-за
// чего пришлось стирать 879 строк.
//
// Обмен идёт пачками и повторяется по расписанию, поэтому это именно снимок:
// каждый раз перезаписываем, а не прибавляем.
// Адреса хранения из 1С: товар лежит в такой-то ячейке.
//
// Снимок, а не журнал: 1С присылает текущую раскладку целиком по каждому
// товару, поэтому прежние строки этого товара сначала удаляем. Иначе позиция,
// которую переставили из А-01 в Б-07, осталась бы числиться в обеих —
// а «лежит в двух местах» хуже, чем «не знаем, где лежит».
// Справочник ячеек: не «где что лежит», а «какие ячейки вообще есть».
//
// Нужен отдельно от адресов, потому что пустая ячейка — тоже ячейка: карта
// склада, нарисованная по одним занятым, показала бы дырявый склад и
// работник искал бы полку, которой на схеме нет.
async function upsertCellCatalog(client, warehouseId, records) {
  const results = [];
  for (const rec of records) {
    const name = typeof rec.cell === 'string' ? rec.cell.trim() : '';
    if (!name) {
      results.push({ cell: null, status: 'error', error: 'cell обязателен' });
      continue;
    }
    // «01-02-015» — ряд, ярус, ячейка. Имя не в формате не выбрасываем:
    // сохраняем без координат, чтобы было видно, что склад размечен не весь.
    const m = /^(\d+)-(\d+)-(\d+)$/.exec(name);
    const [rowNum, tier, pos] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [null, null, null];
    await client.query(
      `INSERT INTO warehouse_cells_1c (warehouse_id, cell_name, row_num, tier, pos, synced_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (warehouse_id, cell_name)
       DO UPDATE SET row_num = EXCLUDED.row_num, tier = EXCLUDED.tier,
                     pos = EXCLUDED.pos, synced_at = now()`,
      [warehouseId, name, rowNum, tier, pos],
    );
    results.push({ cell: name, status: m ? 'updated' : 'updated_unparsed' });
  }
  return results;
}

async function upsertCells1c(client, warehouseId, records, options = {}) {
  const results = [];
  const resolved = [];
  for (const rec of records) {
    const sku = trimmed(rec.sku);
    const cellName = typeof rec.cell === 'string' ? rec.cell.trim() : '';
    if ((!sku && !rec.productExternalId) || !cellName) {
      results.push({ sku: sku || null, status: 'error', error: 'sku и cell обязательны' });
      continue;
    }

    const explicitCompanyId = await resolveCompany(client, warehouseId, rec.companyExternalId);
    if (rec.companyExternalId && !explicitCompanyId) {
      results.push({ sku, status: 'error', error: 'Контрагент 1С ещё не связан с компанией Argus' });
      continue;
    }
    const companyId = explicitCompanyId || options.defaultCompanyId || null;
    const lookup = await resolveProductForRecord(client, warehouseId, rec, companyId);
    if (!lookup.product) {
      results.push({ sku, status: 'error', error: lookup.error });
      continue;
    }
    if (companyId && lookup.product.company_id && lookup.product.company_id !== companyId) {
      results.push({ sku, status: 'error', error: 'Владелец товара не совпадает с контрагентом записи' });
      continue;
    }
    resolved.push({ rec, sku: lookup.product.sku, cellName, product: lookup.product });
  }

  // Чистим снимок один раз на товар, затем кладём все его ячейки из пачки.
  // product_id не даёт одинаковым артикулам разных продавцов стереть друг
  // друга, а productExternalId из 1С снимает неоднозначность поиска.
  const productIds = [...new Set(resolved.map((row) => row.product.id))];
  if (productIds.length) {
    await client.query(
      `DELETE FROM product_cells_1c
       WHERE warehouse_id = $1 AND product_id = ANY($2::uuid[])`,
      [warehouseId, productIds],
    );
  }

  for (const row of resolved) {
    const { rec, sku, cellName, product } = row;
    await client.query(
      `INSERT INTO product_cells_1c
         (warehouse_id, company_id, product_id, sku, cell_name, qty, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (warehouse_id, product_id, cell_name) WHERE product_id IS NOT NULL
       DO UPDATE SET qty = EXCLUDED.qty, synced_at = now(), company_id = EXCLUDED.company_id`,
      [warehouseId, product.company_id, product.id, sku, cellName, numeric(rec.qty)],
    );
    results.push({ sku, status: 'updated', cell: cellName });
  }

  return results;
}

async function upsertStock(client, warehouseId, records, options = {}) {
  const results = [];
  const now = new Date();

  for (const rec of records) {
    const sku = trimmed(rec.sku);
    if (!sku && !rec.productExternalId) {
      results.push({ sku: null, status: 'error', error: 'sku или productExternalId обязателен' });
      continue;
    }
    // Учётный остаток может быть отрицательным. Это факт из 1С для сверки,
    // а не физическое количество в ячейках и не доступное к продаже.
    const qty = finiteNumber(rec.qty);
    if (qty === null) {
      results.push({ sku, productExternalId: rec.productExternalId || null, status: 'error', code: 'invalid_quantity', error: 'Не передано числовое значение qty; прежний остаток сохранён' });
      continue;
    }

    const explicitCompanyId = await resolveCompany(client, warehouseId, rec.companyExternalId);
    if (rec.companyExternalId && !explicitCompanyId) {
      results.push({ sku, status: 'error', error: 'Контрагент 1С ещё не связан с компанией Argus' });
      continue;
    }
    const companyId = explicitCompanyId || options.defaultCompanyId || null;
    const lookup = await resolveProductForRecord(client, warehouseId, rec, companyId);
    if (!lookup.product) {
      results.push({ sku, productExternalId: rec.productExternalId || null, status: 'error', code: lookup.code || 'product_not_resolved', error: lookup.error });
      continue;
    }
    if (companyId && lookup.product.company_id && lookup.product.company_id !== companyId) {
      results.push({ sku, status: 'error', error: 'Владелец товара не совпадает с контрагентом записи' });
      continue;
    }
    await client.query(
      `UPDATE products SET stock_qty_1c = $2, stock_at = $3, updated_at = now()
       WHERE id = $1`,
      [lookup.product.id, qty, now],
    );
    results.push({ sku: lookup.product.sku, status: 'updated', rows: 1,
      ...(qty < 0 ? { warning: 'negative_accounting_stock' } : {}) });
  }

  return results;
}

async function upsertProducts(client, warehouseId, records, options = {}) {
  const results = [];
  for (const rec of records) {
    const externalId = trimmed(rec.externalId);
    const sku = trimmed(rec.sku);
    const name = trimmed(rec.name);
    if (!externalId || !sku || !name) {
      results.push({ externalId: externalId || null, status: 'error', error: 'externalId, sku и name обязательны' });
      continue;
    }

    // Некоторые базы (в частности старые УТ 10.3) не связывают номенклатуру
    // с контрагентом вообще — тогда весь пуш идёт под одну явно указанную
    // владельцем компанию, а не по externalId на каждую запись.
    const explicitCompanyId = await resolveCompany(client, warehouseId, rec.companyExternalId);
    if (rec.companyExternalId && !explicitCompanyId) {
      results.push({
        externalId, status: 'error',
        error: 'Контрагент 1С ещё не связан с компанией Argus',
      });
      continue;
    }
    const companyId = explicitCompanyId || options.defaultCompanyId || null;

    // Штрихкод и резерв приходят из 1С и не пересчитываются у нас: первый
    // напечатан на коробке, второй знает только 1С. Обоих может не быть —
    // конфигурации разные, и обмен не должен от этого падать.
    const barcode = typeof rec.barcode === 'string' ? rec.barcode.trim().slice(0, 64) : null;
    const reserved = numeric(rec.reservedQty);

    const fields = {
      name,
      category: trimmed(rec.category) || null,
      length_mm: numeric(rec.lengthMm),
      width_mm: numeric(rec.widthMm),
      height_mm: numeric(rec.heightMm),
      weight_g: numeric(rec.weightG),
      active: rec.active === undefined ? true : Boolean(rec.active),
      barcode: barcode || null,
      reserved_qty: reserved,
      // Отметка времени у резерва обязательна: без неё нельзя отличить
      // «ноль в резерве» от «1С давно не присылала резервы».
      reserved_at: reserved === null ? null : new Date(),
    };

    const byExternal = await client.query(
      `SELECT id, company_id FROM products WHERE warehouse_id = $1 AND external_id = $2 FOR UPDATE`,
      [warehouseId, externalId],
    );
    let target = byExternal.rows[0] || (companyId ? (await client.query(
      `SELECT id, company_id FROM products
       WHERE warehouse_id = $1 AND company_id = $2 AND sku = $3 AND external_id IS NULL FOR UPDATE`,
      [warehouseId, companyId, sku],
    )).rows[0] : null);

    if (target) {
      // Повторная загрузка каталога не вправе переопределять уже назначенного
      // продавца, в том числе через старый пакетный defaultCompanyName.
      if (companyId && target.company_id && companyId !== target.company_id) {
        results.push({ externalId, status: 'ownership_conflict', error: 'Товар уже назначен другой компании; связь сохранена' });
        continue;
      }
      if (companyId && !target.company_id) {
        const ownership = await claimProductOwnership(client, warehouseId, companyId, { productExternalId: externalId, sku });
        if (ownership.status === 'conflict') {
          results.push({ externalId, status: 'ownership_conflict', error: ownership.error });
          continue;
        }
        target = { ...target, id: ownership.productId };
      }
      await client.query(
        // COALESCE у штрихкода и резерва: обмен, который их ещё не умеет
        // присылать, не должен стирать уже полученные. Затирать данные
        // молчанием — худший вид потери.
        `UPDATE products SET name = $2, category = $3, length_mm = $4, width_mm = $5,
                             height_mm = $6, weight_g = $7, active = $8,
                             external_id = $9,
                             barcode = COALESCE($10, barcode),
                             reserved_qty = COALESCE($11, reserved_qty),
                             reserved_at = COALESCE($12, reserved_at),
                             company_id = COALESCE($13, company_id),
                             updated_at = now()
         WHERE id = $1`,
        [
          target.id, fields.name, fields.category, fields.length_mm, fields.width_mm,
          fields.height_mm, fields.weight_g, fields.active, externalId,
          fields.barcode, fields.reserved_qty, fields.reserved_at, companyId,
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
            length_mm, width_mm, height_mm, weight_g, active, external_id,
            barcode, reserved_qty, reserved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [
          warehouseId, companyId, sku, fields.name, fields.category,
          fields.length_mm, fields.width_mm, fields.height_mm, fields.weight_g,
          fields.active, externalId,
          fields.barcode, fields.reserved_qty, fields.reserved_at,
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

async function claimProductOwnership(client, warehouseId, companyId, item) {
  const lookup = await resolveProductForRecord(client, warehouseId, item, companyId);
  if (!lookup.product) return { status: lookup.code === 'product_identity_conflict' ? 'conflict' : 'missing', sku: item.sku || null, error: lookup.error };

  const source = (await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [lookup.product.id])).rows[0];
  if (source.company_id === companyId) return { status: 'matched', sku: source.sku, productId: source.id };

  // Разрешено исправлять только прежнее автоматическое назначение в компанию,
  // которая сама не связана с контрагентом 1С. Уже подтверждённую связь двух
  // разных продавцов не перетираем: это неоднозначные данные, их надо показать.
  const oldCompany = (await client.query(
    'SELECT external_id FROM companies WHERE id = $1', [source.company_id],
  )).rows[0];
  if (oldCompany?.external_id) {
    return { status: 'conflict', sku: source.sku, error: 'Товар уже связан с другим контрагентом 1С' };
  }
  if (source.company_id) {
    const used = await client.query(`SELECT
      EXISTS (SELECT 1 FROM cell_stock WHERE warehouse_id = $1 AND company_id = $2 AND sku = $3)
      OR EXISTS (SELECT 1 FROM invoice_items i WHERE i.warehouse_id = $1 AND i.company_id = $2 AND i.sku = $3
        AND (EXISTS (SELECT 1 FROM receiving_records r WHERE r.invoice_item_id = i.id)
          OR EXISTS (SELECT 1 FROM shipping_records s WHERE s.invoice_item_id = i.id))) AS physical`,
    [warehouseId, source.company_id, source.sku]);
    if (used.rows[0].physical) {
      return { status: 'conflict', sku: source.sku, error: 'По товару есть складские операции другой компании; автоматический перенос запрещён' };
    }
  }

  const target = (await client.query(
    `SELECT * FROM products WHERE warehouse_id = $1 AND company_id = $2 AND sku = $3 FOR UPDATE`,
    [warehouseId, companyId, source.sku],
  )).rows[0];

  if (!target) {
    await client.query('UPDATE products SET company_id = $2, updated_at = now() WHERE id = $1', [source.id, companyId]);
    await client.query('UPDATE product_cells_1c SET company_id = $2 WHERE product_id = $1', [source.id, companyId]);
    return { status: source.company_id ? 'reassigned' : 'assigned', sku: source.sku, productId: source.id };
  }
  if (target.external_id && target.external_id !== source.external_id) {
    return { status: 'conflict', sku: source.sku, error: 'У продавца уже есть другой товар с этим артикулом' };
  }

  await client.query('UPDATE products SET external_id = NULL WHERE id = $1', [source.id]);
  await client.query(
    `DELETE FROM product_cells_1c old
      USING product_cells_1c current
     WHERE old.product_id = $1 AND current.product_id = $2
       AND old.warehouse_id = current.warehouse_id AND old.cell_name = current.cell_name`,
    [source.id, target.id],
  );
  await client.query(
    `UPDATE product_cells_1c
     SET product_id = $2, company_id = $3, sku = $4
     WHERE product_id = $1`,
    [source.id, target.id, companyId, target.sku],
  );
  await client.query(
    `UPDATE products SET
       external_id = COALESCE(external_id, $2),
       category = COALESCE(category, $3),
       length_mm = COALESCE(length_mm, $4), width_mm = COALESCE(width_mm, $5),
       height_mm = COALESCE(height_mm, $6), weight_g = COALESCE(weight_g, $7),
       barcode = COALESCE(barcode, $8), reserved_qty = COALESCE(reserved_qty, $9),
       reserved_at = COALESCE(reserved_at, $10), stock_qty_1c = COALESCE(stock_qty_1c, $11),
       stock_at = COALESCE(stock_at, $12), updated_at = now()
     WHERE id = $1`,
    [
      target.id, source.external_id, source.category, source.length_mm, source.width_mm,
      source.height_mm, source.weight_g, source.barcode, source.reserved_qty,
      source.reserved_at, source.stock_qty_1c, source.stock_at,
    ],
  );
  await client.query('DELETE FROM products WHERE id = $1', [source.id]);
  return { status: 'merged', sku: target.sku, productId: target.id };
}

async function upsertInvoices(client, warehouseId, records, options = {}) {
  const results = [];
  for (const rec of records) {
    const externalId = trimmed(rec.externalId);
    const number = trimmed(rec.number);
    const direction = rec.direction === 'out' ? 'out' : 'in';
    if (!externalId || !number || !Array.isArray(rec.items) || rec.items.length === 0) {
      results.push({
        externalId: externalId || null, status: 'error',
        error: 'externalId, number и хотя бы одна позиция обязательны',
      });
      continue;
    }

    // Явно указанный, но не связанный контрагент никогда не подменяется
    // пакетной компанией: иначе документ чужого продавца попадёт в её кабинет.
    const explicitCompanyId = await resolveCompany(client, warehouseId, rec.companyExternalId);
    const companyId = rec.companyExternalId ? explicitCompanyId : options.defaultCompanyId || null;
    if (!companyId) {
      results.push({
        externalId, companyExternalId: rec.companyExternalId || null, status: 'skipped_unmapped_company',
        error: 'Контрагент документа ещё не связан с продавцом в настройках склада',
      });
      continue;
    }

    const badItem = rec.items.some((it) => !it || !trimmed(it.sku)
      || finiteNumber(it.declaredQty) === null || finiteNumber(it.declaredQty) <= 0
      || ['name', 'externalId', 'productExternalId'].some((key) => it[key] != null && typeof it[key] !== 'string'));
    if (badItem) {
      results.push({ externalId, status: 'error', code: 'invalid_invoice_item', error: 'В каждой позиции нужны артикул и положительное числовое количество; документ сохранён без изменений' });
      continue;
    }
    const sourceType = typeof rec.sourceDocumentType === 'string' && /^[a-z_]{1,64}$/.test(rec.sourceDocumentType)
      ? rec.sourceDocumentType : null;
    const sourceDate = typeof rec.sourceDocumentDate === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(rec.sourceDocumentDate)
      && Number.isFinite(Date.parse(rec.sourceDocumentDate + 'Z'))
      && new Date(rec.sourceDocumentDate + 'Z').toISOString().slice(0, 19) === rec.sourceDocumentDate ? rec.sourceDocumentDate : null;
    if (rec.sourceDocumentDate != null && sourceDate === null) {
      results.push({ externalId, status: 'error', code: 'invalid_source_date', error: 'Некорректная дата документа 1С; прежний документ сохранён' });
      continue;
    }

    // Один некорректный документ не отменяет остальные документы пачки.
    // Конфликт принадлежности откатывает и строки, и назначение товаров.
    await client.query('SAVEPOINT sp_sync_invoice');
    try {

    // source = '1c' во всех трёх запросах ниже — граница между источниками.
    // Внешний номер уникален теперь по тройке (склад, источник, номер), и без
    // этого условия обмен нашёл бы заказ, приехавший с маркетплейса, и
    // переписал бы его как свой. Один заказ — один источник, это решение
    // принято отдельно и здесь оно исполняется.
    const existing = await client.query(
      `SELECT id, status, company_id FROM invoices
       WHERE warehouse_id = $1 AND source = '1c' AND external_id = $2 FOR UPDATE`,
      [warehouseId, externalId],
    );
    const found = existing.rows[0] || (await client.query(
      `SELECT id, status, company_id FROM invoices
       WHERE warehouse_id = $1 AND source = '1c' AND number = $2 AND external_id IS NULL
         AND company_id = $3 AND direction = $4 FOR UPDATE`,
      [warehouseId, number, companyId, direction],
    )).rows[0];

    if (found) {
      // The load-bearing guard in this whole module. A worker may already be
      // halfway through counting this delivery; replacing its lines would
      // destroy receiving_records' FK targets and silently discard the counts
      // already entered. 1C re-sends documents on every poll, so this is the
      // normal case, not an edge case.
      const worked = await client.query(`SELECT EXISTS (
        SELECT 1 FROM invoice_items i WHERE i.invoice_id = $1
        AND (EXISTS (SELECT 1 FROM receiving_records r WHERE r.invoice_item_id = i.id)
          OR EXISTS (SELECT 1 FROM shipping_records s WHERE s.invoice_item_id = i.id))) AS has_work`, [found.id]);
      if (found.status !== 'open' || worked.rows[0].has_work) {
        await client.query('RELEASE SAVEPOINT sp_sync_invoice');
        results.push({ externalId, id: found.id, status: 'skipped_in_progress' });
        continue;
      }
      if (found.company_id !== companyId) {
        const old = await client.query('SELECT external_id FROM companies WHERE id = $1', [found.company_id]);
        if (old.rows[0]?.external_id) {
          await client.query('RELEASE SAVEPOINT sp_sync_invoice');
          results.push({ externalId, id: found.id, status: 'ownership_conflict', error: 'Документ уже принадлежит другому связанному продавцу' });
          continue;
        }
      }
      await client.query(
        `UPDATE invoices SET number = $2, direction = $3, company_id = $4, external_id = $5,
           source_document_type = COALESCE($6, source_document_type),
           source_document_date = COALESCE($7, source_document_date)
         WHERE id = $1`,
        [found.id, number, direction, companyId, externalId, sourceType, sourceDate],
      );
      await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [found.id]);
      await insertItems(client, warehouseId, companyId, found.id, rec.items);
      const ownership = [];
      for (const item of rec.items) ownership.push(await claimProductOwnership(client, warehouseId, companyId, item));
      const conflicts = ownership.filter((row) => row.status === 'conflict');
      if (conflicts.length) await client.query('ROLLBACK TO SAVEPOINT sp_sync_invoice');
      await client.query('RELEASE SAVEPOINT sp_sync_invoice');
      results.push({
        externalId, id: found.id,
        status: conflicts.length ? 'ownership_conflict' : (existing.rows[0] ? 'updated' : 'adopted'),
        ...(conflicts.length ? { error: `${conflicts.length} позиций с конфликтом принадлежности; документ не изменён` } : {}),
      });
      continue;
    }

    const inserted = await client.query(
      `INSERT INTO invoices (warehouse_id, company_id, number, direction, external_id, source, source_document_type, source_document_date)
       VALUES ($1, $2, $3, $4, $5, '1c', $6, $7) RETURNING id`,
      [warehouseId, companyId, number, direction, externalId, sourceType, sourceDate],
    );
    await insertItems(client, warehouseId, companyId, inserted.rows[0].id, rec.items);
    const ownership = [];
    for (const item of rec.items) ownership.push(await claimProductOwnership(client, warehouseId, companyId, item));
    const conflicts = ownership.filter((row) => row.status === 'conflict');
    if (conflicts.length) await client.query('ROLLBACK TO SAVEPOINT sp_sync_invoice');
    await client.query('RELEASE SAVEPOINT sp_sync_invoice');
    results.push({
      externalId, ...(conflicts.length ? {} : { id: inserted.rows[0].id }),
      status: conflicts.length ? 'ownership_conflict' : 'created',
      ...(conflicts.length ? { error: `${conflicts.length} позиций с конфликтом принадлежности; документ не создан` } : {}),
    });
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT sp_sync_invoice');
      await client.query('RELEASE SAVEPOINT sp_sync_invoice');
      if (!['23505', '23514', '22P02', '22003'].includes(err.code) && !(err instanceof HttpError)) throw err;
      results.push({ externalId, status: 'error', code: 'invalid_document', error: 'Документ не сохранён: проверьте уникальность номера, артикулы и количества' });
    }
  }
  return results;
}

async function insertItems(client, warehouseId, companyId, invoiceId, items) {
  for (const it of items) {
    const sku = trimmed(it.sku);
    const name = trimmed(it.name) || sku;
    if (!sku || it.declaredQty == null) {
      throw new HttpError(400, `Позиция без артикула или количества в накладной`);
    }
    await client.query(
      `INSERT INTO invoice_items
         (invoice_id, warehouse_id, company_id, name, sku, declared_qty, external_id, product_external_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        invoiceId, warehouseId, companyId, name, sku, it.declaredQty,
        trimmed(it.externalId) || null, trimmed(it.productExternalId) || null,
      ],
    );
  }
}

module.exports = {
  upsertStock,
  upsertCells1c,
  upsertCellCatalog,
  signIntegrationToken,
  generateKeyCode,
  upsertCompanies,
  upsertCounterparties,
  upsertProducts,
  upsertInvoices,
};
