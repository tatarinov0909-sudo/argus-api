// Сборка поставки как работа грузчика со своим состоянием (владелец 27.09.2026).
//
// Каждый заход грузчика на поставку — строка supply_assemblies: кто, когда
// начал, с какого момента на паузе, сколько всего простоял, чем кончилось.
// Что уже взято, как и раньше, лежит в shipping_records — здесь только ход
// работы. Поэтому таймер не сбрасывается, когда человек вышел и вернулся, а
// руководитель видит в журнале каждый поворот: начал, вышел, отказался,
// забрал чужую сборку, закончил — одной записью вместе с комментарием.
//
// Живой заход (идёт или на паузе) у поставки один (частичный уникальный
// индекс в миграции). Все действия берут поставку на запись первой — тот же
// порядок блокировок, что у отбора, — и поэтому идут по очереди.

const { HttpError } = require('../middleware/errorHandler');
const journal = require('../journal/repository');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODES = { app: 'в приложении', paper: 'по бумажному листу' };
const isLive = (row) => Boolean(row) && (row.status === 'active' || row.status === 'paused');
const EXIT_REASON = 'вышел из сборки';

// «Где оставил, что осталось» — одна строка, без переносов и простыней.
function cleanComment(value) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new HttpError(400, 'Комментарий — это текст');
  return value.trim().replace(/\s+/g, ' ').slice(0, 300);
}

async function lockSupply(client, warehouseId, supplyId) {
  if (!UUID.test(String(supplyId || ''))) throw new HttpError(400, 'Нужна поставка');
  const r = await client.query(
    'SELECT id, number, status, company_id FROM supplies WHERE warehouse_id = $1 AND id = $2 FOR UPDATE',
    [warehouseId, supplyId],
  );
  if (!r.rows[0]) throw new HttpError(404, 'Поставки нет — возможно, её разобрали');
  return r.rows[0];
}

async function latest(client, warehouseId, supplyId) {
  const r = await client.query(
    `SELECT * FROM supply_assemblies WHERE warehouse_id = $1 AND supply_id = $2
      ORDER BY started_at DESC, updated_at DESC LIMIT 1 FOR UPDATE`,
    [warehouseId, supplyId],
  );
  return r.rows[0] || null;
}

async function workerName(client, staffKeyId) {
  const r = await client.query('SELECT name FROM staff_keys WHERE id = $1', [staffKeyId]);
  return r.rows[0]?.name || 'Грузчик';
}

// Сколько штук поставки уже снято с полок и сколько в ней всего.
async function progress(client, warehouseId, supplyIds) {
  const map = new Map();
  if (!supplyIds.length) return map;
  const r = await client.query(
    `SELECT i.supply_id,
            COALESCE(SUM(ii.declared_qty), 0)::numeric AS total,
            COALESCE(SUM(LEAST(ii.declared_qty, COALESCE(p.picked, 0))), 0)::numeric AS taken
       FROM invoices i
       JOIN invoice_items ii ON ii.invoice_id = i.id
       LEFT JOIN LATERAL (SELECT SUM(sr.picked_qty) AS picked FROM shipping_records sr
                           WHERE sr.invoice_item_id = ii.id) p ON true
      WHERE i.warehouse_id = $1 AND i.supply_id = ANY($2::uuid[])
      GROUP BY i.supply_id`,
    [warehouseId, supplyIds],
  );
  for (const x of r.rows) map.set(x.supply_id, { taken: Number(x.taken), total: Number(x.total) });
  return map;
}

const takenText = (p) => `взято ${p.taken} из ${p.total} шт.`;
const withComment = (text, comment) => (comment ? `${text} Комментарий: ${comment}` : text);
const minutesText = (ms) => (ms < 60000 ? 'меньше минуты' : `${Math.round(ms / 60000)} мин`);

// Чистое время работы захода: от начала до конца (или до паузы) минус паузы.
function workMs(row, now = Date.now()) {
  const end = row.ended_at ? new Date(row.ended_at).getTime()
    : row.paused_at ? new Date(row.paused_at).getTime() : now;
  return Math.max(0, end - new Date(row.started_at).getTime() - Number(row.paused_ms || 0));
}

