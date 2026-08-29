// Переписка человека с агентами: чтение и запись.
//
// Хранится по паре «склад + автор». Склад — потому что так устроена вся
// изоляция данных; автор — потому что склад у владельца и работников общий,
// а разговор у каждого свой.

// Сколько прошлых сообщений отдаём модели. Не «сколько храним» — храним всё,
// это дешёвая таблица и живая история действий.
//
// Восемь — это примерно четыре пары «вопрос-ответ». Хватает, чтобы уточнить
// «а в каком ряду?» или «покажи остальные», и не хватает, чтобы разговор начал
// стоить дороже самого вопроса: каждое сообщение в истории оплачивается заново
// на КАЖДОМ обращении, кэш её не покрывает — в отличие от системного промпта,
// который повторяется дословно.
const HISTORY_DEPTH = 8;

// Длинный ответ агента в истории не нужен целиком: модели достаточно понять,
// о чём шла речь. Обрезаем, чтобы одна простыня с полусотней ячеек не съедала
// весь бюджет следующих вопросов.
const MAX_STORED_IN_CONTEXT = 600;

// Кто автор: у владельца это его id, у работника — id его ключа. Ключ можно
// отозвать, поэтому внешнего ключа на него нет (см. миграцию).
function authorIdFromAuth(auth) {
  return auth.role === 'owner' ? auth.ownerId : auth.staffKeyId;
}

async function loadRecent(client, warehouseId, authorId, limit = HISTORY_DEPTH) {
  const result = await client.query(
    `SELECT role, agent, text, steps, created_at
     FROM chat_messages
     WHERE warehouse_id = $1 AND author_id = $2
     ORDER BY created_at DESC, id DESC
     LIMIT $3`,
    [warehouseId, authorId, limit],
  );
  // Из базы приходит новое сверху — модели и экрану нужен обычный порядок.
  return result.rows.reverse();
}

async function save(client, warehouseId, authorId, message) {
  const result = await client.query(
    `INSERT INTO chat_messages (warehouse_id, author_id, role, agent, text, steps)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, role, agent, text, steps, created_at`,
    [
      warehouseId, authorId, message.role, message.agent || null, message.text,
      message.steps ? JSON.stringify(message.steps) : null,
    ],
  );
  return result.rows[0];
}

// История в том виде, в каком её понимает модель. Ответы агентов идут как
// assistant, вопросы человека — как user; кто именно из агентов отвечал, для
// модели значения не имеет, ей важно только содержание разговора.
function toModelMessages(rows) {
  return rows.map((r) => ({
    role: r.role === 'user' ? 'user' : 'assistant',
    content: String(r.text).slice(0, MAX_STORED_IN_CONTEXT),
  }));
}

module.exports = { loadRecent, save, toModelMessages, authorIdFromAuth, HISTORY_DEPTH };
