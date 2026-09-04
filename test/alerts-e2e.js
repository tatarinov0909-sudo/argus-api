// Кладовщик, который говорит первым.
//
// Проверяем не столько тексты, сколько поведение, из-за которого такие вещи
// обычно выключают через неделю: не дублируется ли, закрывается ли сама, не
// кричит ли раньше времени, не видит ли чужой склад.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/alerts-e2e.js

const assert = require('node:assert');
const { createApp } = require('../src/app');
const { withTenantContext } = require('../src/db/pool');
const runner = require('../src/alerts/runner');

const PORT = 3990;
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

// Состарить запись журнала рабочей ролью нельзя: UPDATE на journal_entries
// отозван на уровне грантов, и это правильно — журнал append-only. Для теста
// нужна админская строка подключения; без неё зависящие от времени проверки
// честно пропускаются, а не притворяются пройденными.
const ADMIN_URL = process.env.ADMIN_DATABASE_URL || null;
async function ageRows(sql, params) {
  if (!ADMIN_URL) return false;
  const { Client } = require('pg');
  const c = new Client({ connectionString: ADMIN_URL });
  await c.connect();
  try { await c.query(sql, params); } finally { await c.end(); }
  return true;
}

const whIdOf = (token) => JSON.parse(
  Buffer.from(token.split('.')[1], 'base64').toString('utf8'),
).warehouseId;

