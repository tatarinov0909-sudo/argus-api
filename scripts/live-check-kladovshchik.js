// Живая проверка Кладовщика как агента: настоящая модель, настоящая база,
// настоящий диспетчер инструментов — ровно то, что работает на проде.
// Автотесты проверяют правила, а это проверяет выбор инструмента и цену.
//
//   DATABASE_URL=... JWT_SECRET=test node scripts/live-check-kladovshchik.js
require('dotenv').config();
const { withTenantContext } = require('../src/db/pool');
const kladovshchik = require('../src/agents/kladovshchik');
const { ask } = require('../src/agents/orchestratorDeepseek');

const QUESTIONS = [
  ['поиск товара', 'Где лежит PB-LIME и сколько его?'],
  ['состояние склада', 'Насколько склад заполнен?'],
  ['документы', 'Какие накладные сейчас не закрыты?'],
  ['конкретный документ', (n) => `Что в накладной ${n}?`],
  ['возвраты', 'Что вернулось и сколько из этого брак?'],
  ['расхождения', 'Есть расхождения, которые ждут моего решения?'],
  ['куда положить', 'Куда положить PB-LIME?'],
  ['вне темы', 'Напиши мне функцию сортировки на Python.'],
];

async function main() {
  const warehouseId = process.env.WAREHOUSE_ID;
  const invoiceNumber = process.env.INVOICE_NUMBER;
  if (!warehouseId) throw new Error('WAREHOUSE_ID не задан');
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY не задан');

  const runTool = (name, args) => withTenantContext({ warehouseId }, (client) => (
    kladovshchik.runTool(client, warehouseId, name, args)
  ));

  for (const [label, q] of QUESTIONS) {
    const question = typeof q === 'function' ? q(invoiceNumber) : q;
    const started = Date.now();
    let res;
    try {
      res = await ask(process.env.DEEPSEEK_API_KEY, null, warehouseId, question, runTool);
    } catch (err) {
      console.log(`\n[${label}] ОШИБКА: ${err.message}`);
      continue;
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const tools = res.steps.map((s) => s.task).join(', ') || '— (без инструментов)';
    console.log(`\n--- ${label} · ${secs} с ---`);
    console.log(`Вопрос:      ${question}`);
    console.log(`Инструменты: ${tools}`);
    console.log(`Ответ:       ${res.answer.replace(/\n/g, '\n             ')}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
