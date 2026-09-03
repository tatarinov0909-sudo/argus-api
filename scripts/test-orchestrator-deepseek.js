// Тот же тестовый прогон, что test-orchestrator.js, но на DeepSeek —
// одинаковые кейсы (orchestrator-test-cases.js), для честного сравнения.
//
// Запуск: node scripts/test-orchestrator-deepseek.js [подстрока имени кейса]
require('dotenv').config();
const { ask } = require('../src/agents/orchestratorDeepseek');
const { CASES, check } = require('./orchestrator-test-cases');

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY не задан в .env');
    process.exit(1);
  }

  const filter = process.argv[2];
  const cases = filter ? CASES.filter((c) => c.name.includes(filter)) : CASES;

  let passed = 0;
  for (const c of cases) {
    const stubFind = async () => c.mockResults;
    let answer;
    try {
      ({ answer } = await ask(process.env.DEEPSEEK_API_KEY, null, null, c.question, stubFind));
    } catch (e) {
      console.log(`\n[ОШИБКА] ${c.name}: ${e.message}`);
      continue;
    }
    const problems = check(c, answer);
    const status = problems.length === 0 ? 'PASS' : 'FAIL';
    if (status === 'PASS') passed++;

    console.log(`\n--- ${status} · ${c.name} ---`);
    console.log(`Вопрос: ${c.question}`);
    console.log(`Ответ:  ${answer}`);
    if (problems.length) console.log(`Проблемы: ${problems.join('; ')}`);
  }

  console.log(`\n=== DeepSeek: ${passed}/${cases.length} прошли автоматическую проверку ===`);
}

main();
