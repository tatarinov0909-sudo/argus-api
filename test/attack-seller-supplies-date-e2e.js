// Атака 11. «Поставки на WB» в кабинете продавца (GET /api/sellers/supplies,
// 24.09) отдают дату отгрузки не датой, а меткой времени «полночь по часам
// сервера» (у остальных ручек поставок — to_char(ship_date,'YYYY-MM-DD')).
// Кабинет продавца делает new Date(shipDate).toLocaleDateString(...) — и у
// продавца, чей часовой пояс западнее сервера (Калининград при сервере по
// Москве), дата отгрузки показывается на день раньше.
const { startApp, warehouse, assert } = require('./attack-helpers');
const { moscowToday } = require('../src/supplies/service');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  const { ok, stop } = await startApp();
  try {
    const w = await warehouse(ok, 'supdate');
    const seller = await w.company('Продавец (синтетика)');
    const st = await w.sellerToken(seller);
    await ok('POST', '/api/products', w.token, { companyId: seller, sku: 'SD-1', name: 'Товар синтетический' });
    const inv = await ok('POST', '/api/invoices', w.token, { companyId: seller, number: 'ATK-SD-1', direction: 'out',
      items: [{ name: 'Товар синтетический', sku: 'SD-1', declaredQty: 1 }] });
    const d = new Date(`${moscowToday()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 2);
    const shipDate = d.toISOString().slice(0, 10);
    await ok('POST', '/api/supplies', w.token, { invoiceIds: [inv.id], shipDate }, 201);

    const mine = await ok('GET', '/api/sellers/supplies', st);
    const r = mine[0];
    // Ровно то, что делает seller-cabinet.js в renderSupplies(), у продавца в Калининграде.
    const shown = new Date(r.shipDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Kaliningrad' });
    const expected = new Date(`${shipDate}T12:00:00Z`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
    console.log('  дата отгрузки:', shipDate, '; API продавцу отдаёт:', r.shipDate, '; кабинет в Калининграде покажет:', shown);
    check('API отдаёт продавцу дату отгрузки датой ГГГГ-ММ-ДД, как остальные ручки поставок', () => assert.equal(r.shipDate, shipDate));
    check('кабинет продавца показывает ту дату отгрузки, что назначил склад', () => assert.equal(shown, expected));
  } finally { await stop(); }
  console.log(failed ? `\n${failed} FAIL` : '\nвсе проверки прошли');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exitCode = 1; });
