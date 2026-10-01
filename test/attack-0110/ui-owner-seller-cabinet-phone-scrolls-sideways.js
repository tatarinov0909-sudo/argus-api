// Экран: кабинет продавца глазами владельца склада (client_access.html,
// «Склады WB») на телефоне ширины 375 px прокручивается вбок.
//
// У владельца в шапке — переключатель продавца («Продавец Авезов ИП
// (тест)») и «← К складу»; шапка не переносится и вылезает за край экрана,
// вместе с ней — нижняя панель вкладок. Чем длиннее имя продавца, тем шире.
// У самого продавца (без переключателя) ширина в норме — значит, ломает
// именно шапка владельца. На стенде: «Авезов ИП (тест)» — 391 px из 375.
//
// Правило проекта (CLAUDE.md): адаптивность, без горизонтальной прокрутки.
// Запуск: ARGUS_PLAYWRIGHT_MODULE=<путь к playwright> node <файл>.
const assert = require('node:assert/strict');
const { openPage, browser, fakeToken } = require('./_ui');

const company = { id: '11111111-1111-1111-1111-111111111111', name: 'Авезов ИП (тест)' };
const wb = {
  ffName: 'Восход', connected: true, active: true, unknownOrders: 0, refreshedAt: '2026-10-01T00:00:00Z', stock: {},
  warehouses: [{ id: '11', name: 'ФФ Восход СПБ / МСК', ours: true, auto: true, nameMatches: true, gone: false,
    office: { id: '1', name: 'Шушары', city: 'Санкт-Петербург', address: 'Московское ш., 153' }, openOrders: 5, hidden: 0 }],
};
const apiData = (p) => {
  if (p === '/api/sellers/companies') return [company];
  if (p === '/api/sellers/profile') return { ...company, warehouseId: 'wh', warehouseName: 'Восход', timezone: 'Europe/Moscow' };
  if (p === '/api/sellers/catalog') return { products: [] };
  if (p === '/api/sellers/stock') return { rows: [], summary: { productCount: 0, total: null, ordered: 0, inAssembly: 0, inTransit: 0, available: null, unknownCount: 0, unknownNames: [] } };
  if (p === '/api/sellers/wb-warehouses') return wb;
  if (p.startsWith('/api/sellers/')) return { rows: [], hasMore: false };
  return undefined;
};

(async () => {
  const b = await browser();
  let failed = false;
  try {
    for (const role of ['seller', 'owner']) {
      const page = await b.newPage({ viewport: { width: 375, height: 812 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await openPage(page, { file: `client_access.html?companyId=${company.id}#wb`, role,
        token: fakeToken(role === 'owner' ? { role: 'owner', warehouseId: 'wh' } : { role: 'seller', companyId: company.id, warehouseId: 'wh' }), apiData });
      await page.getByText('Все ваши склады на WB').first().waitFor({ timeout: 15000 });
      const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
        wide: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5
          && e.getBoundingClientRect().width > 0).map((e) => `${e.tagName}.${String(e.className).split(' ')[0]}`).slice(0, 4) }));
      const okWidth = w.sw <= w.cw;
      console.log(`  ${okWidth ? 'ok  ' : 'FAIL'}  ${role === 'owner' ? 'владелец' : 'продавец'}: «Склады WB» на 375 px без прокрутки вбок`
        + (okWidth ? '' : `\n        ожидалось: ширина страницы ≤ ${w.cw}\n        получили:  ${w.sw} px, за край вылезают: ${w.wide.join(', ')}`));
      if (!okWidth) failed = true;
      assert.deepEqual(errors, [], `ошибки на странице: ${errors.join('; ')}`);
      await page.close();
    }
  } finally {
    await b.close();
  }
  if (failed) process.exitCode = 1;
})().catch((err) => { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; });
