// Общие шаги проверки остатков 01.10 поверх test/attack-0110/_lib.js:
// склад с ячейками и грузчиком, приход товара, обмен с WB, поставка, отбор,
// отгрузка, остатки продавца. Только синтетические данные, тестовая база.
const L = require('../attack-0110/_lib');

async function setup({ name = 'Ромашка', source = '1c' } = {}) {
  const app = await L.startApp();
  const w = await L.warehouse(app.ok, name);
  if (source === 'argus') await app.ok('PATCH', '/api/warehouses/me', w.token, { stockSource: 'argus' });
  const worker = await w.worker('Грузчик');
  await app.ok('POST', '/api/cells/rows', w.token, { configs: [{ rackCount: 2, tierCount: 1 }] });
  const cell = (await app.ok('GET', '/api/cells/rows', w.token)).flatMap((r) => r.blocks)[0].id;
  return { ...app, w, worker, cell };
}

// Принять товар в ячейку обычным приходом.
let n = 0;
async function receive(c, companyId, sku, qty) {
  n += 1;
  const inv = await c.ok('POST', '/api/invoices', c.w.token, { companyId, number: `ПР-${Date.now()}-${n}`,
    items: [{ sku, name: `Товар ${sku}`, declaredQty: qty }] });
  await c.api('POST', `/api/receiving/session/${inv.id}/start`, c.worker, {});
  await c.ok('POST', '/api/receiving', c.worker, { invoiceItemId: inv.items[0].id, acceptedQty: qty, cellBlockId: c.cell });
}

// Число из 1С: ключ обмена, вход модуля, отправка остатков.
async function push1c(c, records) {
  if (!c.oneC) {
    const key = await c.ok('POST', '/api/sync/keys', c.w.token, { label: 'Модуль 1С' });
    c.oneC = (await c.ok('POST', '/api/sync/auth', null, { keyCode: key.key_code })).token;
  }
  return c.ok('POST', '/api/sync/push/stock', c.oneC, { records });
}

// Обмен с WB; статусы спрашиваются не чаще раза в 4 минуты — снимаем отметку.
async function syncWb(c, companyId) {
  await c.w.q('UPDATE invoices SET mp_status_attempted_at = NULL WHERE company_id = $1', [companyId]);
  return c.w.sync(companyId);
}

async function orders(c, companyId) {
  const rows = await c.w.q(`SELECT i.id, i.external_id, ii.id AS item_id FROM invoices i
    JOIN invoice_items ii ON ii.invoice_id = i.id WHERE i.company_id = $1 AND i.source = 'wb'`, [companyId]);
  return Object.fromEntries(rows.map((r) => [r.external_id, r]));
}

async function supply(c, invoiceIds) {
  const s = await c.ok('POST', '/api/supplies', c.w.token, { invoiceIds, marketplace: 'wb' });
  await c.ok('POST', `/api/shipping/assembly/${s.id}/start`, c.worker, {});
  return s.id;
}

const pick = (c, itemId, qty = 1) => c.ok('POST', '/api/shipping', c.worker, { invoiceItemId: itemId, pickedQty: qty, cellBlockId: c.cell });
const ship = (c, supplyId) => c.ok('POST', `/api/supplies/${supplyId}/ship`, c.w.token, { destination: 'СЦ' });

// Кабинет продавца: строка товара и итог.
async function sellerStock(c, sellerToken, sku) {
  const r = await c.ok('GET', '/api/sellers/stock', sellerToken);
  return { row: r.rows.find((x) => x.sku === sku) || null, summary: r.summary };
}

const nums = (row) => (row ? `всего ${row.total}, заказано ${row.ordered}, в сборке ${row.inAssembly}, в пути ${row.inTransit}, доступно ${row.available}` : 'строки нет');

module.exports = { ...L, setup, receive, push1c, syncWb, orders, supply, pick, ship, sellerStock, nums };
