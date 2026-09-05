// Двери, в которые стучат снаружи: регистрация и три входа.
//
// Здесь проверяется не «работает ли вход», а четыре найденных при разборе
// дефекта: код склада мог столкнуться и уронить регистрацию; почта с большой
// буквы не пускала обратно; пароль и короткий ключ можно было перебирать без
// счёта; таблица владельцев читалась без всякой изоляции.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/auth-hardening-e2e.js

const assert = require('node:assert');
const { createApp } = require('../src/app');
const { withoutTenantContext } = require('../src/db/pool');

// Заглянуть в саму таблицу владельцев приложение больше не может — в этом и
// смысл. Для проверки содержимого нужна админская строка подключения; без неё
// такие проверки честно пропускаются.
const ADMIN_URL = process.env.ADMIN_DATABASE_URL || null;
async function adminQuery(sql, params) {
  if (!ADMIN_URL) return null;
  const { Client } = require('pg');
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}

const PORT = 3982;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

async function api(method, path, { body, ip } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      // Разные адреса, чтобы счётчик попыток одного теста не мешал другому.
      ...(ip ? { 'X-Forwarded-For': ip } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

(async () => {
  const server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));

  try {
    const stamp = Date.now();

    // ---------- Почта не зависит от регистра ----------
    const mixed = `Ivan.Petrov${stamp}@Mail.RU`;
    const reg = await api('POST', '/api/auth/owner/register', {
      ip: '198.51.100.1',
      body: {
        name: 'Иван', email: mixed, password: 'secret123',
        warehouseName: 'Склад Ивана', city: 'Москва',
      },
    });
    check('регистрация проходит', () => {
      assert.equal(reg.status, 201, JSON.stringify(reg.body));
    });

    const stored = await adminQuery(
      'SELECT email FROM owners WHERE lower(email) = $1', [mixed.toLowerCase()],
    );
    if (!stored) {
      console.log('  SKIP  вид сохранённой почты: не задан ADMIN_DATABASE_URL');
    } else {
      check('почта сохраняется приведённой к нижнему регистру', () => {
        assert.equal(stored.rows[0].email, mixed.toLowerCase());
      });
    }

    const loginLower = await api('POST', '/api/auth/owner/login', {
      ip: '198.51.100.2', body: { email: mixed.toLowerCase(), password: 'secret123' },
    });
    check('войти можно строчными буквами', () => {
      assert.equal(loginLower.status, 200, JSON.stringify(loginLower.body));
    });
    const loginMixed = await api('POST', '/api/auth/owner/login', {
      ip: '198.51.100.3', body: { email: `  ${mixed.toUpperCase()}  `, password: 'secret123' },
    });
    check('и как ввели при регистрации, с пробелами по краям', () => {
      assert.equal(loginMixed.status, 200, JSON.stringify(loginMixed.body));
    });

    const dupe = await api('POST', '/api/auth/owner/register', {
      ip: '198.51.100.4',
      body: {
        name: 'Двойник', email: mixed.toUpperCase(), password: 'secret123',
        warehouseName: 'Второй склад',
      },
    });
    check('второй кабинет на ту же почту в другом регистре не завести', () => {
      assert.equal(dupe.status, 409, JSON.stringify(dupe.body));
      assert.ok(String(dupe.body.error).includes('почт'), dupe.body.error);
    });

    // ---------- Перебор пароля ----------
    const attempts = [];
    for (let i = 0; i < 13; i += 1) {
      attempts.push((await api('POST', '/api/auth/owner/login', {
        ip: '198.51.100.50',
        body: { email: mixed.toLowerCase(), password: 'wrong' + i },
      })).status);
    }
    check('пароль нельзя перебирать без счёта', () => {
      const blocked = attempts.filter((s) => s === 429).length;
      assert.ok(blocked >= 2, `после десяти попыток должно начать блокировать: ${attempts.join(',')}`);
    });
    check('и до счётчика ответ не подсказывает, что не так', () => {
      // 401 без различия «нет такой почты» / «неверный пароль»: иначе перебор
      // сначала находит живые адреса, а потом уже пароли.
      assert.equal(attempts[0], 401, JSON.stringify(attempts));
    });
    const other = await api('POST', '/api/auth/owner/login', {
      ip: '198.51.100.51', body: { email: mixed.toLowerCase(), password: 'secret123' },
    });
    check('и это не мешает войти с другого адреса', () => {
      assert.equal(other.status, 200, JSON.stringify(other.body));
    });

    // ---------- Перебор короткого ключа ----------
    const keyTries = [];
    for (let i = 0; i < 18; i += 1) {
      keyTries.push((await api('POST', '/api/auth/staff/login', {
        ip: '198.51.100.70', body: { keyCode: `0000-${String(i).padStart(2, '0')}` },
      })).status);
    }
    check('короткий ключ работника тоже не подобрать перебором', () => {
      assert.ok(keyTries.includes(429), `не сработало ограничение: ${keyTries.join(',')}`);
    });

    // ---------- Таблица владельцев ----------
    const owners = await withoutTenantContext(async (c) => {
      try {
        const r = await c.query('SELECT count(*)::int AS n FROM owners');
        return { ok: true, n: r.rows[0].n };
      } catch (e) { return { ok: false, code: e.code }; }
    });
    check('приложение не может прочитать чужие учётки владельцев', () => {
      assert.equal(owners.ok, false,
        `SELECT по owners прошёл и вернул ${owners.n} строк — там лежат хеши паролей`);
    });

    const stillLogsIn = await api('POST', '/api/auth/owner/login', {
      ip: '198.51.100.90', body: { email: mixed.toLowerCase(), password: 'secret123' },
    });
    check('но вход при этом продолжает работать', () => {
      assert.equal(stillLogsIn.status, 200, JSON.stringify(stillLogsIn.body));
    });
  } finally {
    server.close();
  }

  console.log(`\n${passed} прошло, ${failures.length} упало`);
  for (const f of failures) console.log(`  ${f.name}: ${f.message}`);
  process.exit(failures.length ? 1 : 0);
})();
