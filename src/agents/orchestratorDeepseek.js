// Оркестратор на DeepSeek — та же роль и тот же промпт, что и в orchestrator.js
// (Claude), другой клиент. Существует РЯДОМ с Claude-версией для честного
// сравнения на одном и том же тестовом наборе, не вместо неё.
//
// DeepSeek говорит по OpenAI-совместимому Chat Completions API — обычный
// POST, встроенного fetch (Node 20+) достаточно, новая зависимость не нужна.
// В отличие от @anthropic-ai/sdk, голый fetch не даёт таймаут и ретраи сам —
// добавлено вручную ниже.
const kladovshchik = require('./kladovshchik');
const { HttpError } = require('../middleware/errorHandler');
const { SYSTEM_PROMPT, FIND_PRODUCTS_TOOL } = require('./orchestratorPrompt');

// Имя инструмента → имя агента, который за ним стоит. Человеку в чате нужно
// имя агента, а не название функции.
const AGENT_BY_TOOL = { [FIND_PRODUCTS_TOOL.name]: 'Кладовщик' };

const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-flash'; // дешёвый/быстрый уровень — аналог Haiku, задача та же: пересказать факты
const MAX_TOKENS = 1024; // тот же потолок, что у Claude-версии
const TIMEOUT_MS = 20000; // держать транзакцию БД (см. routes.js) открытой дольше — риск, не удобство

const TOOLS = [{
  type: 'function',
  function: {
    name: FIND_PRODUCTS_TOOL.name,
    description: FIND_PRODUCTS_TOOL.description,
    parameters: FIND_PRODUCTS_TOOL.parameters,
  },
}];

async function callDeepseek(apiKey, messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        tools: TOOLS,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new HttpError(504, 'Оркестратор не ответил вовремя, попробуйте ещё раз');
    }
    throw new HttpError(502, 'Не удалось связаться с сервисом объяснений');
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    // Тело ответа DeepSeek может содержать внутренние детали — в лог, не в
    // ответ клиенту. 429 стоит явно отличать: это "подождите", а не поломка.
    const body = await res.text().catch(() => '');
    console.error(`DeepSeek ${res.status}: ${body}`);
    if (res.status === 429) {
      throw new HttpError(429, 'Слишком много запросов, попробуйте через минуту');
    }
    throw new HttpError(502, 'Сервис объяснений временно недоступен');
  }

  const data = await res.json();
  if (!data.choices?.[0]?.message) {
    console.error('DeepSeek: ответ без choices/message', JSON.stringify(data));
    throw new HttpError(502, 'Сервис объяснений вернул пустой ответ');
  }
  return data;
}

// Возвращает { answer, steps }.
//
// steps — то, что Оркестратор решил на первом ходу: какому агенту он передал
// задачу и с каким запросом. Это НЕ дополнительный вызов модели: решение уже
// принято внутри первого обращения, мы просто перестали его выбрасывать.
// Показать работу агентов в чате не стоит ни одного лишнего токена.
//
// findFn — тот же параметр для тестов, что и в orchestrator.js: заглушка
// вместо реального kladovshchik.findProducts, чтобы проверять поведение
// объяснения на заранее заданных фактах, без обращения к базе.
async function ask(apiKey, dbClient, warehouseId, question, findFn = kladovshchik.findProducts, history = []) {
  // История идёт перед вопросом — именно она позволяет спросить «а в каком
  // ряду?» вторым сообщением, не повторяя артикул. Дальше по коду в messages
  // дописываются ходы модели и результаты агентов, поэтому история обязана
  // лежать в самом начале.
  const messages = [...history, { role: 'user', content: question }];

  const first = await callDeepseek(apiKey, messages);
  const firstMessage = first.choices[0].message;

  if (!firstMessage.tool_calls || firstMessage.tool_calls.length === 0) {
    // Ни один агент не понадобился — Оркестратор ответил сам. Шагов нет, и
    // придумывать их не надо: в чате не должно появиться «передал Кладовщику»,
    // если он никому ничего не передавал.
    return {
      answer: firstMessage.content || 'Не удалось сформулировать ответ — переформулируйте вопрос.',
      steps: [],
    };
  }

  // Модель может вызвать инструмент несколько раз за один ход (например,
  // "что там с проводами и с зарядками?" — два разных запроса). Результат
  // нужен на КАЖДЫЙ вызов, иначе DeepSeek отклонит следующий запрос целиком —
  // выполняем их параллельно, как и в Claude-версии для того же случая.
  messages.push(firstMessage);
  const steps = [];
  const toolResults = await Promise.all(
    firstMessage.tool_calls.map(async (call) => {
      let args;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        console.error('DeepSeek: битый JSON в аргументах вызова', call.function.arguments);
        return { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'некорректный запрос' }) };
      }
      const result = await findFn(dbClient, warehouseId, args.query);
      steps.push({
        agent: AGENT_BY_TOOL[call.function.name] || call.function.name,
        query: args.query,
        found: Array.isArray(result) ? result.length : null,
      });
      return { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) };
    }),
  );
  messages.push(...toolResults);

  const second = await callDeepseek(apiKey, messages);
  const secondContent = second.choices[0].message.content;
  // Модель теоретически может запросить инструмент и на втором ходу — этот
  // слой второй раунд не поддерживает, честно говорим об этом, а не отдаём
  // пустой ответ.
  return {
    answer: secondContent || 'Не удалось до конца сформулировать ответ — уточните вопрос.',
    steps,
  };
}

module.exports = { ask };