function view(row, staffKeyId) {
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    workerName: row.worker_name,
    mine: Boolean(staffKeyId) && row.worker_key_id === staffKeyId,
    startedAt: row.started_at,
    pausedAt: row.paused_at,
    pausedMs: Number(row.paused_ms),
    pauseReason: row.pause_reason,
    endedAt: row.ended_at,
    comment: row.comment,
    commentAt: row.comment_at,
    workMs: workMs(row),
  };
}

// Состояние сборки по нескольким поставкам сразу — для списков поставок.
// lastComment — последний комментарий по поставке, чей бы заход ни был:
// «коробы у ворот 3» нужны и тому, кто подхватит отказанную сборку.
async function statesFor(client, warehouseId, supplyIds, staffKeyId = null) {
  const out = new Map();
  const ids = [...new Set(supplyIds.filter(Boolean))];
  if (!ids.length) return out;
  const sessions = await client.query(
    `SELECT DISTINCT ON (supply_id) * FROM supply_assemblies
      WHERE warehouse_id = $1 AND supply_id = ANY($2::uuid[])
      ORDER BY supply_id, started_at DESC, updated_at DESC`,
    [warehouseId, ids],
  );
  const comments = await client.query(
    `SELECT DISTINCT ON (supply_id) supply_id, comment, comment_at, worker_name FROM supply_assemblies
      WHERE warehouse_id = $1 AND supply_id = ANY($2::uuid[]) AND comment IS NOT NULL
      ORDER BY supply_id, comment_at DESC`,
    [warehouseId, ids],
  );
  const prog = await progress(client, warehouseId, ids);
  const bySupply = new Map(sessions.rows.map((r) => [r.supply_id, r]));
  const commentBy = new Map(comments.rows.map((r) => [r.supply_id, r]));
  for (const id of ids) {
    const c = commentBy.get(id);
    out.set(id, {
      assembly: view(bySupply.get(id), staffKeyId),
      lastComment: c ? { text: c.comment, by: c.worker_name, at: c.comment_at } : null,
      ...(prog.get(id) || { taken: 0, total: 0 }),
    });
  }
  return out;
}

async function stateOf(client, warehouseId, supply, staffKeyId = null) {
  const st = (await statesFor(client, warehouseId, [supply.id], staffKeyId)).get(supply.id);
  return {
    supply: { id: supply.id, number: supply.number, status: supply.status },
    ...st,
    // Часы телефона бывают неточны: таймер на экране считается от этого.
    serverNow: new Date().toISOString(),
  };
}

async function readState(client, warehouseId, supplyId, staffKeyId = null) {
  if (!UUID.test(String(supplyId || ''))) throw new HttpError(400, 'Нужна поставка');
  const r = await client.query(
    'SELECT id, number, status FROM supplies WHERE warehouse_id = $1 AND id = $2',
    [warehouseId, supplyId],
  );
  if (!r.rows[0]) throw new HttpError(404, 'Поставки нет — возможно, её разобрали');
  return stateOf(client, warehouseId, r.rows[0], staffKeyId);
}

// Закрыть заход: пауза, если шла, досчитывается в общее время паузы.
async function closeRow(client, row, status, comment = '') {
  const r = await client.query(
    `UPDATE supply_assemblies
        SET status = $2,
            paused_ms = paused_ms + CASE WHEN paused_at IS NULL THEN 0
                          ELSE GREATEST(0, (EXTRACT(EPOCH FROM (now() - paused_at)) * 1000)::bigint) END,
            paused_at = NULL, pause_reason = NULL, ended_at = now(),
            comment = COALESCE(NULLIF($3, ''), comment),
            comment_at = CASE WHEN $3 <> '' THEN now() ELSE comment_at END,
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [row.id, status, comment],
  );
  return r.rows[0];
}

async function resumeRow(client, row, comment = '') {
  const r = await client.query(
    `UPDATE supply_assemblies
        SET status = 'active',
            paused_ms = paused_ms + GREATEST(0, (EXTRACT(EPOCH FROM (now() - paused_at)) * 1000)::bigint),
            paused_at = NULL, pause_reason = NULL,
            comment = COALESCE(NULLIF($2, ''), comment),
            comment_at = CASE WHEN $2 <> '' THEN now() ELSE comment_at END,
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [row.id, comment],
  );
  return r.rows[0];
}

