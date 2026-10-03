// Экран: кабинет продавца → «Товары» → карточка товара, у продавца есть
// склады. В одной карточке два разных «Доступно» для всего товара: плитка
// сверху — 72 (всего − заказано − в сборке), а строка «Основной — весь
// товар» в таблице «По вашим складам» — 74 (сумма «Доступно» по складам,
// без вычета «Заказано»). На стенде так у «Авезов ИП (тест)», «Гранола
// шоколадная 400 г» (снимок seller-product-card-1440.png).
//
// Документ: «Виртуальные склады — схема.md», уточнение 03.10 — «Основной» —
// ВЕСЬ товар продавца; rules/truthful-seller-data.md — «Доступно» = «Всего»
// − «Заказано» − «В сборке». Место: seller-cabinet.js, productVwHtml —
// строка «Основной — весь товар» складывает available складов.
// Запуск: ARGUS_PLAYWRIGHT_MODULE=<путь к playwright> node <файл>.
const { openPage, browser, fakeToken } = require('./_ui');
const { company, apiData } = require('./_seller-fixture');

(async () => {
  const b = await browser();
  try {
    const page = await b.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openPage(page, { file: 'client_access.html#products', role: 'seller',
      token: fakeToken({ role: 'seller', companyId: company.id, warehouseId: 'wh', name: 'Продавец' }), apiData });
    await page.locator('[data-product="R-1"]').first().waitFor({ timeout: 15000 });
    await page.locator('[data-product="R-1"]').first().click();
    await page.getByText('По вашим складам').waitFor({ timeout: 15000 });
    const got = await page.evaluate(() => {
      const d = document.getElementById('drawer');
      const tile = [...d.querySelectorAll('.mini-stats > *')].find((x) => /^Доступно/.test(x.textContent.trim()));
      const sec = [...d.querySelectorAll('.detail-section')].find((s) => s.textContent.includes('По вашим складам'));
      const head = [...sec.querySelectorAll('thead th, tr:first-child th')].map((x) => x.textContent.trim());
      const col = head.indexOf('Доступно');
      const row = [...sec.querySelectorAll('tr')].find((tr) => tr.textContent.includes('Основной — весь товар'));
      return { tile: tile ? tile.textContent.replace(/\D/g, '') : null, main: row && col >= 0 ? row.children[col].textContent.replace(/\D/g, '') : null };
    });
    const ok = got.tile !== null && got.tile === got.main;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  в карточке «Доступно» для всего товара одно и то же число`
      + (ok ? '' : `\n        ожидалось: плитка «Доступно» = строка «Основной — весь товар» (72)\n        получили:  плитка ${got.tile}, строка «Основной — весь товар» ${got.main}`));
    if (errors.length) throw Error('ошибки на странице: ' + errors.join('; '));
    if (!ok) process.exitCode = 1;
  } finally {
    await b.close();
  }
})().catch((err) => { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; });