(async () => {
  const server = createApp().listen(PORT);
  await new Promise((r) => server.once('listening', r));

  try {
    const stamp = Date.now();
    const reg = await api('POST', '/api/auth/owner/register', {
      body: {
        name: 'Alert Owner', email: `alert${stamp}@test.local`, password: 'secret123',
        warehouseName: 'Alert WH', city: 'Moscow',
      },
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const ownerToken = reg.body.token;
    const warehouseId = whIdOf(ownerToken);

    const company = await api('POST', '/api/sellers/companies', { token: ownerToken, body: { name: 'Ромашка' } });
    const staff = await api('POST', '/api/staff', { token: ownerToken, body: { name: 'Работник' } });
    const workerToken = (await api('POST', '/api/auth/staff/login', {
      body: { keyCode: staff.body.key_code },
    })).body.token;
    // Пять рядов по пять ячеек: правило про место молчит на складах меньше
    // двадцати ячеек, и проверять его надо на таком, где оно вообще работает.
    await api('POST', '/api/cells/rows', {
      token: ownerToken,
      body: { configs: Array.from({ length: 5 }, () => ({ rackCount: 5, tierCount: 1 })) },
    });
    const blocks = (await api('GET', '/api/cells/rows', { token: ownerToken })).body.flatMap((r) => r.blocks);

    const run = (fn) => withTenantContext({ warehouseId }, (client) => fn(client));

    // ---------- Пустой склад молчит ----------
    const first = await api('POST', '/api/alerts/check', { token: ownerToken });
    check('на спокойном складе тревог нет', () => {
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.open, 0, JSON.stringify(first.body));
    });

    const empty = await api('GET', '/api/alerts', { token: ownerToken });
    check('но отметка о проходе есть — видно, что сторож ходит', () => {
      assert.equal(empty.body.alerts.length, 0);
      assert.ok(empty.body.lastCheckedAt, 'нет времени последней проверки');
    });

    // ---------- Расхождение на приёмке ----------
    const inb = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId: company.body.id, number: `ПРХ-${stamp}`, direction: 'in',
        items: [{ name: 'Лимонад', sku: 'PB-AL', declaredQty: 10 }],
      },
    });
    await api('POST', '/api/receiving', {
      token: workerToken,
      body: { invoiceItemId: inb.body.items[0].id, acceptedQty: 7, cellBlockId: blocks[0].id },
    });

    await api('POST', '/api/alerts/check', { token: ownerToken });
    const freshList = await api('GET', '/api/alerts', { token: ownerToken });
    check('свежее расхождение сразу не тревожит — у владельца есть время', () => {
      assert.ok(
        !freshList.body.alerts.some((a) => a.alert_key === 'discrepancies_pending'),
        JSON.stringify(freshList.body.alerts.map((a) => a.alert_key)),
      );
    });

    // Состарим запись журнала — иначе пришлось бы ждать 12 часов.
    const agedOk = await ageRows(
      `UPDATE journal_entries SET created_at = now() - interval '20 hours'
       WHERE warehouse_id = $1 AND status = 'pending'`,
      [warehouseId],
    );
    if (!agedOk) {
      console.log('  SKIP  проверки по времени: не задан ADMIN_DATABASE_URL');
    }

    const aged = agedOk ? await api('POST', '/api/alerts/check', { token: ownerToken }) : null;
    if (agedOk) {
      check('расхождение, которое висит с ночи, поднимает тревогу', () => {
        assert.equal(aged.body.opened, 1, JSON.stringify(aged.body));
      });
    }

    const listed = await api('GET', '/api/alerts', { token: ownerToken });
    if (agedOk) check('текст говорит, сколько ждёт и чем это грозит', () => {
      const a = listed.body.alerts.find((x) => x.alert_key === 'discrepancies_pending');
      assert.ok(a, JSON.stringify(listed.body.alerts));
      assert.ok(a.text.includes('расхождение ждёт'), a.text);
      assert.ok(a.text.includes('акт продавцу не закрыт'), a.text);
    });

    const again = await api('POST', '/api/alerts/check', { token: ownerToken });
    check('второй проход не создаёт вторую такую же тревогу', () => {
      assert.equal(again.body.opened, 0, JSON.stringify(again.body));
    });
    const listed2 = await api('GET', '/api/alerts', { token: ownerToken });
    if (agedOk) check('в списке она по-прежнему одна', () => {
      const n = listed2.body.alerts.filter((x) => x.alert_key === 'discrepancies_pending').length;
      assert.equal(n, 1, JSON.stringify(listed2.body.alerts.map((a) => a.alert_key)));
    });

    // ---------- Причина ушла — тревога закрылась сама ----------
    const journal = await api('GET', '/api/journal', { token: ownerToken });
    const pending = journal.body.find((e) => e.status === 'pending');
    const confirmed = await api('POST', `/api/journal/${pending.id}/resolve`, {
      token: ownerToken, body: { resolution: 'confirm' },
    });
    check('владелец подтвердил расхождение', () => {
      assert.ok([200, 201].includes(confirmed.status), JSON.stringify(confirmed.body));
    });

    const afterFix = await api('POST', '/api/alerts/check', { token: ownerToken });
    if (agedOk) check('тревога закрывается сама, когда причина исчезла', () => {
      assert.equal(afterFix.body.resolved, 1, JSON.stringify(afterFix.body));
    });
    const listed3 = await api('GET', '/api/alerts', { token: ownerToken });
    if (agedOk) check('и уходит из открытых', () => {
      assert.ok(!listed3.body.alerts.some((x) => x.alert_key === 'discrepancies_pending'));
    });

    // ---------- Неразобранный возврат ----------
    const ret = await api('POST', '/api/invoices', {
      token: ownerToken,
      body: {
        companyId: company.body.id, number: `ВЗВ-${stamp}`, direction: 'return',
        items: [{ name: 'Лимонад', sku: 'PB-AL', declaredQty: 5 }],
      },
    });
    await run((c) => c.query(
      `UPDATE invoices SET created_at = now() - interval '3 days' WHERE id = $1`,
      [ret.body.id],
    ));

    const retAlert = await api('POST', '/api/alerts/check', { token: ownerToken });
    check('возврат, который лежит третьи сутки, поднимает тревогу', () => {
      assert.ok(retAlert.body.opened >= 1, JSON.stringify(retAlert.body));
    });
    const listed4 = await api('GET', '/api/alerts', { token: ownerToken });
    check('и объясняет, почему это плохо', () => {
      const a = listed4.body.alerts.find((x) => x.alert_key === 'returns_unsorted');
      assert.ok(a, JSON.stringify(listed4.body.alerts.map((x) => x.alert_key)));
      assert.ok(a.text.includes(ret.body.number), a.text);
      assert.ok(a.text.includes('не в продаже'), a.text);
    });

    // ---------- Места нет ----------
    // Занимаем все ячейки, кроме одной: порог — меньше пяти свободных.
    for (let i = 1; i < blocks.length; i += 1) {
      const inv = await api('POST', '/api/invoices', {
        token: ownerToken,
        body: {
          companyId: company.body.id, number: `ПРХ-F${i}-${stamp}`, direction: 'in',
          items: [{ name: 'Заполнитель', sku: `FILL-${i}`, declaredQty: 1 }],
        },
      });
      await api('POST', '/api/receiving', {
        token: workerToken,
        body: { invoiceItemId: inv.body.items[0].id, acceptedQty: 1, cellBlockId: blocks[i].id },
      });
    }
    await api('POST', '/api/alerts/check', { token: ownerToken });
    const listed5 = await api('GET', '/api/alerts', { token: ownerToken });
    check('о нехватке места говорит в свободных ячейках, а не в выдуманных процентах', () => {
      const a = listed5.body.alerts.find((x) => x.alert_key === 'no_free_cells');
      assert.ok(a, JSON.stringify(listed5.body.alerts.map((x) => x.alert_key)));
      assert.ok(a.text.includes('Свободных ячеек'), a.text);
      assert.ok(!a.text.includes('%'), `процентов быть не должно: ${a.text}`);
    });

    // ---------- Прочитано ----------
    const toSee = listed5.body.alerts[0];
    const seen = await api('POST', `/api/alerts/${toSee.id}/seen`, { token: ownerToken });
    check('сообщение можно отметить прочитанным', () => {
      assert.equal(seen.status, 200, JSON.stringify(seen.body));
    });
    const seenTwice = await api('POST', `/api/alerts/${toSee.id}/seen`, { token: ownerToken });
    check('повторная отметка не притворяется успешной', () => {
      assert.equal(seenTwice.status, 404, JSON.stringify(seenTwice.body));
    });

    // ---------- Чужой склад ----------
    const other = await api('POST', '/api/auth/owner/register', {
      body: {
        name: 'Other', email: `alert-other${stamp}@test.local`, password: 'secret123',
        warehouseName: 'Other WH', city: 'Kazan',
      },
    });
    const otherAlerts = await api('GET', '/api/alerts', { token: other.body.token });
    check('чужие тревоги не видны', () => {
      assert.equal(otherAlerts.status, 200, JSON.stringify(otherAlerts.body));
      assert.equal(otherAlerts.body.alerts.length, 0, JSON.stringify(otherAlerts.body.alerts));
    });

    const stealSeen = await api('POST', `/api/alerts/${toSee.id}/seen`, { token: other.body.token });
    check('и чужую нельзя отметить прочитанной', () => {
      assert.equal(stealSeen.status, 404, JSON.stringify(stealSeen.body));
    });

    // ---------- Работник ----------
    const workerAlerts = await api('GET', '/api/alerts', { token: workerToken });
    check('работнику этот список не показывается — решения принимает владелец', () => {
      assert.equal(workerAlerts.status, 403, JSON.stringify(workerAlerts.body));
    });

    // ---------- Обход всех складов ----------
    // Именно он работает в проде, и именно его тесты раньше не трогали:
    // проверялся проход по одному складу, а сам обход молча возвращал ноль
    // (у warehouses включена изоляция, и без контекста склада SELECT пуст).
    const swept = await runner.runOnce();
    check('общий обход видит склады, а не молча возвращает ноль', () => {
      assert.ok(swept >= 2, `обойдено складов: ${swept}`);
    });

    const afterSweep = await api('GET', '/api/alerts', { token: ownerToken });
    check('после обхода отметка о проверке свежая', () => {
      assert.ok(afterSweep.body.lastCheckedAt, 'нет времени последней проверки');
      const age = Date.now() - new Date(afterSweep.body.lastCheckedAt).getTime();
      assert.ok(age < 60000, `отметка старше минуты: ${age} мс`);
    });

    // ---------- Сводка ----------
    const digest = await run((c) => runner.maybeDigest(c, warehouseId));
    const listed6 = await api('GET', '/api/alerts', { token: ownerToken });
    check('утренняя сводка собирается один раз в день', () => {
      const digests = listed6.body.alerts.filter((x) => x.alert_key.startsWith('digest:'));
      // До семи утра по Москве сводки нет — это тоже правильное поведение.
      const mskHour = new Date(Date.now() + 3 * 3600000).getUTCHours();
      if (mskHour < 7) {
        assert.equal(digests.length, 0, 'до утра сводки быть не должно');
      } else {
        assert.equal(digests.length, 1, JSON.stringify(digests.map((d) => d.alert_key)));
        assert.ok(digests[0].text.includes('Доброе утро'), digests[0].text);
      }
    });

    const digestAgain = await run((c) => runner.maybeDigest(c, warehouseId));
    check('второй раз за день сводка не повторяется', () => {
      assert.equal(digestAgain, null);
    });
    void digest;
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
