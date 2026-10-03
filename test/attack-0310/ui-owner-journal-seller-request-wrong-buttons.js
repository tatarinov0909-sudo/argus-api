// Экран: кабинет руководителя → «Журнал действий». Заявка продавца на перенос
// между его складами («очень важно», ждёт решения) показывается с кнопками
// отметки грузчика «нет товара»: «Понятно» и «Товар нашёлся». «Понятно»
// (окно «Отметить, что вы в курсе? Заказ остаётся в работе…») на деле
// ВЫПОЛНЯЕТ перенос, «Товар нашёлся» («Отметка закроется, и грузчик соберёт
// позицию как обычно») — ОТКАЗЫВАЕТ продавцу, и продавцу приходит «отказано
// (товар нашёлся, собирать как обычно — Продавец … просит перенести …)».
// Проверено на стенде 03.10: ПЕР-031026-2, снимки owner-journal-*.png.
//
// Документ: «Виртуальные склады — схема.md» — заявки продавцов на перенос в
// журнале; src/journal/routes.js: «Подтвердить» выполняет перенос,
// «Отклонить» — отказ. Место: cabinet_main.js, urgentActionsHtml/resolveUrgent
// — все «очень важно» считаются отметками «нет товара».
// Запуск: ARGUS_PLAYWRIGHT_MODULE=<путь к playwright> node <файл>.
const { openPage, browser, fakeToken } = require('./_ui');

const entry = {
  id: '44444444-4444-4444-4444-444444444444', agent: 'Кладовщик', status: 'pending', urgent: true, answered: false,
  entity_type: 'vw_transfer', entity_id: '55555555-5555-5555-5555-555555555555', category: 'warehouse', category_label: 'Склад и ячейки',
  action_text: 'Продавец «Авезов ИП (тест)» просит перенести «Каша овсяная с ягодами, 10 порций», 2 шт.: «Остальной товар» → «Озон» (заявка ПЕР-031026-2).',
  actor_type: 'seller', created_at: new Date().toISOString(), invoice_id: null, invoice_supply_id: null, cell_block_id: null,
};
const apiData = (p) => {
  if (p === '/api/warehouses/me') return { id: 'wh', name: 'Восход', city: 'Москва', warehouse_code: '0001', setup_at: '2026-09-30T00:00:00Z',
    stock_source: '1c', timezone: 'Europe/Moscow', wb_supplies_by: 'ff', wb_names: [], vw_reminders: true };
  if (p === '/api/journal') return [entry];
  if (p === '/api/sync/status') return {};
  return undefined;
};

(async () => {
  const b = await browser();
  try {
    const page = await b.newPage({ viewport: { width: 1440, height: 1000 } });
    await openPage(page, { file: 'cabinet_main.html', role: 'owner', token: fakeToken({ role: 'owner', ownerName: 'Тест', warehouseId: 'wh' }), apiData });
    await page.evaluate(() => window.switchView && window.switchView('journal'));
    const card = page.locator('.j-entry', { hasText: 'просит перенести' }).first();
    await card.waitFor({ timeout: 15000 });
    const actions = (await card.locator('.staff-action').allInnerTexts()).map((t) => t.trim());
    const ok = !actions.some((t) => /Товар нашёлся|Понятно/.test(t));
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  у заявки продавца на перенос — кнопки переноса, а не отметки «нет товара»`
      + (ok ? '' : `\n        ожидалось: «Выполнить» / «Отказать» (или «Подтвердить» / «Отклонить»)\n        получили:  ${actions.map((t) => `«${t}»`).join(', ')}`));
    if (!ok) process.exitCode = 1;
  } finally {
    await b.close();
  }
})().catch((err) => { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; });
