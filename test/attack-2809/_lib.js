// Общие заготовки для проверки работы 27–28.09.2026 (независимая атака).
// Сервер и склад — из ../attack-helpers.js; здесь только сверка «ожидалось по
// требованию — получили» и админское подключение для подготовки старых данных.
const { startApp, warehouse, assert } = require('../attack-helpers');

// Находка — не исключение на первой же проверке, а список: тест прогоняет
// сценарий до конца и печатает каждое расхождение с требованием.
function verdicts(title) {
  const bad = [];
  let good = 0;
  return {
    expect(label, ok, expected, got) {
      if (ok) { good += 1; console.log(`  ok    ${label}`); return; }
      bad.push(label);
      console.log(`  FAIL  ${label}\n        ожидалось: ${expected}\n        получили:  ${got}`);
    },
    done() {
      console.log(`\n${title}: ${good} выдержало, ${bad.length} нарушений`);
      if (bad.length) process.exitCode = 1;
    },
  };
}

// Подготовка «старых данных» (приёмка без ячейки до 28.09, давняя укладка) —
// то, чего нынешний API сделать уже не даёт. Только на тестовой базе.
async function admin(sql, params = []) {
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url || !/\/argus_seller_test_/.test(url)) throw Error('Нужен ADMIN_DATABASE_URL на тестовую базу');
  const { Client } = require('pg');
  const c = new Client({ connectionString: url });
  await c.connect();
  try { return (await c.query(sql, params)).rows; } finally { await c.end(); }
}

// Склад с продавцом, товарами, рядом ячеек (стеллажи 1..racks, ярус 1) и
// грузчиками. cell(n) — ячейка «1.n.1».
async function setup(ok, { skus = [['A-1', 'Зефир']], racks = 4, workers = ['Джоник'] } = {}) {
  const wh = await warehouse(ok, 'a2809');
  const company = await wh.company('Продавец атаки');
  for (const [sku, name] of skus) await ok('POST', '/api/products', wh.token, { sku, name, companyId: company });
  const blocks = await wh.cells([{ rackCount: racks, tierCount: 1 }]);
  const cell = (n) => blocks.find((b) => b.rack_start === n).id;
  const staff = {};
  for (const name of workers) staff[name] = await wh.worker(name);
  const invoice = (number, items) => ok('POST', '/api/invoices', wh.token, {
    companyId: company, number, items: items.map(([sku, name, declaredQty]) => ({ sku, name, declaredQty })),
  });
  return { ...wh, company, cell, staff, invoice };
}

module.exports = { startApp, setup, verdicts, admin, assert };
