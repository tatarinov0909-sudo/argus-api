// Интеграция с Wildberries — только чтение.
//
// Проверяем три вещи, каждая из которых стоит дорого при ошибке:
//   1. ключ продавца не лежит и не отдаётся открытым;
//   2. заказ площадки превращается в накладную ровно один раз, сколько бы
//      проходов ни случилось;
//   3. модуль площадки физически не умеет ничего менять на стороне WB —
//      владелец это запретил, и запрет должен держаться структурой, а не
//      обещанием.
// Настоящий API здесь не дёргается: ответ площадки подставляется.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test MARKETPLACE_KEY_SECRET=test-secret node test/marketplace-wb-e2e.js

process.env.MARKETPLACE_KEY_SECRET = process.env.MARKETPLACE_KEY_SECRET || 'test-secret-phrase';

const assert = require('node:assert');
const { createApp } = require('../src/app');
const { withTenantContext } = require('../src/db/pool');
const wb = require('../src/marketplaces/wb');
const sync = require('../src/marketplaces/sync');
const cryptoBox = require('../src/marketplaces/crypto');

const PORT = 3986;
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

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

const whIdOf = (token) => JSON.parse(
  Buffer.from(token.split('.')[1], 'base64').toString('utf8'),
).warehouseId;

const FAKE_TOKEN = 'eyJhbGciOiJFUzI1NiJ9.fake-token-for-tests.signature';

