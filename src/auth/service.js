const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { withTenantContext, withoutTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'z', з: 'z',
  и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'c', ш: 's', щ: 's',
  ъ: '', ы: 'i', ь: '', э: 'e', ю: 'u', я: 'a',
};

function transliteratePrefix(name) {
  const words = name.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => {
    const ch = w[0];
    return (TRANSLIT[ch] || ch || 'X').toUpperCase();
  });
  const prefix = letters.join('').padEnd(2, 'X').slice(0, 2);
  return prefix;
}

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '45m',
  });
}

async function registerOwner({ name, email, password, warehouseName, city }) {
  if (!name || !email || !password || !warehouseName) {
    throw new HttpError(400, 'Заполните все обязательные поля');
  }
  const passwordHash = await bcrypt.hash(password, 12);

  // Bootstrap problem: the warehouse row is RLS-protected by its own id,
  // which doesn't exist until we insert it. Generate the id client-side so
  // withTenantContext can scope a real transaction to it before inserting —
  // set_config(..., true) ("is_local") only holds for the current
  // transaction, so this must run inside withTenantContext's BEGIN/COMMIT,
  // not as a bare query before it (that was the bug: the setting was gone
  // by the time the INSERT ran, and Postgres correctly rejected the row).
  const warehouseId = crypto.randomUUID();
  const warehouseCode = String(1000 + Math.floor(Math.random() * 9000));

  return withTenantContext({ warehouseId }, async (client) => {
    const ownerResult = await client.query(
      `INSERT INTO owners (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email`,
      [name, email, passwordHash],
    );
    const owner = ownerResult.rows[0];

    const whResult = await client.query(
      `INSERT INTO warehouses (id, owner_id, name, city, warehouse_code)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, city, warehouse_code`,
      [warehouseId, owner.id, warehouseName, city || null, warehouseCode],
    );
    const warehouse = whResult.rows[0];

    const token = signToken({ role: 'owner', ownerId: owner.id, warehouseId: warehouse.id, ownerName: owner.name });
    return { token, owner, warehouse };
  });
}

async function loginOwner({ email, password }) {
  if (!email || !password) throw new HttpError(400, 'Введите email и пароль');

  return withoutTenantContext(async (client) => {
    const ownerResult = await client.query(
      `SELECT id, name, email, password_hash FROM owners WHERE email = $1`,
      [email],
    );
    const owner = ownerResult.rows[0];
    if (!owner) throw new HttpError(401, 'Неверный email или пароль');

    const ok = await bcrypt.compare(password, owner.password_hash);
    if (!ok) throw new HttpError(401, 'Неверный email или пароль');

    const whResult = await client.query(
      `SELECT * FROM find_owner_warehouse($1)`,
      [owner.id],
    );
    const warehouse = whResult.rows[0];
    if (!warehouse) throw new HttpError(404, 'У этого аккаунта пока нет склада');

    const token = signToken({ role: 'owner', ownerId: owner.id, warehouseId: warehouse.id, ownerName: owner.name });
    return { token, owner: { id: owner.id, name: owner.name, email: owner.email }, warehouse };
  });
}

async function loginStaffKey({ keyCode }) {
  if (!keyCode) throw new HttpError(400, 'Введите ключ доступа');
  const normalized = keyCode.trim().toUpperCase();

  return withoutTenantContext(async (client) => {
    // RLS-protected table, looked up before we know its warehouse scope —
    // see the comment on find_staff_key_for_login in the migration.
    const result = await client.query(
      `SELECT * FROM find_staff_key_for_login($1)`,
      [normalized],
    );
    const key = result.rows[0];
    if (!key) throw new HttpError(404, 'Такой ключ не найден. Проверьте у руководителя, всё ли верно скопировано.');
    if (!key.active) throw new HttpError(403, 'Этот ключ отозван. Обратитесь к руководителю склада.');

    const token = signToken({
      role: 'worker',
      warehouseId: key.warehouse_id,
      staffKeyId: key.id,
      name: key.name,
    });
    return { token, name: key.name, warehouseId: key.warehouse_id };
  });
}

async function loginSellerKey({ keyCode, name }) {
  if (!keyCode) throw new HttpError(400, 'Введите ключ доступа');
  if (!name) throw new HttpError(400, 'Введите имя');
  const normalized = keyCode.trim().toUpperCase();

  return withoutTenantContext(async (client) => {
    const result = await client.query(
      `SELECT * FROM find_seller_key_for_login($1)`,
      [normalized],
    );
    const key = result.rows[0];
    if (!key) throw new HttpError(404, 'Такой ключ не найден. Проверьте у склада, всё ли верно скопировано.');
    if (!key.active) throw new HttpError(403, 'Этот ключ отозван.');

    const token = signToken({
      role: 'seller',
      companyId: key.company_id,
      warehouseId: key.warehouse_id,
      sellerKeyId: key.id,
      name,
    });
    return { token, name, companyName: key.company_name };
  });
}

module.exports = {
  registerOwner,
  loginOwner,
  loginStaffKey,
  loginSellerKey,
  transliteratePrefix,
};
