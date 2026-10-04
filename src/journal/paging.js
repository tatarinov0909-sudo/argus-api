const { HttpError } = require('../middleware/errorHandler');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

function readDay(query) {
  const { date } = query;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new HttpError(400, 'Выберите существующую дату журнала');
  }
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  if ((query.limit !== undefined && typeof query.limit !== 'string' && typeof query.limit !== 'number')
      || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, 'Размер страницы журнала должен быть от 1 до 100');
  }
  return { date, limit };
}

function readCursor(value, scope, kind) {
  if (value === undefined) return null;
  try {
    if (typeof value !== 'string' || value.length > 1600 || !/^[\w-]+$/.test(value)) throw Error();
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (cursor.v !== 1 || cursor.kind !== kind || !UUID.test(cursor.id)
        || ![0, 1].includes(cursor.step) || typeof cursor.at !== 'string'
        || !TIMESTAMP.test(cursor.at) || !Number.isFinite(Date.parse(cursor.at))) throw Error();
    for (const [key, expected] of Object.entries(scope)) {
      if (cursor[key] !== expected) throw Error();
    }
    return cursor;
  } catch {
    throw new HttpError(400, 'Страница журнала устарела. Откройте выбранную дату заново.');
  }
}

function dayPage(query, scope) {
  const page = readDay(query);
  const bound = { ...scope, date: page.date };
  return {
    ...page, timezone: scope.timezone, scope: bound,
    cursor: readCursor(query.cursor, bound, 'history'),
    pendingCursor: readCursor(query.pendingCursor, bound, 'pending'),
  };
}

function encodeCursor(scope, kind, row) {
  return Buffer.from(JSON.stringify({
    v: 1, ...scope, kind, at: row.cursor_at, step: row.cursor_step, id: row.id,
  })).toString('base64url');
}

module.exports = { readDay, dayPage, encodeCursor };
