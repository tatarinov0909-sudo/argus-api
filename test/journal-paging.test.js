const test = require('node:test');
const assert = require('node:assert/strict');
const { readDay, dayPage, encodeCursor } = require('../src/journal/paging');

const scope = {
  warehouseId: '11111111-1111-1111-1111-111111111111',
  timezone: 'Asia/Novosibirsk', cellBlockId: null, invoiceId: null, hideUrgent: false,
};
const date = '2026-09-01';
const row = {
  id: '22222222-2222-2222-2222-222222222222',
  cursor_at: '2026-09-01 01:02:03.123456+00', cursor_step: 1,
};

test('calendar rejects missing dates and unbounded journal pages', () => {
  assert.deepEqual(readDay({ date: '2024-02-29', limit: '50' }), { date: '2024-02-29', limit: 50 });
  assert.equal(readDay({ date }).limit, 100);
  for (const bad of ['2026-02-29', '2026-09-31', '2026-9-1', '', ['2026-09-01']]) {
    assert.throws(() => readDay({ date: bad }), { status: 400 });
  }
  for (const limit of [0, 101, -1, 1.5, 'nope', [], ['10']]) {
    assert.throws(() => readDay({ date, limit }), { status: 400 });
  }
});

test('journal cursor keeps microseconds and binds tenant, timezone, date, scope and permission', () => {
  const cursor = encodeCursor({ ...scope, date }, 'history', row);
  const page = dayPage({ date, cursor }, scope);
  assert.equal(page.cursor.at, row.cursor_at);
  for (const changed of [
    { warehouseId: '33333333-3333-3333-3333-333333333333' },
    { timezone: 'Europe/Moscow' }, { hideUrgent: true }, { invoiceId: row.id }, { cellBlockId: row.id },
  ]) assert.throws(() => dayPage({ date, cursor }, { ...scope, ...changed }), { status: 400 });
  assert.throws(() => dayPage({ date: '2026-09-02', cursor }, scope), { status: 400 });
  assert.throws(() => dayPage({ date, pendingCursor: cursor }, scope), { status: 400 });
  const pendingCursor = encodeCursor({ ...scope, date }, 'pending', row);
  assert.equal(dayPage({ date, pendingCursor }, scope).pendingCursor.id, row.id);
});

test('journal rejects malformed and incompatible cursors before querying', () => {
  for (const value of ['bad*', 'x'.repeat(1601), null, [], ...[
    { cursor_at: 'yesterday' }, { cursor_step: 2 }, { id: 'not-an-id' },
  ].map((changed) => encodeCursor({ ...scope, date }, 'history', { ...row, ...changed }))]) {
    assert.throws(() => dayPage({ date, cursor: value }, scope), { status: 400 });
  }
});
