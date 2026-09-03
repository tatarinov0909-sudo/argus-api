// Оркестратор на DeepSeek — та же роль и тот же промпт, что и в orchestrator.js
// (Claude), другой клиент. Существует РЯДОМ с Claude-версией для честного
// сравнения на одном и том же тестовом наборе, не вместо неё.
//
// DeepSeek говорит по OpenAI-совместимому Chat Completions API — обычный
// POST, встроенного fetch (Node 20+) достаточно, новая зависимость не нужна.
// В отличие от @anthropic-ai/sdk, голый fetch не даёт таймаут и ретраи сам —
// добавлено вручную ниже.
const { HttpError } = require('../middleware/errorHandler');
const { SYSTEM_PROMPT, ALL_TOOLS, AGENT_BY_TOOL } = require('./orchestratorPrompt');


const API_URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-v4-flash'; // дешёвый/быстрый уровень — аналог Haiku, задача та же: пересказать факты
const MAX_TOKENS = 1024; // тот же потолок, что у Claude-версии
const TIMEOUT_MS = 20000; // держать транзакцию БД (см. routes.js) открытой дольше — риск, не удобство

const TOOLS = ALL_TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

// Фраза для строки «Передаю задачу — Кладовщик: …» в чате. Собирается здесь, а
// не на фронте: только сервер знает, какой инструмент чем занимался, и «найти
// «состояние склада»» было бы неправдой.
function taskLabel(name, args) {
  switch (name) {
    case 'find_products': return `найти «${args.query}»`;
    case 'suggest_cell': return `подобрать ячейку для «${args.sku}»`;
    case 'invoice_details': return `посмотреть накладную «${args.number}»`;
    case 'warehouse_summary': return 'проверить состояние склада';
    case 'list_discrepancies': return 'собрать расхождения';
    case 'pick_list': return 'собрать лист грузчика';
    case 'list_invoices': {
      const kind = { in: 'приёмки', out: 'отгрузки', return: 'возвраты' }[args.direction];
      return kind ? `посмотреть ${kind}` : 'посмотреть накладные';
    }
    default: return name;
  }
}

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
// runTool(name, args) — единственный способ агента дотянуться до данных. Роутер
// передаёт сюда функцию, которая на каждый вызов открывает свою короткую
// транзакцию (см. routes.js), а тесты — заглушку с заранее заданными фактами.
async function ask(apiKey, dbClient, warehouseId, question, runTool, history = []) {
  if (typeof runTool !== 'function') {
    throw new Error('orchestrator.ask: не передан runTool — агенту нечем взять данные');
  }
  // История идёт перед вопросом — именно она позволяет спросить «а в каком
  // ряду?» вторым сообщением, не повторяя артикул. Дальше по коду в messages
  // дописываются ходы модели и результаты агентов, поэтому история обязана
  // лежать в самом начале.
  const messages = [...history, { role: 'user', content: question }];

  // Вопрос вроде «что вернулось и сколько из этого брак» решается в два шага:
  // сначала список возвратов, потом заглянуть внутрь. Раньше слой умел ровно
  // один заход, и такой вопрос честно упирался в «не удалось сформулировать».
  // Больше двух заходов не нужно и опасно: каждый — это ещё один платный вызов.
  const MAX_ROUNDS = 3;
  const steps = [];

  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const response = await callDeepseek(apiKey, messages);
    const message = response.choices[0].message;

    if (!message.tool_calls || message.tool_calls.length === 0) {
      // Инструменты больше не нужны — это и есть ответ человеку. Если шагов не
      // было вовсе, в чате не появится «передал Кладовщику»: он никому ничего
      // не передавал.
      return {
        answer: message.content || 'Не удалось сформулировать ответ — переформулируйте вопрос.',
        steps,
      };
    }

    // Модель может вызвать инструмент несколько раз за один ход (например,
    // «что там с проводами и с зарядками?» — два разных запроса). Результат
    // нужен на КАЖДЫЙ вызов, иначе DeepSeek отклонит следующий запрос целиком —
    // выполняем их параллельно.
    messages.push(message);
    const toolResults = await Promise.all(
      message.tool_calls.map(async (call) => {
        let args;
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          console.error('DeepSeek: битый JSON в аргументах вызова', call.function.arguments);
          return { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'некорректный запрос' }) };
        }
        const result = await runTool(call.function.name, args);
        steps.push({
          agent: AGENT_BY_TOOL[call.function.name] || 'Кладовщик',
          task: taskLabel(call.function.name, args),
          found: Array.isArray(result) ? result.length : null,
        });
        return { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) };
      }),
    );
    messages.push(...toolResults);
  }

  // Круги кончились, а модель всё ещё просит инструменты. Просим её ответить
  // тем, что уже собрано, — это дешевле и честнее, чем отдать заглушку.
  const last = await callDeepseek(apiKey, [
    ...messages,
    { role: 'user', content: 'Ответь по уже собранным данным, больше ничего не запрашивай.' },
  ]);
  return {
    answer: last.choices[0].message.content || 'Не удалось до конца сформулировать ответ — уточните вопрос.',
    steps,
  };
}

module.exports = { ask };
