// Менеджер — четвёртый человек в системе.
//
// Проверяется главное: он делает свою работу (заказы, поставки, накладные),
// но не раздаёт доступы и не перекраивает склад — пока владелец сам не
// откроет ему это право. И ни при каких правах не может завести себе
// второго менеджера: иначе урезание становится вежливой просьбой.
//
//   DATABASE_URL=postgres://argus_app:...@127.0.0.1:5433/argus_test \
//   JWT_SECRET=test node test/manager-role-e2e.js

const assert = require('node:assert');
const { createApp } = require('../src/app');

const PORT = 3991;
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0;
const failures = [];

function check(name, fn) {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (err) { failures.push({ name, message: err.message }); console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
    const reg = await api('POST', '/api/auth/owner/register', {
      body: { name: 'Boss', email: `mgr${stamp}@test.local`, password: 'secret123',
              warehouseName: 'Mgr WH', city: 'Moscow' },
    });
    const ownerToken = reg.body.token;

    // ---------- Ключ менеджера ----------
    const mgrKey = await api('POST', '/api/staff', {
      token: ownerToken, body: { name: 'Менеджер Ольга', kind: 'manager' },
    });
    check('владелец выдаёт ключ менеджера', () => {
      assert.equal(mgrKey.status, 201, JSON.stringify(mgrKey.body));
      assert.equal(mgrKey.body.kind, 'manager');
      assert.deepEqual(mgrKey.body.permissions, [], 'по умолчанию прав нет');
    });

    const badGrant = await api('POST', '/api/staff', {
      token: ownerToken, body: { name: 'Кто-то', kind: 'manager', permissions: ['всё'] },
    });
    check('неизвестное право не принимается', () => {
      assert.equal(badGrant.status, 400, JSON.stringify(badGrant.body));
    });
    const workerWithGrants = await api('POST', '/api/staff', {
      token: ownerToken, body: { name: 'Грузчик', permissions: ['clients'] },
    });
    check('работнику права не открываются — они про менеджера', () => {
      assert.equal(workerWithGrants.status, 400, JSON.stringify(workerWithGrants.body));
    });

    const login = await api('POST', '/api/auth/staff/login', { body: { keyCode: mgrKey.body.key_code } });
    check('вход по ключу даёт роль менеджера, а не работника', () => {
      assert.equal(login.status, 200, JSON.stringify(login.body));
      assert.equal(login.body.role, 'manager');
    });
    const mgrToken = login.body.token;

    // ---------- Своя работа ----------
    const pending = await api('GET', '/api/supplies/pending', { token: mgrToken });
    check('менеджер видит накопившиеся заказы — это его работа', () => {
      assert.equal(pending.status, 200, JSON.stringify(pending.body));
    });
    // Склад и пересчёт менеджеру по умолчанию закрыты: решение владельца
    // от 17.09.2026 — его работа заказы и поставки, а не остатки по ячейкам.
    const map = await api('GET', '/api/cells/rows', { token: mgrToken });
    const zones = await api('GET', '/api/dropzones', { token: mgrToken });
    const advice = await api('GET', '/api/inventory/advice', { token: mgrToken });
    check('склад, зоны и пересчёт закрыты, пока владелец не открыл право «склад»', () => {
      assert.equal(map.status, 403, JSON.stringify(map.body));
      assert.equal(zones.status, 403, JSON.stringify(zones.body));
      assert.equal(advice.status, 403, JSON.stringify(advice.body));
    });
    const mps = await api('GET', '/api/marketplaces', { token: mgrToken });
    check('список площадок менеджеру виден — по нему он забирает заказы', () => {
      assert.equal(mps.status, 200, JSON.stringify(mps.body));
    });
    const journal = await api('GET', '/api/journal', { token: mgrToken });
    check('и журнал действий', () => {
      assert.equal(journal.status, 200, JSON.stringify(journal.body));
    });

    // ---------- Чего нельзя без открытого права ----------
    const closed = [
      ['POST', '/api/sellers/companies', { name: 'Новый клиент' }, 'заводить клиентов'],
      ['POST', '/api/staff', { name: 'Новый грузчик' }, 'выдавать ключи работникам'],
      ['POST', '/api/cells/rows', { configs: [{ rackCount: 2, tierCount: 2 }] }, 'менять склад'],
      ['POST', '/api/sync/keys', { label: 'ключ' }, 'подключать 1С'],
      ['POST', '/api/marketplaces/credentials', { companyId: null, marketplace: 'wb', token: 'x' },
        'привязывать ключ площадки'],
      ['DELETE', '/api/marketplaces/00000000-0000-0000-0000-000000000000/wb', null,
        'снимать ключ площадки'],
    ];
    for (const [method, path, body, what] of closed) {
      const r = await api(method, path, { token: mgrToken, body });
      check(`без права нельзя: ${what}`, () => {
        assert.equal(r.status, 403, `${path} -> ${r.status} ${JSON.stringify(r.body)}`);
        assert.ok(String(r.body.error).includes('руководитель'), r.body.error);
      });
    }

    // ---------- Право открыли — стало можно ----------
    const withClients = await api('POST', '/api/staff', {
      token: ownerToken, body: { name: 'Менеджер Пётр', kind: 'manager', permissions: ['clients'] },
    });
    const petrToken = (await api('POST', '/api/auth/staff/login',
      { body: { keyCode: withClients.body.key_code } })).body.token;
    const nowAllowed = await api('POST', '/api/sellers/companies', {
      token: petrToken, body: { name: `Клиент ${stamp}` },
    });
    check('с открытым правом клиента завести можно', () => {
      assert.equal(nowAllowed.status, 201, JSON.stringify(nowAllowed.body));
    });
    const stillClosed = await api('POST', '/api/sync/keys', { token: petrToken, body: { label: 'x' } });
    check('но открытое право не тянет за собой остальные', () => {
      assert.equal(stillClosed.status, 403, JSON.stringify(stillClosed.body));
    });

    const withWarehouse = await api('POST', '/api/staff', {
      token: ownerToken, body: { name: 'Менеджер Склада', kind: 'manager', permissions: ['warehouse'] },
    });
    const whToken = (await api('POST', '/api/auth/staff/login',
      { body: { keyCode: withWarehouse.body.key_code } })).body.token;
    const openedMap = await api('GET', '/api/cells/rows', { token: whToken });
    const openedZones = await api('GET', '/api/dropzones', { token: whToken });
    const openedAdvice = await api('GET', '/api/inventory/advice', { token: whToken });
    check('с правом «склад» менеджер видит карту, зоны и пересчёт', () => {
      assert.equal(openedMap.status, 200, JSON.stringify(openedMap.body));
      assert.equal(openedZones.status, 200, JSON.stringify(openedZones.body));
      assert.equal(openedAdvice.status, 200, JSON.stringify(openedAdvice.body));
    });

    // ---------- Себе подобного не завести ни при каких правах ----------
    const withStaff = await api('POST', '/api/staff', {
      token: ownerToken, body: { name: 'Менеджер Игорь', kind: 'manager', permissions: ['staff'] },
    });
    const igorToken = (await api('POST', '/api/auth/staff/login',
      { body: { keyCode: withStaff.body.key_code } })).body.token;
    const madeWorker = await api('POST', '/api/staff', {
      token: igorToken, body: { name: 'Грузчик Игоря' },
    });
    check('с правом на ключи менеджер выдаёт ключ работнику', () => {
      assert.equal(madeWorker.status, 201, JSON.stringify(madeWorker.body));
    });
    const madeManager = await api('POST', '/api/staff', {
      token: igorToken, body: { name: 'Свой менеджер', kind: 'manager', permissions: ['billing'] },
    });
    check('но второго МЕНЕДЖЕРА не выдаст даже с этим правом', () => {
      assert.equal(madeManager.status, 403, JSON.stringify(madeManager.body));
      assert.ok(String(madeManager.body.error).includes('только руководитель'), madeManager.body.error);
    });


    // ---------- Роль ключа можно поменять, не перевыдавая его ----------
    //
    // Ключ, выданный не той ролью, раньше приходилось отзывать: человек терял
    // вход и получал новый код, который надо снова ему передать.
    const asWorker = await api('POST', '/api/staff', {
      token: ownerToken, body: { name: 'Стал менеджером' },
    });
    const promoted = await api('PATCH', `/api/staff/${asWorker.body.id}/kind`, {
      token: ownerToken, body: { kind: 'manager', permissions: ['warehouse'] },
    });
    check('владелец делает работника менеджером, код ключа не меняется', () => {
      assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
      assert.equal(promoted.body.kind, 'manager');
      assert.equal(promoted.body.key_code, asWorker.body.key_code);
      assert.deepEqual(promoted.body.permissions, ['warehouse']);
    });
    const afterPromote = await api('POST', '/api/auth/staff/login',
      { body: { keyCode: asWorker.body.key_code } });
    check('и вход по тому же ключу открывает кабинет менеджера', () => {
      assert.equal(afterPromote.body.role, 'manager', JSON.stringify(afterPromote.body));
    });
    const demoted = await api('PATCH', `/api/staff/${asWorker.body.id}/kind`, {
      token: ownerToken, body: { kind: 'worker' },
    });
    check('и обратно в работники — права при этом снимаются', () => {
      assert.equal(demoted.status, 200, JSON.stringify(demoted.body));
      assert.equal(demoted.body.kind, 'worker');
      assert.deepEqual(demoted.body.permissions, []);
    });

    // ---------- Права можно поменять после выдачи ----------
    //
    // Раньше единственный способ дать менеджеру новое право — отозвать ключ и
    // выдать другой; человек при этом терял вход посреди смены.
    const regrant = await api('PATCH', `/api/staff/${mgrKey.body.id}/permissions`, {
      token: ownerToken, body: { permissions: ['warehouse', 'clients'] },
    });
    check('владелец меняет права менеджера без перевыдачи ключа', () => {
      assert.equal(regrant.status, 200, JSON.stringify(regrant.body));
      assert.deepEqual([...regrant.body.permissions].sort(), ['clients', 'warehouse']);
    });
    const listAfter = await api('GET', '/api/staff', { token: ownerToken });
    check('и в списке ключей права обновились', () => {
      const row = listAfter.body.find((k) => k.id === mgrKey.body.id);
      assert.deepEqual([...row.permissions].sort(), ['clients', 'warehouse']);
    });
    const regrantByManager = await api('PATCH', `/api/staff/${mgrKey.body.id}/permissions`, {
      token: igorToken, body: { permissions: ['billing'] },
    });
    check('менеджер права не меняет — даже с правом на ключи', () => {
      assert.equal(regrantByManager.status, 403, JSON.stringify(regrantByManager.body));
    });
    const promoteBySelf = await api('PATCH', `/api/staff/${madeWorker.body.id}/kind`, {
      token: igorToken, body: { kind: 'manager' },
    });
    check('и роль ключа менеджер не меняет — иначе он заведёт себе второго', () => {
      assert.equal(promoteBySelf.status, 403, JSON.stringify(promoteBySelf.body));
    });
    const regrantWorker = await api('PATCH', `/api/staff/${madeWorker.body.id}/permissions`, {
      token: ownerToken, body: { permissions: ['clients'] },
    });
    check('работнику права не назначаются', () => {
      assert.equal(regrantWorker.status, 400, JSON.stringify(regrantWorker.body));
    });

    // ---------- Ключи менеджеров закрыты и от менеджера с правом ----------
    //
    // Запрет «второго менеджера не выдать» ничего не стоил, пока список
    // ключей был общим: менеджер читал ключ другого менеджера прямо в списке
    // и входил им — со всеми чужими правами. Выдавать новый ключ ему было
    // незачем, готовый лежал на экране.
    const listByIgor = await api('GET', '/api/staff', { token: igorToken });
    check('менеджер видит в списке только работников', () => {
      assert.equal(listByIgor.status, 200, JSON.stringify(listByIgor.body));
      const managers = listByIgor.body.filter((k) => k.kind === 'manager');
      assert.equal(managers.length, 0,
        'в списке видны ключи менеджеров: ' + JSON.stringify(managers.map((m) => m.name)));
      assert.ok(listByIgor.body.some((k) => k.name === 'Грузчик Игоря'), 'работники пропали');
    });
    const listByOwner = await api('GET', '/api/staff', { token: ownerToken });
    check('а владелец видит всех', () => {
      assert.ok(listByOwner.body.some((k) => k.kind === 'manager'), 'владелец потерял менеджеров');
    });
    const revokeManager = await api('PATCH', `/api/staff/${withStaff.body.id}/toggle`,
      { token: igorToken });
    check('и не может отозвать или восстановить ключ менеджера', () => {
      assert.equal(revokeManager.status, 403, JSON.stringify(revokeManager.body));
    });
    const revokeWorker = await api('PATCH', `/api/staff/${madeWorker.body.id}/toggle`,
      { token: igorToken });
    check('но ключом работника распоряжается свободно', () => {
      assert.equal(revokeWorker.status, 200, JSON.stringify(revokeWorker.body));
      assert.equal(revokeWorker.body.active, false);
    });
    // ---------- Отзыв ключа действует ----------
    //
    // «В ту же секунду» — не буквально: у проверки живости ключа есть
    // двухсекундный кэш, заведённый нарочно, чтобы не бить в базу на каждый
    // запрос. Ждём его и проверяем, что дальше доступа нет. Важно именно
    // это: не «мгновенно», а «без ожидания конца жизни токена», который
    // живёт сорок пять минут.
    await api('PATCH', `/api/staff/${withClients.body.id}/toggle`, { token: ownerToken });
    await new Promise((r) => setTimeout(r, 2500));
    const afterRevoke = await api('GET', '/api/supplies/pending', { token: petrToken });
    check('отозвали ключ — менеджер теряет доступ, не дожидаясь конца токена', () => {
      assert.equal(afterRevoke.status, 401, JSON.stringify(afterRevoke.body));
    });
  } finally { server.close(); }

  console.log(`\n${passed} прошло, ${failures.length} упало`);
  for (const f of failures) console.log(`  ${f.name}: ${f.message}`);
  process.exit(failures.length ? 1 : 0);
})();
