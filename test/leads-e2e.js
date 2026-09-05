// Заявка с лендинга — единственная ручка, куда пишет кто угодно из интернета.
//
// Проверяем не «сохранилось ли», а то, ради чего проверки вообще писались:
// заявка без обратной связи не принимается молча, длинные поля не валят базу,
// и один скрипт не может лить заявки всю ночь.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/leads-e2e.js

const assert = require('node:assert');
const { createApp } = require('../src/app');
const { withoutTenantContext } = require('../src/db/pool');

// Приложению выдан только INSERT — читать заявки через него нельзя, и это
// часть проверяемого. Поэтому содержимое таблицы смотрим админской строкой
// подключения; без неё такие проверки честно пропускаются.
const ADMIN_URL = process.env.ADMIN_DATABASE_URL || null;
async function adminQuery(sql, params) {
  if (!ADMIN_URL) return null;
  const { Client } = require('pg');
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}

const PORT = 3985;
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

async function post(body, ip) {
  const res = await fetch(BASE + '/api/leads', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Тот же адрес, что видел бы nginx: приложение доверяет одному хопу.
      ...(ip ? { 'X-Forwarded-For': ip } : {}),
    },
    body: JSON.stringify(body),
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
    const contact = `lead${stamp}@test.local`;

    const ok = await post({
      name: 'Пётр', contact, message: 'Хочу посмотреть на складе',
      companySize: '3 продавца',
    }, '203.0.113.10');
    check('заявка принимается', () => {
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
    });

    const row = await adminQuery(
      `SELECT name, contact, message, payload, source FROM leads WHERE contact = $1`, [contact],
    );
    if (!row) {
      console.log('  SKIP  содержимое заявок: не задан ADMIN_DATABASE_URL');
    } else {
      check('и доходит до базы целиком', () => {
        assert.equal(row.rows.length, 1, 'заявка не сохранилась');
        assert.equal(row.rows[0].name, 'Пётр');
        assert.equal(row.rows[0].message, 'Хочу посмотреть на складе');
        assert.equal(row.rows[0].source, 'landing');
      });
      check('поля формы, которых нет в схеме, не теряются', () => {
        assert.equal(row.rows[0].payload.companySize, '3 продавца',
          'лишнее поле выброшено — форма меняется чаще схемы');
      });
    }

    // Заявка без обратной связи бесполезна: принять её значит пообещать ответ,
    // которого не будет.
    const noContact = await post({ name: 'Аноним', message: 'позвоните мне' }, '203.0.113.11');
    check('без телефона и почты заявка не принимается', () => {
      assert.equal(noContact.status, 400, JSON.stringify(noContact.body));
    });

    // Почта и телефон могут прийти под разными именами — форма на лендинге
    // меняется, и ронять из-за этого заявку нельзя.
    const byEmail = await post({ email: `alt${stamp}@test.local` }, '203.0.113.12');
    check('почта в поле email тоже считается контактом', () => {
      assert.equal(byEmail.status, 201, JSON.stringify(byEmail.body));
    });

    // Длинное поле не должно ни падать, ни уходить в базу целиком.
    const huge = await post({
      contact: `big${stamp}@test.local`,
      message: 'я'.repeat(50000),
    }, '203.0.113.13');
    const hugeRow = await adminQuery(
      `SELECT length(message) AS len FROM leads WHERE contact = $1`, [`big${stamp}@test.local`],
    );
    check('простыня текста ручку не роняет', () => {
      assert.equal(huge.status, 201, JSON.stringify(huge.body));
    });
    if (hugeRow) {
      check('и в базу уходит обрезанной', () => {
        assert.ok(Number(hugeRow.rows[0].len) <= 4000, `сохранено ${hugeRow.rows[0].len} символов`);
      });
    }

    // Пять заявок в час с одного адреса — потолок.
    const flooder = '203.0.113.99';
    const results = [];
    for (let i = 0; i < 7; i += 1) {
      results.push((await post({ contact: `flood${stamp}-${i}@test.local` }, flooder)).status);
    }
    check('один адрес не может лить заявки без конца', () => {
      assert.equal(results.filter((s) => s === 201).length, 5, JSON.stringify(results));
      assert.equal(results.filter((s) => s === 429).length, 2, JSON.stringify(results));
    });
    const other = await post({ contact: `other${stamp}@test.local` }, '203.0.113.50');
    check('и при этом не мешает остальным', () => {
      assert.equal(other.status, 201, 'ограничение задело чужой адрес');
    });

    // Читать заявки через приложение нельзя: ручки нет и права не выданы.
    const read = await withoutTenantContext(async (c) => {
      try {
        await c.query('SELECT * FROM leads LIMIT 1');
        return 'разрешено';
      } catch (e) { return e.code; }
    });
    check('приложение может заявки принимать, но не читать', () => {
      assert.equal(read, '42501', `ожидался отказ в правах, получено: ${read}`);
    });
  } finally {
    server.close();
  }

  console.log(`\n${passed} прошло, ${failures.length} упало`);
  for (const f of failures) console.log(`  ${f.name}: ${f.message}`);
  process.exit(failures.length ? 1 : 0);
})();