(async () => {
  const server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));

  // Подменяем только сеть. Разбор ответа, сопоставление и запись в базу —
  // настоящие: именно там живут ошибки, ради которых пишется тест.
  const realSellerInfo = wb.sellerInfo;
  const realNewOrders = wb.newOrders;
  wb.sellerInfo = async () => ({
    name: 'ООО «Тест»', inn: '1234567890', tradeMark: 'Test', sellerId: 'sid-1',
  });

  try {
    // ---------- Шифрование ----------
    const round = cryptoBox.decrypt(cryptoBox.encrypt('секретный-ключ'));
    check('шифртекст расшифровывается обратно', () => {
      assert.equal(round, 'секретный-ключ');
    });
    check('дважды зашифрованное одно и то же выглядит по-разному', () => {
      assert.notEqual(cryptoBox.encrypt('одно и то же'), cryptoBox.encrypt('одно и то же'));
    });
    check('подменённый шифртекст не расшифровывается, а падает', () => {
      const enc = cryptoBox.encrypt('ключ');
      const parts = enc.split(':');
      parts[3] = Buffer.from('подмена').toString('base64');
      assert.throws(() => cryptoBox.decrypt(parts.join(':')));
    });
    check('чужим ключом не открывается', () => {
      const enc = cryptoBox.encrypt('ключ');
      const was = process.env.MARKETPLACE_KEY_SECRET;
      process.env.MARKETPLACE_KEY_SECRET = 'другая-фраза';
      try {
        assert.throws(() => cryptoBox.decrypt(enc));
      } finally {
        process.env.MARKETPLACE_KEY_SECRET = was;
      }
    });

    // ---------- Модуль площадки не умеет писать ----------
    check('в модуле Wildberries нет ни одного метода записи', () => {
      const forbidden = ['confirm', 'cancel', 'setStatus', 'updateStocks', 'putStocks',
        'createSupply', 'deliver', 'sticker', 'updateCard'];
      const present = forbidden.filter((n) => typeof wb[n] === 'function');
      assert.deepEqual(present, [], `появились методы записи: ${present.join(', ')}`);
    });
    check('и в исходнике нет ни PUT, ни POST, ни PATCH, ни DELETE', () => {
      const src = require('fs').readFileSync(require.resolve('../src/marketplaces/wb.js'), 'utf8');
      const calls = src.match(/method:\s*'(PUT|POST|PATCH|DELETE)'/g) || [];
      assert.deepEqual(calls, [], `найдены изменяющие вызовы: ${calls.join(', ')}`);
    });

    // ---------- Подготовка склада ----------
    const stamp = Date.now();
    const reg = await api('POST', '/api/auth/owner/register', {
      body: {
        name: 'MP Owner', email: `mpwb${stamp}@test.local`, password: 'secret123',
        warehouseName: 'MP WB WH', city: 'Moscow',
      },
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const ownerToken = reg.body.token;
    const warehouseId = whIdOf(ownerToken);

    const company = await api('POST', '/api/sellers/companies', {
      token: ownerToken, body: { name: 'Слим Тим' },
    });
    const companyId = company.body.id;

    const staff = await api('POST', '/api/staff', { token: ownerToken, body: { name: 'Работник' } });
    const workerToken = (await api('POST', '/api/auth/staff/login', {
      body: { keyCode: staff.body.key_code },
    })).body.token;

    const run = (fn) => withTenantContext({ warehouseId }, (client) => fn(client));

    // ---------- Работника к площадкам не пускают ----------
    const workerList = await api('GET', '/api/marketplaces', { token: workerToken });
    const workerSync = await api('POST', '/api/marketplaces/sync', { token: workerToken, body: {} });
    check('работник не видит подключённые площадки', () => {
      assert.equal(workerList.status, 403, JSON.stringify(workerList.body));
    });
    check('работник не может запустить обмен с площадкой', () => {
      assert.equal(workerSync.status, 403, JSON.stringify(workerSync.body));
    });

    // ---------- Подключение ключа ----------
    const connected = await api('POST', '/api/marketplaces/credentials', {
      token: ownerToken, body: { companyId, marketplace: 'wb', token: FAKE_TOKEN },
    });
    check('ключ подключается и проверяется обращением к площадке', () => {
      assert.equal(connected.status, 201, JSON.stringify(connected.body));
      assert.equal(connected.body.seller.name, 'ООО «Тест»');
    });
    check('в ответе только маска ключа, не сам ключ', () => {
      assert.ok(!JSON.stringify(connected.body).includes(FAKE_TOKEN), 'ключ вернулся открытым');
      assert.ok(connected.body.tokenMask.includes('…'));
    });
    check('запись на площадку выключена по умолчанию', () => {
      assert.equal(connected.body.write_enabled, false);
    });

    const stored = await run((c) => c.query(
      `SELECT encrypted_payload FROM marketplace_credentials WHERE company_id = $1`, [companyId],
    ));
    check('в базе ключа открытым текстом нет', () => {
      assert.ok(!stored.rows[0].encrypted_payload.includes(FAKE_TOKEN), 'ключ лежит открытым');
      assert.ok(stored.rows[0].encrypted_payload.startsWith('v1:'));
    });

    const listed = await api('GET', '/api/marketplaces', { token: ownerToken });
    check('список подключений ключ не показывает', () => {
      assert.equal(listed.status, 200);
      assert.ok(!JSON.stringify(listed.body).includes(FAKE_TOKEN));
      assert.equal(listed.body[0].marketplace, 'wb');
    });

    // ---------- Сопоставление артикулов ----------
    await run((c) => c.query(
      `INSERT INTO product_marketplace_skus
         (warehouse_id, company_id, sku, marketplace, mp_sku, mp_article, mp_barcode)
       VALUES ($1, $2, 'PB-A', 'wb', '111', 'ART-A', '2000000000015'),
              ($1, $2, 'PB-B', 'wb', '222', 'ART-B', '2000000000022'),
              ($1, $2, 'PB-C', 'wb', '333', NULL, '2000000000039')`,
      [warehouseId, companyId],
    ));
    await run((c) => c.query(
      `INSERT INTO products (warehouse_id, company_id, sku, name)
       VALUES ($1, $2, 'PB-A', 'Печенье овсяное'), ($1, $2, 'PB-B', 'Мармелад')`,
      [warehouseId, companyId],
    ));

    const resolve = await run((c) => sync.loadMapping(c, warehouseId, companyId, 'wb'));
    check('номер карточки важнее артикула', () => {
      // Если площадка прислала оба и они указывают на разное — верим номеру.
      assert.equal(resolve({ nmId: '111', article: 'ART-B', barcodes: [] }), 'PB-A');
    });
    check('артикул срабатывает, когда номера карточки нет в матрице', () => {
      assert.equal(resolve({ nmId: '999', article: 'ART-B', barcodes: [] }), 'PB-B');
    });
    check('штрихкод — последний путь к товару', () => {
      assert.equal(resolve({ nmId: '999', article: 'НЕТ', barcodes: ['2000000000039'] }), 'PB-C');
    });
    check('незнакомый товар остаётся неопознанным, а не подставляется наугад', () => {
      assert.equal(resolve({ nmId: '999', article: 'НЕТ', barcodes: ['777'] }), null);
    });

    // ---------- Заказы превращаются в накладные ----------
    wb.newOrders = async () => ([
      {
        externalId: '5000000001', article: 'ART-A', nmId: '111',
        barcodes: ['2000000000015'], salePriceKopecks: 115000,
        createdAt: '2026-09-04T11:30:21Z', warehouseId: '1419734',
        deliveryType: 'fbs', requiredMeta: [],
      },
      {
        externalId: '5000000002', article: 'ART-НЕТУ', nmId: '888',
        barcodes: ['999'], salePriceKopecks: 90000,
        createdAt: '2026-09-04T11:31:00Z', warehouseId: '1419734',
        deliveryType: 'fbs', requiredMeta: [],
      },
    ]);

    const first = await api('POST', '/api/marketplaces/sync', {
      token: ownerToken, body: { companyId },
    });
    check('первый проход заводит накладные по заданиям площадки', () => {
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.seen, 2);
      assert.equal(first.body.created, 2);
    });
    check('несопоставленное задание названо поимённо', () => {
      assert.equal(first.body.unmapped.length, 1);
      assert.equal(first.body.unmapped[0].article, 'ART-НЕТУ');
    });

    const invoices = await run((c) => c.query(
      `SELECT i.number, i.source, i.direction, i.external_id, ii.sku, ii.name, ii.declared_qty
       FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
       WHERE i.warehouse_id = $1 AND i.source = 'wb' ORDER BY i.external_id`,
      [warehouseId],
    ));
    check('накладная помечена источником «wb», а не выдаёт себя за 1С', () => {
      assert.equal(invoices.rows.length, 2);
      assert.ok(invoices.rows.every((r) => r.source === 'wb' && r.direction === 'out'));
    });
    check('сопоставленная строка получила наш код и наше название', () => {
      const row = invoices.rows.find((r) => r.external_id === '5000000001');
      assert.equal(row.sku, 'PB-A');
      assert.equal(row.name, 'Печенье овсяное');
      assert.equal(Number(row.declared_qty), 1);
    });
    check('несопоставленная строка не притворяется опознанной', () => {
      const row = invoices.rows.find((r) => r.external_id === '5000000002');
      assert.ok(row.name.startsWith('Не сопоставлен'), row.name);
      assert.equal(row.sku, 'ART-НЕТУ');
    });

    // ---------- Повторный проход ----------
    const second = await api('POST', '/api/marketplaces/sync', {
      token: ownerToken, body: { companyId },
    });
    check('повторный проход не плодит дубли', () => {
      assert.equal(second.body.created, 0, JSON.stringify(second.body));
      assert.equal(second.body.existed, 2);
    });
    const count = await run((c) => c.query(
      `SELECT COUNT(*)::int AS n FROM invoices WHERE warehouse_id = $1 AND source = 'wb'`,
      [warehouseId],
    ));
    check('накладных по-прежнему две', () => {
      assert.equal(count.rows[0].n, 2);
    });

    // ---------- Заказ из 1С с тем же номером ----------
    const key = await api('POST', '/api/sync/keys', { token: ownerToken, body: { label: 'Тест' } });
    const syncLogin = await api('POST', '/api/sync/auth', { body: { keyCode: key.body.key_code } });
    const pushed = await api('POST', '/api/sync/push/invoices', {
      token: syncLogin.body.token,
      body: {
        defaultCompanyName: 'Слим Тим',
        records: [{
          externalId: '5000000001', number: 'ПРХ-ИЗ-1С', direction: 'in',
          items: [{ sku: 'PB-A', name: 'Печенье овсяное', declaredQty: 5 }],
        }],
      },
    });
    check('1С не перехватывает заказ площадки с тем же номером', () => {
      assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
      assert.equal((pushed.body.results || [])[0].status, 'created');
    });
    const wbUntouched = await run((c) => c.query(
      `SELECT direction FROM invoices
       WHERE warehouse_id = $1 AND source = 'wb' AND external_id = '5000000001'`,
      [warehouseId],
    ));
    check('заказ площадки остался заказом на отгрузку', () => {
      assert.equal(wbUntouched.rows[0].direction, 'out');
    });

    // ---------- Отметка живости ----------
    const used = await run((c) => c.query(
      `SELECT last_used_at FROM marketplace_credentials WHERE company_id = $1`, [companyId],
    ));
    check('после обмена отмечено, что ключ сработал', () => {
      assert.ok(used.rows[0].last_used_at, 'молчание интеграции будет не отличить от затишья');
    });

    // ---------- Отключение ----------
    const removed = await api('DELETE', `/api/marketplaces/${companyId}/wb`, { token: ownerToken });
    check('ключ отключается', () => {
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
    });
    const afterRemove = await api('POST', '/api/marketplaces/sync', {
      token: ownerToken, body: { companyId },
    });
    check('без ключа обмен честно отказывается, а не делает вид', () => {
      assert.equal(afterRemove.status, 404, JSON.stringify(afterRemove.body));
    });
  } finally {
    wb.sellerInfo = realSellerInfo;
    wb.newOrders = realNewOrders;
    server.close();
  }

  console.log(`\n${passed} прошло, ${failures.length} упало`);
  for (const f of failures) console.log(`  ${f.name}: ${f.message}`);
  process.exit(failures.length ? 1 : 0);
})();