const entry = (client, warehouseId, staffKeyId, supply, actionText, entityType = 'supply_assembly') => journal.createEntry(client, {
  warehouseId,
  agent: 'Кладовщик',
  actionText,
  entityType,
  entityId: supply.id,
  actorType: 'worker',
  actorId: staffKeyId,
});

// Начать сборку — только после «Начать» в окне с таймером или скана QR
// бумажного листа, не от открытия экрана (владелец 27.09.2026).
//
// Свой живой заход — продолжить его (с паузы — вернуться). Чужой живой —
// только забрать, и это видно в журнале: без этого поставка, брошенная с
// разряженным телефоном, так и висела бы «собирает Дима». Отказанную или
// законченную с недобором — продолжить с того же места: взятое записано.
async function start(client, warehouseId, staffKeyId, supplyId, { mode = 'app', takeOver = false, comment = '' } = {}) {
  if (!Object.prototype.hasOwnProperty.call(MODES, mode)) {
    throw new HttpError(400, 'Сборка бывает в приложении или по бумажному листу');
  }
  const note = cleanComment(comment);
  const supply = await lockSupply(client, warehouseId, supplyId);
  if (supply.status !== 'collecting') throw new HttpError(409, `Поставка «${supply.number}» уже собрана`);
  const name = await workerName(client, staffKeyId);
  const cur = await latest(client, warehouseId, supply.id);
  const prog = (await progress(client, warehouseId, [supply.id])).get(supply.id) || { taken: 0, total: 0 };

  if (isLive(cur) && cur.worker_key_id === staffKeyId) {
    let row = cur;
    if (row.status === 'paused') {
      const pausedFor = Date.now() - new Date(row.paused_at).getTime();
      const why = row.pause_reason;
      row = await resumeRow(client, row, note);
      await entry(client, warehouseId, staffKeyId, supply, withComment(
        `${name} вернулся к сборке поставки «${supply.number}» после паузы (${minutesText(pausedFor)}`
        + `${why ? `: ${why}` : ''}), ${takenText(prog)}`, note), 'worker_pause');
    }
    if (row.mode !== mode) {
      await client.query('UPDATE supply_assemblies SET mode = $2, updated_at = now() WHERE id = $1', [row.id, mode]);
    }
    return { started: false, ...(await stateOf(client, warehouseId, supply, staffKeyId)) };
  }

  let text;
  if (isLive(cur)) {
    if (!takeOver) {
      throw new HttpError(409,
        `Поставку «${supply.number}» собирает ${cur.worker_name}`
        + (cur.status === 'paused' ? ' — сборка на паузе' : '') + '. Забрать сборку себе?',
        { taken: true, assembly: view(cur, staffKeyId) });
    }
    await closeRow(client, cur, 'abandoned');
    text = `${name} забрал себе сборку поставки «${supply.number}», которую вёл ${cur.worker_name}`
      + ` (${cur.status === 'paused' ? 'сборка была на паузе' : 'сборка шла'}), и продолжил ${MODES[mode]}: ${takenText(prog)}`;
  } else if (cur) {
    text = `${name} продолжил сборку поставки «${supply.number}» ${MODES[mode]}: ${takenText(prog)}`;
  } else {
    text = `${name} начал сборку поставки «${supply.number}» ${MODES[mode]}.`;
  }
  await client.query(
    `INSERT INTO supply_assemblies (warehouse_id, supply_id, worker_key_id, worker_name, mode,
                                    comment, comment_at)
     VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), CASE WHEN $6 <> '' THEN now() END)`,
    [warehouseId, supply.id, staffKeyId, name, mode, note],
  );
  await entry(client, warehouseId, staffKeyId, supply, withComment(text, note),
    mode === 'paper' ? 'paper_pick' : 'supply_assembly');
  return { started: true, ...(await stateOf(client, warehouseId, supply, staffKeyId)) };
}

