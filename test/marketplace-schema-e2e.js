// Схема под маркетплейсы: проверяем не наличие таблиц, а обещания, ради
// которых они заведены.
//
// Главное обещание — один и тот же номер заказа из 1С и с площадки больше не
// конфликтует, но дубли внутри одного источника по-прежнему отсекаются. Плюс
// права: setup-app-role.sql новые таблицы не покрывает, и забытый GRANT
// выглядит как «permission denied» при первом же обращении.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/marketplace-schema-e2e.js

const assert = require('node:assert');
const { createApp } = require('../src/app');
const { withTenantContext } = require('../src/db/pool');

const PORT = 3988;
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

// Ошибку уникальности отличаем по коду Postgres, а не по тексту сообщения.
async function expectFails(run) {
  try {
    await run();
    return null;
  } catch (err) {
    return err.code || err.message;
  }
}

(async () => {
  const server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));

  try {
    const stamp = Date.now();
    const reg = await api('POST', '/api/auth/owner/register', {
      body: {
        name: 'MP Owner', email: `mp${stamp}@test.local`, password: 'secret123',
        warehouseName: 'MP WH', city: 'Moscow',
      },
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const ownerToken = reg.body.token;
    const warehouseId = whIdOf(ownerToken);

    const company = await api('POST', '/api/sellers/companies', {
      token: ownerToken, body: { name: 'Ромашка' },
    });
    const companyId = company.body.id;

    const run = (fn) => withTenantContext({ warehouseId }, (client) => fn(client));

    // ---------- Источник у внешнего номера ----------
    const inv = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId, number: `ЗАК-${stamp}`, direction: 'out',
        items: [{ name: 'Лимонад', sku: 'PB-MP', declaredQty: 3 }],
      },
    });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));

    check('созданные до маркетплейсов накладные считаются пришедшими из 1С', async () => {
      assert.ok(inv.body.id);
    });
    const sourceRow = await run((c) => c.query(
      'SELECT source FROM invoices WHERE id = $1', [inv.body.id],
    ));
    check('источник по умолчанию — 1С, старые строки не осиротели', () => {
      assert.equal(sourceRow.rows[0].source, '1c');
    });

    await run((c) => c.query(
      `UPDATE invoices SET external_id = 'ORDER-777' WHERE id = $1`, [inv.body.id],
    ));

    // Тот же номер, но с площадки — это ДРУГОЙ документ, и в этом весь смысл.
    const sameNumberOtherSource = await expectFails(() => run((c) => c.query(
      `INSERT INTO invoices (warehouse_id, company_id, number, direction, source, external_id)
       VALUES ($1, $2, $3, 'out', 'wb', 'ORDER-777')`,
      [warehouseId, companyId, `WB-${stamp}`],
    )));
    check('один номер из разных источников больше не конфликтует', () => {
      assert.equal(sameNumberOtherSource, null, `неожиданно отклонено: ${sameNumberOtherSource}`);
    });

    // А вот дубль внутри одного источника обязан отсекаться как раньше.
    const duplicateSameSource = await expectFails(() => run((c) => c.query(
      `INSERT INTO invoices (warehouse_id, company_id, number, direction, source, external_id)
       VALUES ($1, $2, $3, 'out', 'wb', 'ORDER-777')`,
      [warehouseId, companyId, `WB-DUP-${stamp}`],
    )));
    check('повторная выгрузка того же заказа с площадки не плодит дубль', () => {
      assert.equal(duplicateSameSource, '23505', `ожидалось нарушение уникальности, получено: ${duplicateSameSource}`);
    });

    // Обмен с 1С не должен видеть чужой заказ как свой: у него тот же номер,
    // но другой источник. Проверяем через настоящую ручку синхронизации.
    const key = await api('POST', '/api/sync/keys', { token: ownerToken, body: { label: 'Тест' } });
    const syncLogin = await api('POST', '/api/sync/auth', {
      body: { keyCode: key.body.key_code },
    });
    // Номер, который существует ТОЛЬКО у площадки. Обмен с 1С обязан создать
    // свой документ, а не подхватить чужой.
    await run((c) => c.query(
      `INSERT INTO invoices (warehouse_id, company_id, number, direction, source, external_id)
       VALUES ($1, $2, $3, 'out', 'wb', 'WB-ONLY-1')`,
      [warehouseId, companyId, `WB-ONLY-${stamp}`],
    ));

    const pushed = await api('POST', '/api/sync/push/invoices', {
      token: syncLogin.body.token,
      body: {
        defaultCompanyName: 'Ромашка',
        records: [{ externalId: 'WB-ONLY-1', number: 'ПРХ-ИЗ-1С', direction: 'in',
          items: [{ sku: 'PB-MP', name: 'Лимонад', declaredQty: 5 }] }],
      },
    });
    check('1С создаёт свой документ, а не перехватывает заказ площадки', () => {
      assert.equal(pushed.status, 200, JSON.stringify(pushed.body));
      const r = (pushed.body.results || [])[0];
      assert.ok(r, JSON.stringify(pushed.body));
      assert.equal(r.status, 'created', `ожидалось создание нового, получено: ${r.status}`);
    });

    const wbUntouched = await run((c) => c.query(
      `SELECT direction, number FROM invoices
       WHERE warehouse_id = $1 AND source = 'wb' AND external_id = 'WB-ONLY-1'`,
      [warehouseId],
    ));
    check('заказ площадки остался нетронутым', () => {
      assert.equal(wbUntouched.rows.length, 1);
      assert.equal(wbUntouched.rows[0].direction, 'out', 'направление подменили');
    });

    // ---------- Артикулы площадок ----------
    await run((c) => c.query(
      `INSERT INTO product_marketplace_skus (warehouse_id, company_id, sku, marketplace, mp_sku, mp_barcode)
       VALUES ($1, $2, 'PB-MP', 'wb', 'WB-12345', '2000000000015')`,
      [warehouseId, companyId],
    ));

    const sameOursTwoPlaces = await expectFails(() => run((c) => c.query(
      `INSERT INTO product_marketplace_skus (warehouse_id, company_id, sku, marketplace, mp_sku)
       VALUES ($1, $2, 'PB-MP', 'ozon', 'OZ-98765')`,
      [warehouseId, companyId],
    )));
    check('один наш товар продаётся на нескольких площадках под разными артикулами', () => {
      assert.equal(sameOursTwoPlaces, null, `неожиданно отклонено: ${sameOursTwoPlaces}`);
    });

    const twoOursOneMpSku = await expectFails(() => run((c) => c.query(
      `INSERT INTO product_marketplace_skus (warehouse_id, company_id, sku, marketplace, mp_sku)
       VALUES ($1, $2, 'PB-OTHER', 'wb', 'WB-12345')`,
      [warehouseId, companyId],
    )));
    check('артикул площадки ведёт ровно к одному нашему товару', () => {
      assert.equal(twoOursOneMpSku, '23505', `ожидалось нарушение уникальности, получено: ${twoOursOneMpSku}`);
    });

    const mapped = await run((c) => c.query(
      `SELECT marketplace, mp_sku FROM product_marketplace_skus
       WHERE warehouse_id = $1 AND sku = 'PB-MP' ORDER BY marketplace`,
      [warehouseId],
    ));
    check('по нашему артикулу видно, где он продаётся', () => {
      assert.deepEqual(mapped.rows.map((r) => r.marketplace), ['ozon', 'wb']);
    });

    // ---------- Ключи ----------
    await run((c) => c.query(
      `INSERT INTO marketplace_credentials (warehouse_id, company_id, marketplace, encrypted_payload)
       VALUES ($1, $2, 'wb', 'ciphertext-placeholder')`,
      [warehouseId, companyId],
    ));
    const cred = await run((c) => c.query(
      `SELECT write_enabled FROM marketplace_credentials WHERE company_id = $1`, [companyId],
    ));
    check('запись на площадку по умолчанию выключена', () => {
      assert.equal(cred.rows[0].write_enabled, false);
    });

    const twoKeysSamePair = await expectFails(() => run((c) => c.query(
      `INSERT INTO marketplace_credentials (warehouse_id, company_id, marketplace, encrypted_payload)
       VALUES ($1, $2, 'wb', 'second-key')`,
      [warehouseId, companyId],
    )));
    check('два ключа на одну пару «продавец + площадка» не заводятся', () => {
      assert.equal(twoKeysSamePair, '23505', `получено: ${twoKeysSamePair}`);
    });

    // ---------- Резервы ----------
    const item = await run((c) => c.query(
      `SELECT id FROM invoice_items WHERE invoice_id = $1`, [inv.body.id],
    ));
    await run((c) => c.query(
      `INSERT INTO stock_reservations (warehouse_id, company_id, sku, qty, invoice_item_id)
       VALUES ($1, $2, 'PB-MP', 3, $3)`,
      [warehouseId, companyId, item.rows[0].id],
    ));

    const active = await run((c) => c.query(
      `SELECT COALESCE(SUM(qty), 0)::int AS qty FROM stock_reservations
       WHERE warehouse_id = $1 AND sku = 'PB-MP' AND released_at IS NULL`,
      [warehouseId],
    ));
    check('активный резерв считается', () => {
      assert.equal(active.rows[0].qty, 3);
    });

    await run((c) => c.query(
      `UPDATE stock_reservations SET released_at = now() WHERE warehouse_id = $1`, [warehouseId],
    ));
    const afterRelease = await run((c) => c.query(
      `SELECT COALESCE(SUM(qty), 0)::int AS qty, COUNT(*)::int AS rows FROM stock_reservations
       WHERE warehouse_id = $1 AND released_at IS NULL`,
      [warehouseId],
    ));
    check('снятый резерв перестаёт занимать товар, но остаётся в истории', () => {
      assert.equal(afterRelease.rows[0].qty, 0);
      assert.equal(afterRelease.rows[0].rows, 0, 'активных резервов быть не должно');
    });
    const kept = await run((c) => c.query(
      `SELECT COUNT(*)::int AS n FROM stock_reservations WHERE warehouse_id = $1`, [warehouseId],
    ));
    check('строка резерва не удаляется — вопрос «почему вчера было недоступно» задают', () => {
      assert.equal(kept.rows[0].n, 1);
    });

    // ---------- Чужой склад ----------
    const other = await api('POST', '/api/auth/owner/register', {
      body: {
        name: 'Other', email: `mp-other${stamp}@test.local`, password: 'secret123',
        warehouseName: 'Other WH', city: 'Kazan',
      },
    });
    assert.equal(other.status, 201, `второй владелец не завёлся: ${JSON.stringify(other.body)}`);
    const otherWh = whIdOf(other.body.token);
    const otherSees = await withTenantContext({ warehouseId: otherWh }, (c) => c.query(
      `SELECT
         (SELECT COUNT(*)::int FROM product_marketplace_skus) AS skus,
         (SELECT COUNT(*)::int FROM marketplace_credentials) AS creds,
         (SELECT COUNT(*)::int FROM stock_reservations) AS reservations`,
    ));
    check('чужой склад не видит ни артикулов, ни ключей, ни резервов', () => {
      const r = otherSees.rows[0];
      assert.equal(r.skus, 0, JSON.stringify(r));
      assert.equal(r.creds, 0, JSON.stringify(r));
      assert.equal(r.reservations, 0, JSON.stringify(r));
    });
  } catch (err) {
    failures.push({ name: 'SETUP', message: err.message });
    console.log(`\n  SETUP ERROR: ${err.message}`);
  } finally {
    server.close();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f.name}: ${f.message}`);
  }
  process.exit(failures.length ? 1 : 0);
})();
