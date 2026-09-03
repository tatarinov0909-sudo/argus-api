// Тестовый прогон Оркестратора (Claude) на заранее заданных фактах — без
// обращения к базе. Проверяет не SQL, а поведение LLM-слоя: не выдумывает
// ли данные, не путает ли задачу. Кейсы — в orchestrator-test-cases.js,
// общие с DeepSeek-раннером (test-orchestrator-deepseek.js).
//
// Запуск: node scripts/test-orchestrator.js [подстрока имени кейса]
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { ask } = require('../src/agents/orchestrator');
const { CASES, check } = require('./orchestrator-test-cases');

const anthropic = new Anthropic();

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY не задан в .env');
    process.exit(1);
  }

  const filter = process.argv[2];
  const cases = filter ? CASES.filter((c) => c.name.includes(filter)) : CASES;

  let passed = 0;
  for (const c of cases) {
    const stubFind = async () => c.mockResults;
    let answer;
    try {
      ({ answer } = await ask(anthropic, null, null, c.question, stubFind));
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

  console.log(`\n=== Claude: ${passed}/${cases.length} прошли автоматическую проверку ===`);
}

main();
