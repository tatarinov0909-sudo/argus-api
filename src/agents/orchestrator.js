// Оркестратор — единственная точка входа с LLM, видимая человеку.
// Человек пишет сюда, никогда напрямую агенту. Оркестратор вызывает
// нужного агента (сейчас только Кладовщика), получает сухие факты из БД
// и превращает их в ответ. Сам ничего не решает и не считает — только
// объясняет то, что уже вычислено правилами.
const { SYSTEM_PROMPT, ALL_TOOLS, AGENT_BY_TOOL } = require('./orchestratorPrompt');

// Anthropic называет схему input_schema, DeepSeek — parameters; сам JSON Schema
// внутри один и тот же (см. orchestratorPrompt.js).
const TOOLS = ALL_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters,
}));

function textOf(response) {
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// runTool(name, args) — единственный способ дотянуться до данных; тот же
// контракт, что и в orchestratorDeepseek.js, чтобы обе версии оставались
// взаимозаменяемыми. Тесты подставляют заглушку с заранее заданными фактами.
async function ask(anthropic, dbClient, warehouseId, question, runTool) {
  if (typeof runTool !== 'function') {
    throw new Error('orchestrator.ask: не передан runTool — агенту нечем взять данные');
  }
  const messages = [{ role: 'user', content: question }];

  const first = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
  });

  if (first.stop_reason !== 'tool_use') {
    return { answer: textOf(first), steps: [] };
  }

  // Модель может вызвать инструмент несколько раз параллельно в одном ходу
  // (например, "что там с проводами и с зарядками?" — два разных запроса).
  // API требует tool_result на КАЖДЫЙ tool_use в одном следующем сообщении —
  // отправка только первого ломает запрос целиком.
  const toolUses = first.content.filter((b) => b.type === 'tool_use');
  const steps = [];
  const toolResults = await Promise.all(
    toolUses.map(async (tu) => {
      const result = await runTool(tu.name, tu.input);
      steps.push({
        agent: AGENT_BY_TOOL[tu.name] || 'Кладовщик',
        task: tu.name,
        found: Array.isArray(result) ? result.length : null,
      });
      return {
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      };
    }),
  );

  messages.push({ role: 'assistant', content: first.content });
  messages.push({ role: 'user', content: toolResults });

  const second = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
  });

  // Модель теоретически может запросить инструмент и на втором ходу — этот
  // слой второй раунд не поддерживает, честно говорим об этом, а не отдаём
  // пустой ответ.
  return {
    answer: textOf(second) || 'Не удалось до конца сформулировать ответ — уточните вопрос.',
    steps,
  };
}

module.exports = { ask };
