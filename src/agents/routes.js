const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const kladovshchik = require('./kladovshchik');
const chatHistory = require('./chatHistory');
// ЖИВАЯ модель — сейчас DeepSeek. Если возвращаетесь на orchestrator.js
// (Claude), первый аргумент ask() ниже — уже не строка ключа, а клиент
// Anthropic SDK. Обе версии называют функцию одинаково (ask), поэтому
// смена require здесь без правки вызова ниже пройдёт все проверки типов
// и упадёт только при реальном запросе.
const orchestrator = require('./orchestratorDeepseek');

const router = express.Router();

// Owner/staff only — a seller has no warehouseId in their token (RLS scopes
// them by companyId instead, see tenantContext.js), and this tool is about
// physical cell locations, which a seller has no reason to query anyway.
router.get('/kladovshchik/find', requireAuth, requireRole('owner', 'worker'), async (req, res, next) => {
  try {
    const q = req.query.q?.trim();
    if (!q) throw new HttpError(400, 'Укажите ?q= — что искать');

    const { warehouseId } = req.auth;
    const results = await withTenantContext({ warehouseId }, (client) => (
      kladovshchik.findProducts(client, warehouseId, q)
    ));
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// Подсказка ячейки при приёмке — чистое правило (см. kladovshchik.suggestCells),
// без ИИ. Тот же доступ, что и у find: владелец и работник склада.
router.get('/kladovshchik/suggest-cell', requireAuth, requireRole('owner', 'worker'), async (req, res, next) => {
  try {
    const sku = req.query.sku?.trim();
    if (!sku) throw new HttpError(400, 'Укажите ?sku= — для какого товара подобрать ячейку');
    // Компания необязательна, но с ней подсказка идёт туда, где у этого
    // продавца уже сложилась зона, а не куда попало.
    const companyId = req.query.companyId?.trim() || null;

    const { warehouseId, staffKeyId } = req.auth;
    const result = await withTenantContext({ warehouseId }, async (client) => {
      const options = await kladovshchik.suggestCells(client, warehouseId, sku, companyId);
      // Что предложили — записываем сразу: потом эту же подсказку уже не
      // пересчитать, склад изменится.
      const suggestionId = await kladovshchik.recordSuggestion(client, warehouseId, {
        sku, companyId, workerKeyId: staffKeyId, options,
      });
      return { options, suggestionId };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Единственная точка входа для человека — он пишет сюда, никогда напрямую
// агенту.
//
// ТОЛЬКО ВЛАДЕЛЕЦ. Работник склада к чату доступа не имеет — это решение о
// продукте, а не недоделанный интерфейс: руки заняты, телефон в держателе,
// печатать некогда. До работника агент доходит подсказками прямо в экране
// приёмки и отбора (loader.html), и если ему что-то понадобится спросить —
// это будет кнопка, а не переписка. Раньше здесь стояла и роль worker, хотя
// экрана для неё не существовало: дверь без ручки, но незапертая.
router.post('/orchestrator/ask', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const question = req.body?.question?.trim();
    if (!question) throw new HttpError(400, 'Укажите question — вопрос к Оркестратору');
    if (!process.env.DEEPSEEK_API_KEY) throw new HttpError(500, 'DEEPSEEK_API_KEY не настроен на сервере');

    const { warehouseId } = req.auth;
    const authorId = chatHistory.authorIdFromAuth(req.auth);

    // Историю читаем ДО обращения к модели и отдельной короткой транзакцией —
    // по той же причине, что и вызовы инструментов ниже: соединение с базой не должно
    // висеть открытым, пока мы ждём ответа по сети.
    const past = await withTenantContext({ warehouseId }, (client) => (
      chatHistory.loadRecent(client, warehouseId, authorId)
    ));

    // Каждый вызов инструмента открывает свою короткую транзакцию — БД-соединение
    // не держится открытым на время внешних HTTP-вызовов к DeepSeek (которые
    // могут идти секундами); иначе под конкурентной нагрузкой это вычерпывает
    // пул соединений и останавливает вообще все остальные ручки.
    //
    // Что именно выполнится по имени инструмента — решает kladovshchik.runTool,
    // не модель: имя не из списка просто не выполняется.
    const runTool = (name, args) => withTenantContext({ warehouseId }, (client) => (
      kladovshchik.runTool(client, warehouseId, name, args)
    ));

    const { answer, steps } = await orchestrator.ask(
      process.env.DEEPSEEK_API_KEY, null, warehouseId, question, runTool,
      chatHistory.toModelMessages(past),
    );

    // Записываем обе реплики только после успешного ответа. Если модель не
    // ответила, вопрос в истории не остаётся: иначе следующий разговор начнётся
    // с реплики, на которую никто ничего не сказал.
    const agent = steps.length === 1 ? steps[0].agent : 'Оркестратор';
    await withTenantContext({ warehouseId }, async (client) => {
      await chatHistory.save(client, warehouseId, authorId, { role: 'user', text: question });
      await chatHistory.save(client, warehouseId, authorId, {
        role: 'agent', agent, text: answer, steps,
      });
    });

    res.json({ answer, steps });
  } catch (err) {
    next(err);
  }
});

// Переписка для показа при открытии вкладки: без неё чат каждый раз начинался
// с чистого экрана, даже если разговор был минуту назад. Владельцу — по той же
// причине, что и сам чат выше.
router.get('/chat', requireAuth, requireRole('owner'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const authorId = chatHistory.authorIdFromAuth(req.auth);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const messages = await withTenantContext({ warehouseId }, (client) => (
      chatHistory.loadRecent(client, warehouseId, authorId, limit)
    ));
    res.json(messages);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