// Пауза и возврат по поставке. Вызывается из POST /api/journal/pause — у
// паузы один вход, как и раньше; здесь она ещё и останавливает таймер
// сборки на сервере. Нет своего живого захода — null: пауза записывается
// в журнал по-старому, без состояния.
//
// exit — грузчик вышел из сборки (стрелка «назад», другая вкладка,
// закрыл страницу): таймер встаёт на паузу сам.
async function pauseOrResume(client, warehouseId, staffKeyId, supplyId, {
  reason = '', resumed = false, exit = false, comment = '',
} = {}) {
  const note = cleanComment(comment);
  if (!UUID.test(String(supplyId || ''))) return null;
  const supply = (await client.query(
    'SELECT id, number, status, company_id FROM supplies WHERE warehouse_id = $1 AND id = $2 FOR UPDATE',
    [warehouseId, supplyId],
  )).rows[0];
  if (!supply) return null;
  const cur = await latest(client, warehouseId, supply.id);
  if (!isLive(cur) || cur.worker_key_id !== staffKeyId) return null;
  const name = await workerName(client, staffKeyId);
  const prog = (await progress(client, warehouseId, [supply.id])).get(supply.id) || { taken: 0, total: 0 };
  let text = null;

  if (resumed) {
    if (cur.status === 'paused') {
      const pausedFor = Date.now() - new Date(cur.paused_at).getTime();
      const why = cur.pause_reason || reason;
      await resumeRow(client, cur, note);
      text = `${name} вернулся к сборке поставки «${supply.number}» после паузы (${minutesText(pausedFor)}`
        + `${why ? `: ${why}` : ''}), ${takenText(prog)}`;
    }
  } else if (cur.status === 'active') {
    const why = exit ? EXIT_REASON : reason;
    await client.query(
      `UPDATE supply_assemblies
          SET status = 'paused', paused_at = now(), pause_reason = $2,
              comment = COALESCE(NULLIF($3, ''), comment),
              comment_at = CASE WHEN $3 <> '' THEN now() ELSE comment_at END,
              updated_at = now()
        WHERE id = $1`,
      [cur.id, why, note],
    );
    text = exit
      ? `${name} вышел из сборки поставки «${supply.number}», сборка на паузе, ${takenText(prog)}`
      : `${name} поставил сборку поставки «${supply.number}» на паузу: ${why}. ${takenText(prog).replace(/^в/, 'В')}`;
  } else if (note) {
    // Уже на паузе — второй паузы нет, но комментарий человек оставил.
    await client.query(
      'UPDATE supply_assemblies SET comment = $2, comment_at = now(), updated_at = now() WHERE id = $1',
      [cur.id, note],
    );
    text = `${name} оставил комментарий к сборке поставки «${supply.number}» (сборка на паузе), ${takenText(prog)}`;
  }
  const made = text
    ? await entry(client, warehouseId, staffKeyId, supply, withComment(text, note), 'worker_pause')
    : null;
  return { entry: made, state: await stateOf(client, warehouseId, supply, staffKeyId) };
}

// Отказаться от сборки: взятое остаётся записанным, поставка свободна, и
// любой грузчик продолжит с того же места.
async function abandon(client, warehouseId, staffKeyId, supplyId, { comment = '' } = {}) {
  const note = cleanComment(comment);
  const supply = await lockSupply(client, warehouseId, supplyId);
  const cur = await latest(client, warehouseId, supply.id);
  if (!isLive(cur) || cur.worker_key_id !== staffKeyId) {
    throw new HttpError(409, `Сборку поставки «${supply.number}» сейчас ведёте не вы`);
  }
  const name = await workerName(client, staffKeyId);
  const prog = (await progress(client, warehouseId, [supply.id])).get(supply.id) || { taken: 0, total: 0 };
  await closeRow(client, cur, 'abandoned', note);
  await entry(client, warehouseId, staffKeyId, supply, withComment(
    `${name} отказался от сборки поставки «${supply.number}», ${takenText(prog)}`
    + ' Поставка свободна — её продолжит любой грузчик с того же места.', note));
  return stateOf(client, warehouseId, supply, staffKeyId);
}

// Свой живой заход по поставке — для «Закончить сборку» и бумажного листа.
async function liveOf(client, warehouseId, supplyId, staffKeyId) {
  const cur = await latest(client, warehouseId, supplyId);
  return isLive(cur) && cur.worker_key_id === staffKeyId ? cur : null;
}

module.exports = {
  MODES,
  cleanComment,
  lockSupply,
  progress,
  statesFor,
  stateOf,
  readState,
  start,
  pauseOrResume,
  abandon,
  liveOf,
  closeRow,
  workMs,
  takenText,
  withComment,
  entry,
};
