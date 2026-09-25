// Атака 7. Пункты приёма WB (GET /api/supplies/shipping-points/:companyId, 25.09).
//
// Список пунктов кэшируется на 6 часов по одному companyId — без склада. Кэш
// проверяется ДО того, как выясняется, чей это продавец: владелец чужого
// склада, подставив companyId продавца другого склада, получает данные,
// полученные с WB ключом того продавца. До кэша такой запрос получал 404.
const { startApp, warehouse, assert } = require('./attack-helpers');
const wb = require('../src/marketplaces/wb');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  const { api, ok, stop } = await startApp();
  const realInfo = wb.sellerInfo; const realPoints = wb.shippingPoints;
  let wbCalls = 0;
  wb.sellerInfo = async () => ({ name: 'Синтетический продавец', inn: '0000000000', tradeMark: 'T', sellerId: 's' });
  wb.shippingPoints = async () => {
    wbCalls += 1;
    return [{ id: 777001, name: 'СЦ Синтетический', address: 'Тестовый адрес склада А', city: 'Тест', officeType: 'sc', fulfillment: false }];
  };
  try {
    const a = await warehouse(ok, 'pointsA');
    const b = await warehouse(ok, 'pointsB');
    const sellerA = await a.company('Продавец склада А (синтетика)');
    await ok('POST', '/api/marketplaces/credentials', a.token,
      { companyId: sellerA, marketplace: 'wb', token: 'synthetic-test-token-not-real' }, 201);

    const before = await api('GET', `/api/supplies/shipping-points/${sellerA}`, b.token);
    console.log('  склад Б до того, как склад А открыл список:', before.status, before.body.error || '');
    const own = await api('GET', `/api/supplies/shipping-points/${sellerA}`, a.token);
    assert.equal(own.status, 200);
    const after = await api('GET', `/api/supplies/shipping-points/${sellerA}`, b.token);
    console.log('  склад Б после:', after.status, JSON.stringify(after.body).slice(0, 120), '; обращений к WB:', wbCalls);
    check('до кэша чужой склад получает отказ (контроль)', () => assert.ok(before.status >= 400));
    check('склад Б не получает пункты, взятые ключом продавца склада А', () => assert.ok(after.status >= 400,
      `ответ ${after.status}: ${JSON.stringify(after.body).slice(0, 80)}`));

    // Сбой WB на первом запросе (пустой список) запоминается на 6 часов:
    // пункт не выбрать, поставку не передать в доставку, пока не перезапустят API.
    const sellerA2 = await a.company('Продавец склада А-2 (синтетика)');
    await ok('POST', '/api/marketplaces/credentials', a.token,
      { companyId: sellerA2, marketplace: 'wb', token: 'synthetic-test-token-not-real' }, 201);
    const good = wb.shippingPoints;
    wb.shippingPoints = async () => { wbCalls += 1; return []; };
    const glitch = await ok('GET', `/api/supplies/shipping-points/${sellerA2}`, a.token);
    wb.shippingPoints = good;   // WB снова отвечает нормально
    const retry = await ok('GET', `/api/supplies/shipping-points/${sellerA2}?q=${encodeURIComponent('тестовый')}`, a.token);
    console.log('  после пустого ответа WB:', glitch.total, '→ повторный поиск:', retry.total, 'пунктов');
    check('пустой ответ WB не запоминается на 6 часов — повторный поиск находит пункт', () => assert.ok(retry.total > 0));
  } finally {
    wb.sellerInfo = realInfo; wb.shippingPoints = realPoints;
    await stop();
  }
  console.log(failed ? `\n${failed} FAIL` : '\nвсе проверки прошли');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exitCode = 1; });
