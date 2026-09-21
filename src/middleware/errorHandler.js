function errorHandler(err, req, res, _next) {
  req.log?.error({ err }, 'request failed');

  if (err.status) {
    return res.status(err.status).json({ error: err.message });
  }
  // Postgres unique_violation
  if (err.code === '23505') {
    return res.status(409).json({ error: 'Такая запись уже существует' });
  }
  // Postgres foreign_key_violation
  if (err.code === '23503') {
    return res.status(400).json({ error: 'Ссылка на несуществующую запись' });
  }
  // Postgres invalid_text_representation: чаще всего это чужой или обрезанный
  // идентификатор в адресе. Раньше такой запрос давал «внутреннюю ошибку»
  // и строчку в логе ошибок на каждый неверный адрес.
  if (err.code === '22P02') {
    return res.status(400).json({ error: 'Некорректный идентификатор в запросе' });
  }
  // Взаимоблокировка, занятая строка или конфликт сериализации: две операции
  // склада столкнулись на одних ячейках. Postgres уже откатил эту транзакцию,
  // ничего не записано — повтор безопасен. Раньше это была «внутренняя ошибка».
  if (err.code === '40P01' || err.code === '55P03' || err.code === '40001') {
    return res.status(409).json({ error: 'Склад занят другой операцией с теми же ячейками — повторите через секунду' });
  }

  return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

module.exports = { errorHandler, HttpError };
