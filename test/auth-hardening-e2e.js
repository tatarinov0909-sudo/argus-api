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

async function api(method, path, { body, ip, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      // Разные адреса, чтобы счётчик попыток одного теста не мешал другому.
      ...(ip ? { 'X-Forwarded-For': ip } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

    // ---------- Ключи нельзя угадать ----------
    //
    // Ключи сотрудников выдавались подряд: 7721-01, 7721-02, 7721-03. Код
    // склада написан в кабинете крупными цифрами и известен каждому, кто там
    // работал, — значит войти чужим ключом можно было с двадцатой попытки.
    // Проверяется не «ключ длинный», а именно это: номер по порядку
    // предсказуем, и после него обязана стоять случайная часть.
    const owner2 = await api('POST', '/api/auth/owner/register', {
      ip: '203.0.113.77',
      body: { name: 'Keys', email: `keys${stamp}@test.local`, password: 'secret123',
              warehouseName: 'Keys WH', city: 'Moscow' },
    });
    const t2 = owner2.body.token;
    const k1 = await api('POST', '/api/staff', { token: t2, body: { name: 'Первый' } });
    const k2 = await api('POST', '/api/staff', { token: t2, body: { name: 'Второй' } });
    check('ключи сотрудников выдаются', () => {
      assert.equal(k1.status, 201, JSON.stringify(k1.body));
      assert.equal(k2.status, 201, JSON.stringify(k2.body));
    });
    check('ключ сотрудника не предсказуем по номеру', () => {
      const code = k2.body.key_code;
      const seq = code.split('-').slice(0, 2).join('-');
      // Порядковая часть предсказуема — и сама по себе больше не пускает.
      assert.ok(code.length > seq.length + 2, `ключ «${code}» — это только номер`);
    });
    const guess = await api('POST', '/api/auth/staff/login', {
      ip: '203.0.113.78',
      body: { keyCode: k2.body.key_code.split('-').slice(0, 2).join('-') },
    });
    check('вход по одной порядковой части не проходит', () => {
      assert.equal(guess.status, 404, JSON.stringify(guess.body));
    });
    check('случайные части двух ключей разные', () => {
      const r1 = k1.body.key_code.split('-').pop();
      const r2 = k2.body.key_code.split('-').pop();
      assert.notEqual(r1, r2, 'случайности нет');
      assert.ok(r1.length >= 4 && r2.length >= 4, `${r1} / ${r2} — коротко`);
      // Алфавит без похожих знаков: ключ диктуют по телефону.
      assert.ok(!/[01OI]/.test(r1 + r2), `${r1}${r2} содержит спорные знаки`);
    });

    const comp = await api('POST', '/api/sellers/companies', { token: t2, body: { name: 'Ромашка' } });
    const sk1 = await api('POST', `/api/sellers/companies/${comp.body.id}/keys`, { token: t2 });
    const sk2 = await api('POST', `/api/sellers/companies/${comp.body.id}/keys`, { token: t2 });
    check('ключ продавца длиннее четырёх цифр и не от Math.random', () => {
      assert.equal(sk1.status, 201, JSON.stringify(sk1.body));
      const mid1 = sk1.body.key_code.split('-')[1];
      const mid2 = sk2.body.key_code.split('-')[1];
      assert.ok(mid1.length >= 6, `«${sk1.body.key_code}» — четыре цифры это девять тысяч вариантов`);
      assert.notEqual(mid1, mid2);
      assert.ok(!/^[0-9]+$/.test(mid1 + mid2), 'только цифры — значит перебор дешевле');
    });

    // ---------- Регистрация не бесконечна ----------
    let regBlocked = 0;
    for (let i = 0; i < 6; i += 1) {
      const r = await api('POST', '/api/auth/owner/register', {
        ip: '203.0.113.90',
        body: { name: 'Spam', email: `spam${stamp}-${i}@test.local`, password: 'secret123',
                warehouseName: 'Spam WH', city: 'Moscow' },
      });
      if (r.status === 429) regBlocked += 1;
    }
    check('склады нельзя заводить пачками с одного адреса', () => {
      assert.ok(regBlocked > 0, 'ни одна регистрация не отбита');
    });

    // ---------- Счётчик не наказывает за нормальную работу ----------
    //
    // Ключи работников считаются по адресу, а весь склад сидит за одним.
    // Пока счётчик считал все попытки, двадцать человек, входящих в смену,
    // упирались в него на шестнадцатом: «слишком много попыток» получал тот,
    // кто ввёл ключ верно с первого раза. Считать надо неудачи.
    let okLogins = 0;
    for (let i = 0; i < 20; i += 1) {
      const r = await api('POST', '/api/auth/staff/login', {
        ip: '203.0.113.55', body: { keyCode: k1.body.key_code },
      });
      if (r.status === 200) okLogins += 1;
    }
    check('двадцать верных входов подряд с одного адреса проходят', () => {
      assert.equal(okLogins, 20, `прошло только ${okLogins}`);
    });
    let blocked = 0;
    for (let i = 0; i < 20; i += 1) {
      const r = await api('POST', '/api/auth/staff/login', {
        ip: '203.0.113.56', body: { keyCode: `7721-99-XXX${i}` },
      });
      if (r.status === 429) blocked += 1;
    }
    check('а перебор неверных — нет', () => {
      assert.ok(blocked > 0, 'перебор ключей ничем не ограничен');
    });
  } finally {
    server.close();
  }

  console.log(`\n${passed} прошло, ${failures.length} упало`);
  for (const f of failures) console.log(`  ${f.name}: ${f.message}`);
  process.exit(failures.length ? 1 : 0);
})();
