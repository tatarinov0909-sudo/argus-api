// Экран: кабинет продавца → «Товары» на телефоне 375 px шире экрана —
// 411 px. Кнопки «Столбцы · Excel · Остатки для WB» стоят в одну строку и
// не переносятся; страница листается вбок, обрезаны кнопка «Остатки для WB»,
// нижнее меню («Товары», «Расчёты») и открытая карточка товара с разделом
// «По вашим складам» и заявкой «Попросить склад перенести».
// На стенде так у обоих продавцов — и со складами («Авезов»), и без
// («Слим Тим»); снимки seller-products-375-*.png, seller-product-card-vw-375.png.
//
// Правило: rules/formatting.md — на телефоне таблица становится карточками,
// «Отложено.md» 26.09 — «телефон: … страница не листается вбок».
// Запуск: ARGUS_PLAYWRIGHT_MODULE=<путь к playwright> node <файл>.
const { openPage, browser, fakeToken } = require('./_ui');
const { company, apiData } = require('./_seller-fixture');

(async () => {
  const b = await browser();
  try {
    const page = await b.newPage({ viewport: { width: 375, height: 812 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openPage(page, { file: 'client_access.html#products', role: 'seller',
      token: fakeToken({ role: 'seller', companyId: company.id, warehouseId: 'wh', name: 'Продавец' }), apiData });
    await page.locator('[data-product="R-1"]').first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(300);
    const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      wide: [...document.querySelectorAll('#view *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 0.5
        && e.getBoundingClientRect().width > 0 && !e.closest('.toolbar-scroll')).map((e) => `${e.tagName}.${String(e.className).split(' ')[0]} «${e.textContent.trim().slice(0, 20)}»`).slice(0, 4) }));
    const ok = w.sw <= w.cw;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  «Товары» продавца на 375 px — без прокрутки вбок`
      + (ok ? '' : `\n        ожидалось: ширина страницы ≤ ${w.cw}\n        получили:  ${w.sw} px, за край вылезают: ${w.wide.join(', ')}`));
    if (errors.length) throw Error('ошибки на странице: ' + errors.join('; '));
    if (!ok) process.exitCode = 1;
  } finally {
    await b.close();
  }
})().catch((err) => { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; });
