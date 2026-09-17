const { HttpError } = require('../middleware/errorHandler');
const { encrypt, decrypt, mask } = require('./crypto');

// Ключи площадок: положить, достать, отметить, что сработал.
//
// Наружу открытый ключ не отдаётся никогда — ни владельцу, ни продавцу. Тот,
// кто ключ принёс, и так его знает; всем остальным достаточно маски. Читать
// ключ имеет право только код интеграции, и только чтобы сходить в API.

async function save(client, warehouseId, { companyId, marketplace, token }) {
  if (!companyId || !marketplace || !token) {
    throw new HttpError(400, 'Нужны продавец, площадка и ключ');
  }
  const payload = encrypt(JSON.stringify({ token }));
  const r = await client.query(
    `INSERT INTO marketplace_credentials (warehouse_id, company_id, marketplace, encrypted_payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id, marketplace)
     DO UPDATE SET encrypted_payload = EXCLUDED.encrypted_payload,
                   updated_at = now(), photo_cursor = '{}', photo_sync_after = NULL
     RETURNING id, marketplace, write_enabled, last_used_at`,
    [warehouseId, companyId, marketplace, payload],
  );
  // A replacement key may belong to a different WB account. Never keep its old images.
  await client.query('DELETE FROM marketplace_product_media WHERE credential_id=$1 AND warehouse_id=$2', [r.rows[0].id, warehouseId]);
  return { ...r.rows[0], tokenMask: mask(token) };
}

// Расшифрованный ключ. Единственная функция, после которой в памяти лежит
// открытый токен, — держать её вызовы наперечёт.
async function tokenFor(client, warehouseId, companyId, marketplace) {
  const r = await client.query(
    `SELECT encrypted_payload FROM marketplace_credentials
     WHERE warehouse_id = $1 AND company_id = $2 AND marketplace = $3`,
    [warehouseId, companyId, marketplace],
  );
  if (!r.rows[0]) throw new HttpError(404, 'Ключ для этой площадки не подключён');
  let parsed;
  try {
    parsed = JSON.parse(decrypt(r.rows[0].encrypted_payload));
  } catch (err) {
    // Обычно это значит, что MARKETPLACE_KEY_SECRET сменился или потерялся.
    // Сказать прямо: иначе владелец будет искать проблему на стороне площадки.
    throw new HttpError(500, `Ключ не расшифровывается: ${err.message}`);
  }
  return parsed.token;
}

// Ключ для ЗАПИСИ на площадку. Отдаётся только если владелец включил запись
// у этого ключа: по умолчанию Аргус ничего в кабинете продавца не меняет, и
// это согласие берётся у продавца отдельно. Нет флага — нет и токена, а
// значит и записи: вызывающий код просто ничего не делает.
async function writeTokenFor(client, warehouseId, companyId, marketplace) {
  const r = await client.query(
    `SELECT write_enabled FROM marketplace_credentials
      WHERE warehouse_id = $1 AND company_id = $2 AND marketplace = $3`,
    [warehouseId, companyId, marketplace],
  );
  if (!r.rows[0] || !r.rows[0].write_enabled) return null;
  return tokenFor(client, warehouseId, companyId, marketplace);
}

// Включить или выключить запись. Меняет то, что Аргус делает в чужом
// кабинете, поэтому право на это — отдельное (см. routes.js).
async function setWriteEnabled(client, warehouseId, companyId, marketplace, enabled) {
  const r = await client.query(
    `UPDATE marketplace_credentials SET write_enabled = $4, updated_at = now()
      WHERE warehouse_id = $1 AND company_id = $2 AND marketplace = $3
      RETURNING company_id, marketplace, write_enabled`,
    [warehouseId, companyId, marketplace, Boolean(enabled)],
  );
  if (!r.rows[0]) throw new HttpError(404, 'Ключ для этой площадки не подключён');
  return { companyId: r.rows[0].company_id, marketplace: r.rows[0].marketplace, writeEnabled: r.rows[0].write_enabled };
}

// Все подключённые пары «продавец + площадка» склада — для списка в кабинете и
// для обхода при синхронизации.
async function list(client, warehouseId) {
  const r = await client.query(
    `SELECT mc.id, mc.company_id, c.name AS company_name, mc.marketplace,
            mc.write_enabled, mc.last_used_at, mc.created_at
     FROM marketplace_credentials mc
     JOIN companies c ON c.id = mc.company_id AND c.archived_at IS NULL
     WHERE mc.warehouse_id = $1
     ORDER BY c.name, mc.marketplace`,
    [warehouseId],
  );
  return r.rows.map((x) => ({
    id: x.id,
    companyId: x.company_id,
    company: x.company_name,
    marketplace: x.marketplace,
    writeEnabled: x.write_enabled,
    lastUsedAt: x.last_used_at,
    createdAt: x.created_at,
  }));
}

async function markUsed(client, warehouseId, companyId, marketplace) {
  await client.query(
    `UPDATE marketplace_credentials SET last_used_at = now()
     WHERE warehouse_id = $1 AND company_id = $2 AND marketplace = $3`,
    [warehouseId, companyId, marketplace],
  );
}

async function remove(client, warehouseId, companyId, marketplace) {
  const r = await client.query(
    `DELETE FROM marketplace_credentials
     WHERE warehouse_id = $1 AND company_id = $2 AND marketplace = $3`,
    [warehouseId, companyId, marketplace],
  );
  if (r.rowCount === 0) throw new HttpError(404, 'Такой ключ не подключён');
  return { removed: true };
}

module.exports = {
  save, tokenFor, writeTokenFor, setWriteEnabled, list, markUsed, remove,
};
