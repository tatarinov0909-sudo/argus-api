// Экран: кабинет руководителя → «Остатки продавцов» → продавец → «Перенести»
// на склад «хранить отдельно» («Озон»). Сервер на такой перенос создаёт
// задание грузчику «переложить» (статус «грузчик перекладывает»), остатки
// складов не меняются, пока грузчик не переложит. А экран:
//   1) в окне пишет «Товар остаётся в тех же ячейках — меняется только, за
//      каким складом он числится»;
//   2) после нажатия — «Перенесено: Остальной товар → Озон, 2 шт.»;
//   3) в блоке «Переносы ждут решения» такой перенос подписан «ждёт согласия
//      продавца — он запретил складу решать такое без него» — неправда:
//      продавец ничего не запрещал, ждёт грузчик.
// Проверено на стенде 03.10 (ПЕР-031026-1): снимки owner-transfer-*.png,
// owner-transfers-wrong-status-1440.png.
//
// Документ: «Виртуальные склады — схема.md», этап 3, вопрос 3. Место:
// cabinet_main.js — openTransfer (текст окна и всплывающее сообщение),
// renderProducts (подпись статуса: всё, что не «requested», — «ждёт согласия
// продавца»).
// Запуск: ARGUS_PLAYWRIGHT_MODULE=<путь к playwright> node <файл>.
const { openPage, browser, fakeToken } = require('./_ui');

const company = { id: '11111111-1111-1111-1111-111111111111', name: 'Авезов ИП (тест)', keys: [], created_at: '2026-09-02T00:00:00Z' };
const ozon = { id: '22222222-2222-2222-2222-222222222222', name: 'Озон', marketplace: 'ozon', marketplaceName: 'Озон',
  keepSeparate: true, defectSeparate: false, archivedAt: null, createdAt: '2026-10-02T19:24:06Z', zone: { cells: 0, empty: 0, rows: [], labels: [], text: '' } };
const row = {
  sku: 'R-1', name: 'Гранола шоколадная 400 г', listed: true, barcode: '4610000087109', total: 75, totalKnown: true,
  orderedNotInSupply: 0, inAssembly: 0, inTransit: 0, sellerAvailable: 75, qty: 75, notForSale: 0, staged: 0, cells: 1,
  defective: 0, packagingDefect: 0, shortage: false,
  byWarehouse: [{ id: ozon.id, name: 'Озон', onHand: 3, inAssembly: 0, available: 3, defect: 0 },
    { id: null, name: 'Остальной товар', onHand: 72, inAssembly: 0, available: 72, defect: 0 }],
};
const toMove = { id: '66666666-6666-6666-6666-666666666666', number: 'ПЕР-031026-1', sku: 'R-1', name: row.name, qty: 2,
  fromVw: null, fromName: 'Остальной товар', toVw: ozon.id, toName: 'Озон', note: null, status: 'to_move',
  statusName: 'грузчик перекладывает', requestedRole: 'owner', requestedName: 'Руководитель склада' };
let posted = false;
const apiData = (p, u, req) => {
  if (p === '/api/warehouses/me') return { id: 'wh', name: 'Восход', city: 'Москва', warehouse_code: '0001', setup_at: '2026-09-30T00:00:00Z',
    stock_source: 'argus', timezone: 'Europe/Moscow', wb_supplies_by: 'ff', wb_names: [], vw_reminders: true };
  if (p === '/api/sellers/companies') return [company];
  if (p === '/api/sellers/stock-summary') return { source: 'argus', sellers: [{ companyId: company.id, name: company.name, productCount: 1, total: 75,
    ordered: 0, inAssembly: 0, inTransit: 0, available: 75, defect: 0, shortageCount: 0, unknownCount: 0, unknownNames: [], inCells: 75 }] };
  if (p === '/api/sellers/stock') return [row];
  if (p === '/api/vwarehouses') return { main: { id: null, name: 'Остальной товар' }, warehouses: [ozon], rights: { decide: true },
    wbChoices: [{ id: null, name: 'Остальной товар' }] };
  if (p === '/api/vwarehouses/transfers' && req.method() === 'POST') { posted = true; return toMove; }
  if (p === '/api/vwarehouses/transfers') return posted ? [toMove] : [];
  if (p === '/api/vwarehouses/decisions') return [];
  if (p === '/api/sync/status') return {};
  return undefined;
};

(async () => {
  const b = await browser();
  let bad = 0;
  const say = (ok, label, exp, got) => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}` + (ok ? '' : `\n        ожидалось: ${exp}\n        получили:  ${got}`));
    if (!ok) bad += 1;
  };
  try {
    const page = await b.newPage({ viewport: { width: 1440, height: 1000 } });
    await openPage(page, { file: 'cabinet_main.html', role: 'owner', token: fakeToken({ role: 'owner', ownerName: 'Тест', warehouseId: 'wh' }), apiData });
    await page.evaluate(() => window.switchView && window.switchView('products'));
    await page.waitForTimeout(800);
    await page.evaluate((id) => window.openSellerProducts(id), company.id);
    await page.locator('#productsList .stock-move').first().waitFor({ timeout: 15000 });
    await page.evaluate(() => window.openTransfer('R-1'));
    await page.locator('.ask-box #trTo').waitFor();
    await page.evaluate((id) => { document.getElementById('trFrom').value = 'main'; document.getElementById('trTo').value = id; }, ozon.id);
    await page.fill('#trQty', '2');
    const text = await page.locator('.ask-box .ask-text').innerText();
    say(!/остаётся в тех же ячейках/.test(text), 'окно переноса на «хранить отдельно» не обещает «товар остаётся в тех же ячейках»',
      'сказано, что грузчик переложит товар', text);
    await page.locator('.ask-box .ask-ok').click();
    const toast = await page.waitForFunction(() => {
      const t = [...document.querySelectorAll('[class*=toast]')].map((x) => x.innerText.trim()).filter(Boolean);
      return t.length ? t.join(' | ') : null;
    }, null, { timeout: 5000 }).then((h) => h.jsonValue());
    say(!/^Перенесено/.test(toast), 'после нажатия не пишет «Перенесено», пока грузчик не переложил',
      '«Грузчику создано задание переложить…»', toast);
    await page.waitForFunction(() => document.getElementById('productsTransfers').innerText.includes('ПЕР-031026-1'), null, { timeout: 5000 });
    const pending = await page.locator('#productsTransfers').innerText();
    say(!/запретил складу решать/.test(pending), 'перенос «грузчик перекладывает» не подписан «ждёт согласия продавца — он запретил…»',
      '«грузчик перекладывает»', pending.replace(/\s+/g, ' '));
  } finally {
    await b.close();
  }
  if (bad) process.exitCode = 1;
})().catch((err) => { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; });
