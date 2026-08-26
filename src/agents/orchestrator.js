// Оркестратор — единственная точка входа с LLM, видимая человеку.
// Человек пишет сюда, никогда напрямую агенту. Оркестратор вызывает
// нужного агента (сейчас только Кладовщика), получает сухие факты из БД
// и превращает их в ответ. Сам ничего не решает и не считает — только
// объясняет то, что уже вычислено правилами.
const kladovshchik = require('./kladovshchik');
const { SYSTEM_PROMPT, FIND_PRODUCTS_TOOL } = require('./orchestratorPrompt');

const TOOLS = [{
  name: FIND_PRODUCTS_TOOL.name,
  description: FIND_PRODUCTS_TOOL.description,
  input_schema: FIND_PRODUCTS_TOOL.parameters,
}];

function textOf(response) {
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// findFn — параметр для тестов: подставляют заглушку вместо реального
// kladovshchik.findProducts, чтобы проверять поведение объяснения на
// заранее заданных фактах, без обращения к базе.
async function ask(anthropic, dbClient, warehouseId, question, findFn = kladovshchik.findProducts) {
  const messages = [{ role: 'user', content: question }];

  const first = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
  });

  if (first.stop_reason !== 'tool_use') {
    return textOf(first);
  }

  // Модель может вызвать инструмент несколько раз параллельно в одном ходу
  // (например, "что там с проводами и с зарядками?" — два разных запроса).
  // API требует tool_result на КАЖДЫЙ tool_use в одном следующем сообщении —
  // отправка только первого ломает запрос целиком.
  const toolUses = first.content.filter((b) => b.type === 'tool_use');
  const toolResults = await Promise.all(
    toolUses.map(async (tu) => ({
      type: 'tool_result',
      tool_use_id: tu.id,
      content: JSON.stringify(await findFn(dbClient, warehouseId, tu.input.query)),
    })),
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
  return textOf(second) || 'Не удалось до конца сформулировать ответ — уточните вопрос.';
}

module.exports = { ask };
