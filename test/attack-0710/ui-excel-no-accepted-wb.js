// Проверка 07.10 (экраны): столбец «Принято WB» в выгрузках Excel.
//
// 06.10 «Принято WB» (принято WB за 3 дня) добавили на экраны — «Товары»
// у продавца и «Остатки продавцов» у склада — и, по хендоффу, в Excel. На
// экранах столбец есть, а в файлах «Остатки» (у продавца) и «Остатки
// продавцов» (у склада) его нет: на экране одно, в выгрузке другое.
//
// Запуск: node test/attack-0710/ui-excel-no-accepted-wb.js (нужен Playwright:
// ARGUS_PLAYWRIGHT_MODULE). Код выхода: 1 — ошибка Аргуса, 2 — сломался тест.
const { launch, open } = require('./_ui');
const fx = require('../attack-0310/_seller-fixture');

const seller = { companyId: fx.company.id, name: 'Слим Тест', productCount: 1, total: 10, ordered: 1,
  inAssembly: 0, inTransit: 1, acceptedByWb: 2, available: 8, defect: 0, shortageCount: 0, unknownCount: 0, inCells: 9,
  wbOver: 0, updatedAt: '2026-10-07T09:00:00Z' };

// Заглушка ExcelJS: запоминаем шапку файла продавца, сам файл не пишем.
const excelStub = () => {
  window.__excel = [];
  window.ExcelJS = { Workbook: class {
    constructor() { this.xlsx = { writeBuffer: async () => new ArrayBuffer(0) }; }
    addWorksheet() {
      const cells = {};
      const cell = (r, c) => (cells[r + ':' + c] ||= {});
      const ws = { cells, pageSetup: {}, mergeCells() {}, getCell: cell, getRow: (r) => ({ getCell: (c) => cell(r, c) }), getColumn: () => ({}) };
      window.__excel.push(ws); return ws;
    }
  } };
};

(async () => {
  let browser;
  const bad = [];
  try {
    browser = await launch();

    // ---------- склад: «Товары» → «Остатки продавцов» ----------
    const owner = await open(browser, {
      api: (p) => (p === '/api/sellers/stock-summary' ? { json: { source: '1c', sellers: [seller] } } : undefined),
    });
    await owner.page.locator('#view-home.active').waitFor();
    await owner.page.evaluate(() => switchView('products'));
    await owner.page.locator('#sellersList table').waitFor();
    const ownerScreen = (await owner.page.locator('#sellersList thead th').allInnerTexts()).some((h) => /Принято WB/.test(h));
    await owner.page.evaluate(() => window.exportSellerStock());
    const ownerFile = await owner.page.evaluate(() => Object.keys((window.__xlsx[window.__xlsx.length - 1] || [])[0] || {}));
    console.log('  склад, в Excel:', ownerFile.join(' | '));
    if (!ownerScreen) throw Error('у склада на экране нет «Принято WB»');
    if (!ownerFile.includes('Принято WB')) bad.push('у склада: в Excel «Остатки продавцов» нет «Принято WB» (на экране у «Слим Тест» — 2)');

    // ---------- продавец: «Товары» → Excel ----------
    const row = { ...fx.row, acceptedByWb: 3 };
    const sel = await open(browser, { file: 'client_access.html', role: 'seller', claims: { companyId: fx.company.id },
      api: (p) => {
        if (p === '/api/sellers/stock') return { json: { rows: [row], summary: { ...fx.summary, acceptedByWb: 3 } } };
        const d = fx.apiData(p); return d === undefined ? undefined : { json: d };
      } });
    await sel.page.evaluate(excelStub);
    await sel.page.locator('#view thead th').first().waitFor();
    const sellerScreen = (await sel.page.locator('#view thead th').allInnerTexts()).some((h) => /Принято WB/.test(h));
    await sel.page.locator('[data-excel]').first().click();
    await sel.page.waitForFunction(() => window.__excel && window.__excel.length > 0);
    const sellerFile = await sel.page.evaluate(() => {
      const ws = window.__excel[window.__excel.length - 1];
      return Object.keys(ws.cells).filter((k) => k.startsWith('4:')).map((k) => ws.cells[k].value);
    });
    console.log('  продавец, в Excel:', sellerFile.join(' | '));
    if (!sellerScreen) throw Error('у продавца на экране нет «Принято WB»');
    if (!sellerFile.some((h) => /Принято WB/.test(h))) bad.push('у продавца: в Excel «Остатки» нет «Принято WB» (на экране — 3)');
  } catch (e) {
    console.error('ОШИБКА ТЕСТА', e); process.exitCode = 2;
  } finally {
    if (browser) await browser.close();
    bad.forEach((b) => console.log('  FAIL  ' + b));
    if (bad.length && process.exitCode !== 2) process.exitCode = 1;
  }
})();
