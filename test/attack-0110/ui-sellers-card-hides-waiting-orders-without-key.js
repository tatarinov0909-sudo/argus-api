// Экран «Продавцы» (cabinet_main, после переделки 01.10 «одна страница»):
// заказы продавца, у которого отключён ключ WB, считаются в шапке «N заказов
// ждут поставки», но на его карточке не видны — там «WB не подключён —
// заказы с маркетплейса не приходят». Человек видит «17 ждут», а на
// карточках находит 13 и не понимает, где ещё 4.
//
// На стенде так сейчас: шапка «17 заказов ждут поставки», «Авезов» — 13,
// «Слим Тим (тест)» — ключа нет, у него 4 заказа ждут поставки
// (GET /api/supplies/pending), на карточке их нет.
//
// Ожидаемо: у продавца, чьи заказы входят в число в шапке, карточка
// показывает, сколько его заказов ждёт поставки (renderMpCards рисует
// число только при подключённом ключе: `cred ? … : 'WB не подключён'`).
const { openPage, browser, fakeToken } = require('./_ui');

const slim = { id: '22222222-2222-2222-2222-222222222222', name: 'Слим Тим (тест)', keys: [], created_at: '2026-09-01T00:00:00Z' };
const avez = { id: '33333333-3333-3333-3333-333333333333', name: 'Авезов ИП (тест)', keys: [], created_at: '2026-09-02T00:00:00Z' };
const apiData = (p) => {
  if (p === '/api/warehouses/me') return { id: 'wh', name: 'Восход', city: 'Москва', warehouse_code: '0001', setup_at: '2026-09-30T00:00:00Z', stock_source: '1c', timezone: 'Europe/Moscow', wb_supplies_by: 'ff', wb_names: [] };
  if (p === '/api/sellers/companies') return [slim, avez];
  if (p === '/api/marketplaces') return [{ id: 'm1', companyId: avez.id, company: avez.name, marketplace: 'wb', writeEnabled: false, lastUsedAt: new Date().toISOString() }];
  if (p === '/api/supplies/pending') return [
    { companyId: avez.id, companyName: avez.name, marketplace: 'wb', marketplaces: ['wb'], orders: 13, units: 16, oldest: '2026-09-06T00:00:00Z' },
    { companyId: slim.id, companyName: slim.name, marketplace: 'wb', marketplaces: ['wb'], orders: 4, units: 4, oldest: '2026-09-28T00:00:00Z' },
  ];
  if (p === '/api/marketplaces/wb/offices') return { offices: [], sellers: [], ffName: 'Восход' };
  if (p === '/api/sync/status') return {};
  return undefined;
};

(async () => {
  const b = await browser();
  try {
    const page = await b.newPage({ viewport: { width: 1440, height: 1000 } });
    await openPage(page, { file: 'cabinet_main.html', role: 'owner', token: fakeToken({ role: 'owner', ownerName: 'Тест', warehouseId: 'wh' }), apiData });
    await page.locator('#nav-mp').click();
    await page.locator('.mp-card').first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    const head = (await page.locator('#mpList').evaluate(() => document.body.innerText)).match(/(\d+) заказ\S* жд\S* поставки/);
    const slimCard = await page.locator('.mp-card', { hasText: slim.name }).innerText();
    const ok = /\b4\b/.test(slimCard) && /жд/.test(slimCard);
    console.log(`        шапка: «${head ? head[0] : '—'}»`);
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  карточка «${slim.name}» показывает его 4 заказа, которые ждут поставки`
      + (ok ? '' : `\n        ожидалось: «4 заказа ждут» на карточке\n        получили:  ${slimCard.replace(/\s+/g, ' ').trim()}`));
    if (!ok) process.exitCode = 1;
  } finally {
    await b.close();
  }
})().catch((err) => { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; });
