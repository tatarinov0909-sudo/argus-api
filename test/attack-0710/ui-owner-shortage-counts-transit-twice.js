// Проверка 07.10 (экран): «Товары» клиента у склада, отметка «Не хватает».
//
// С 06.10 «Не хватает» у товара считается так: заказано + в сборке + В ПУТИ
// − всего. Но при учёте в 1С «В пути» уже может быть списано 1С (оно не
// в «Всего») — сервер это знает и вычитает только `transitCounted`. Экран
// берёт весь «В пути» и вычитает уехавшее второй раз: «не хватает» больше,
// чем на самом деле.
//
// Пример: 1С списала уехавшее, «Всего» 8, в пути 2 (уже не в «Всего»),
// заказано 9. Не хватает 9 − 8 = 1 шт., экран пишет 3.
//
// Запуск: node test/attack-0710/ui-owner-shortage-counts-transit-twice.js
// (нужен Playwright: ARGUS_PLAYWRIGHT_MODULE). Код выхода: 1 — ошибка
// Аргуса, 2 — сломался тест.
const { launch, open } = require('./_ui');

const COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// Строка в том виде, в каком её отдаёт GET /api/sellers/stock?companyId=
// (src/sellers/stock.js) для этого случая.
const row = { sku: 'TR-1', name: 'Гантели', listed: true, stockKnown: true, total: 8, totalKnown: true,
  orderedNotInSupply: 9, inAssembly: 0, inTransit: 2, transitCounted: 0, acceptedByWb: 0, sellerAvailable: 0,
  shortage: true, qty: 8, onHand: 8, cells: 1, defective: 0, packagingDefect: 0, notForSale: 0, qtyIn1c: 8 };

(async () => {
  let browser;
  let bad = 0;
  try {
    browser = await launch();
    const { page } = await open(browser, { api: (p) => {
      if (p === '/api/sellers/companies') return { json: [{ id: COMPANY, name: 'Слим Тест', keys: [] }] };
      if (p === '/api/sellers/stock') return { json: [row] };
      return undefined;
    } });
    await page.locator('#view-home.active').waitFor();
    await page.evaluate(() => switchView('products'));
    await page.evaluate((id) => window.openSellerProducts(id), COMPANY);
    await page.locator('#productsList table').waitFor();
    const text = await page.locator('#productsList').innerText();
    const m = /Не хватает:\s*([\d\s ]+)\s*шт/.exec(text);
    const shown = m ? Number(m[1].replace(/\D/g, '')) : null;
    console.log('  на экране:', m ? m[0] : 'нет отметки «Не хватает»');
    if (shown === null) throw Error('нет отметки «Не хватает» — экран изменился');
    if (shown !== 1) { bad += 1; console.log(`  FAIL  «Не хватает» ${shown} шт., а на самом деле 1 (заказано 9, всего 8; «В пути» 2 уже списано 1С)`); }
    else console.log('  ok    «Не хватает» 1 шт.');
  } catch (e) {
    console.error('ОШИБКА ТЕСТА', e); process.exitCode = 2;
  } finally {
    if (browser) await browser.close();
    if (bad && process.exitCode !== 2) process.exitCode = 1;
  }
})();
