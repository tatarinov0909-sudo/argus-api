// Работа грузчика со своим состоянием: сборка поставки и приёмка прихода
// (владелец 27.09.2026 — сначала сборка, потом «всё то же — и в приёмке»).
//
// Каждый заход грузчика на документ — строка work_sessions: кто, когда начал,
// с какого момента на паузе, сколько всего простоял, чем кончилось. Что уже
// сделано (взято по поставке, принято по приходу), лежит, как и раньше, в
// shipping_records и receiving_records — здесь только ход работы. Поэтому
// таймер не сбрасывается, когда человек вышел и вернулся, а руководитель
// видит в журнале каждый поворот: начал, вышел, отказался, забрал чужую
// работу, закончил — одной записью вместе с комментарием.
//
// Живой заход (идёт или на паузе) у документа один (частичные уникальные
// индексы в миграциях). Все действия берут документ на запись первым — тот
// же порядок блокировок, что у самой работы, — и поэтому идут по очереди.
//
// Движок один; чем сборка отличается от приёмки — документ, счёт «сколько
// сделано» и слова в журнале — описано ниже, в TARGETS.

const { HttpError } = require('../middleware/errorHandler');
const journal = require('../journal/repository');
const { plural } = require('../journal/plural');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Сколько идущий заход может жить после того, как работа сделана (settle).
const SETTLE_GRACE = '10 minutes';
const isLive = (row) => Boolean(row) && (row.status === 'active' || row.status === 'paused');
const minutesText = (ms) => (ms < 60000 ? 'меньше минуты' : `${Math.round(ms / 60000)} мин`);
const withComment = (text, comment) => (comment ? `${text} Комментарий: ${comment}` : text);
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// «Где оставил, что осталось» — одна строка, без переносов и простыней.
function cleanComment(value) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new HttpError(400, 'Комментарий — это текст');
  return value.trim().replace(/\s+/g, ' ').slice(0, 300);
}

const ASSEMBLY_MODES = { app: 'в приложении', paper: 'по бумажному листу' };

const TARGETS = {
  // Сборка поставки (первое задание 27.09.2026). Тексты журнала — прежние
  // слово в слово: по ним руководитель уже читает ход сборки.
  assembly: {
    column: 'supply_id',
    docKey: 'supply',
    modes: ASSEMBLY_MODES,
    exitReason: 'вышел из сборки',
    entityType: 'supply_assembly',
    async find(client, warehouseId, id, lock) {
      const r = await client.query(
        `SELECT id, number, status, company_id FROM supplies WHERE warehouse_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
        [warehouseId, id],
      );
      return r.rows[0] || null;
    },
    table: 'supplies',
    missing: 'Поставки нет — возможно, её разобрали',
    badId: 'Нужна поставка',
    canStart: (doc) => doc.status === 'collecting',
    // Собирать больше нечего: поставка собрана или уже уехала. finalAt —
    // с какого момента (см. settle).
    finalSql: (d) => `${d}.status <> 'collecting'`,
    finalAt: (d) => `COALESCE(${d}.ready_at, ${d}.shipped_at, ${d}.created_at)`,
    isFinal: (doc) => doc.status !== 'collecting',
    done: (doc) => `Поставка «${doc.number}» уже собрана`,
    // Сколько штук поставки уже снято с полок и сколько в ней всего.
    async progress(client, warehouseId, ids) {
      const map = new Map();
      const r = await client.query(
        `SELECT i.supply_id AS id,
                COALESCE(SUM(ii.declared_qty), 0)::numeric AS total,
                COALESCE(SUM(LEAST(ii.declared_qty, COALESCE(p.picked, 0))), 0)::numeric AS taken
           FROM invoices i
           JOIN invoice_items ii ON ii.invoice_id = i.id
           LEFT JOIN LATERAL (SELECT SUM(sr.picked_qty) AS picked FROM shipping_records sr
                               WHERE sr.invoice_item_id = ii.id) p ON true
          WHERE i.warehouse_id = $1 AND i.supply_id = ANY($2::uuid[])
          GROUP BY i.supply_id`,
        [warehouseId, ids],
      );
      for (const x of r.rows) map.set(x.id, { taken: Number(x.taken), total: Number(x.total) });
      return map;
    },
    takenText: (p) => `взято ${p.taken} из ${p.total} шт.`,
    journalInvoice: () => null,
    text: {
      started: (name, doc, mode) => `${name} начал сборку поставки «${doc.number}» ${ASSEMBLY_MODES[mode]}.`,
      continued: (name, doc, mode, taken) => `${name} продолжил сборку поставки «${doc.number}» ${ASSEMBLY_MODES[mode]}: ${taken}`,
      tookOver: (name, doc, mode, cur, taken) => `${name} забрал себе сборку поставки «${doc.number}», которую вёл ${cur.worker_name}`
        + ` (${cur.status === 'paused' ? 'сборка была на паузе' : 'сборка шла'}), и продолжил ${ASSEMBLY_MODES[mode]}: ${taken}`,
      resumed: (name, doc, pausedFor, why, taken) => `${name} вернулся к сборке поставки «${doc.number}» после паузы`
        + ` (${minutesText(pausedFor)}${why ? `: ${why}` : ''}), ${taken}`,
      exited: (name, doc, when, taken) => `${name} вышел из сборки поставки «${doc.number}»${when}, сборка на паузе, ${taken}`,
      paused: (name, doc, why, taken) => `${name} поставил сборку поставки «${doc.number}» на паузу: ${why}. ${capital(taken)}`,
      commented: (name, doc, taken) => `${name} оставил комментарий к сборке поставки «${doc.number}» (сборка на паузе), ${taken}`,
      abandoned: (name, doc, taken) => `${name} отказался от сборки поставки «${doc.number}», ${taken}`
        + ' Поставка свободна — её продолжит любой грузчик с того же места.',
      busy: (doc, cur) => `Поставку «${doc.number}» собирает ${cur.worker_name}`
        + `${cur.status === 'paused' ? ' — сборка на паузе' : ''}. Забрать сборку себе?`,
      notMine: (doc) => `Сборку поставки «${doc.number}» сейчас ведёте не вы`,
      settled: (name, doc, minutes, taken) => `${name} закончил сборку поставки «${doc.number}» за ${minutes} мин: ${taken}`
        + ` Поставка уже ${doc.status === 'shipped' ? 'уехала' : 'собрана'} — сборка закрыта сама.`,
    },
  },

  // Приёмка прихода (второе задание 27.09.2026). Счёт — по позициям: приёмка
  // идёт строка за строкой, и «принято 3 из 8» — это три строки накладной.
  // Штуки тут врали бы: лишний короб делал бы «принято 12 из 8».
  receiving: {
    column: 'invoice_id',
    docKey: 'invoice',
    modes: { app: '' },
    exitReason: 'вышел из приёмки',
    entityType: 'receiving_session',
    async find(client, warehouseId, id, lock) {
      const r = await client.query(
        `SELECT id, number, status, direction, company_id FROM invoices
          WHERE warehouse_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
        [warehouseId, id],
      );
      const doc = r.rows[0];
      return doc && doc.direction === 'in' ? doc : null;
    },
    table: 'invoices',
    missing: 'Прихода нет — возможно, его отменили',
    badId: 'Нужен приход',
    canStart: (doc) => doc.status !== 'completed',
    // Все позиции приняты (в том числе нулём — «не приехало»).
    finalSql: (d) => `${d}.status = 'completed' AND ${d}.direction = 'in'`,
    finalAt: (d) => `(SELECT MAX(rr.finished_at) FROM receiving_records rr JOIN invoice_items ii ON ii.id = rr.invoice_item_id
                       WHERE ii.invoice_id = ${d}.id)`,
    isFinal: (doc) => doc.status === 'completed',
    done: (doc) => `Приход «${doc.number}» уже принят`,
    async progress(client, warehouseId, ids) {
      const map = new Map();
      const r = await client.query(
        `SELECT ii.invoice_id AS id, count(*)::int AS total,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM receiving_records rr
                                                WHERE rr.invoice_item_id = ii.id))::int AS taken
           FROM invoice_items ii
          WHERE ii.warehouse_id = $1 AND ii.invoice_id = ANY($2::uuid[])
          GROUP BY ii.invoice_id`,
        [warehouseId, ids],
      );
      for (const x of r.rows) map.set(x.id, { taken: Number(x.taken), total: Number(x.total) });
      return map;
    },
    takenText: (p) => `принято ${p.taken} из ${p.total} ${plural(p.total, 'позиции', 'позиций', 'позиций')}.`,
    // Записи приёмки — к самому приходу: в карточке прихода и в журнале
    // работа грузчика собирается одной строкой «Дима принимает ПР-…».
    journalInvoice: (doc) => doc.id,
    text: {
      started: (name, doc) => `${name} начал приёмку прихода «${doc.number}».`,
      continued: (name, doc, mode, taken) => `${name} продолжил приёмку прихода «${doc.number}»: ${taken}`,
      tookOver: (name, doc, mode, cur, taken) => `${name} забрал себе приёмку прихода «${doc.number}», которую вёл ${cur.worker_name}`
        + ` (${cur.status === 'paused' ? 'приёмка была на паузе' : 'приёмка шла'}), и продолжил: ${taken}`,
      resumed: (name, doc, pausedFor, why, taken) => `${name} вернулся к приёмке прихода «${doc.number}» после паузы`
        + ` (${minutesText(pausedFor)}${why ? `: ${why}` : ''}), ${taken}`,
      exited: (name, doc, when, taken) => `${name} вышел из приёмки прихода «${doc.number}»${when}, приёмка на паузе, ${taken}`,
      paused: (name, doc, why, taken) => `${name} поставил приёмку прихода «${doc.number}» на паузу: ${why}. ${capital(taken)}`,
      commented: (name, doc, taken) => `${name} оставил комментарий к приёмке прихода «${doc.number}» (приёмка на паузе), ${taken}`,
      abandoned: (name, doc, taken) => `${name} отказался от приёмки прихода «${doc.number}», ${taken}`
        + ' Приход свободен — его продолжит любой грузчик с того же места.',
      busy: (doc, cur) => `Приход «${doc.number}» принимает ${cur.worker_name}`
        + `${cur.status === 'paused' ? ' — приёмка на паузе' : ''}. Забрать приёмку себе?`,
      notMine: (doc) => `Приёмку прихода «${doc.number}» сейчас ведёте не вы`,
      settled: (name, doc, minutes, taken) => `${name} закончил приёмку прихода «${doc.number}» за ${minutes} мин: ${taken}`
        + ' Все позиции приняты — приёмка закрыта сама.',
    },
  },
};

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
    kind: row.kind,
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

async function workerName(client, staffKeyId) {
  const r = await client.query('SELECT name FROM staff_keys WHERE id = $1', [staffKeyId]);
  return r.rows[0]?.name || 'Грузчик';
}

// Закрыть заход: пауза, если шла, досчитывается в общее время паузы.
async function closeRow(client, row, status, comment = '') {
  const r = await client.query(
    `UPDATE work_sessions
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
    `UPDATE work_sessions
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

function createWork(kind) {
  const T = TARGETS[kind];
  const col = T.column;

  async function lock(client, warehouseId, id) {
    if (!UUID.test(String(id || ''))) throw new HttpError(400, T.badId);
    const doc = await T.find(client, warehouseId, id, true);
    if (!doc) throw new HttpError(404, T.missing);
    return doc;
  }

  async function latest(client, warehouseId, id) {
    const r = await client.query(
      `SELECT * FROM work_sessions WHERE warehouse_id = $1 AND ${col} = $2
        ORDER BY (status IN ('active', 'paused')) DESC, started_at DESC, updated_at DESC LIMIT 1 FOR UPDATE`,
      [warehouseId, id],
    );
    return r.rows[0] || null;
  }

  async function progress(client, warehouseId, ids) {
    if (!ids.length) return new Map();
    return T.progress(client, warehouseId, ids);
  }
  const progressOf = async (client, warehouseId, id) => (
    (await progress(client, warehouseId, [id])).get(id) || { taken: 0, total: 0 });

  // Состояние работы по нескольким документам сразу — для списков.
  // lastComment — последний комментарий по документу, чей бы заход ни был:
  // «коробы у ворот 3» нужны и тому, кто подхватит брошенную работу.
  async function statesFor(client, warehouseId, docIds, staffKeyId = null) {
    const out = new Map();
    const ids = [...new Set(docIds.filter(Boolean))];
    if (!ids.length) return out;
    const sessions = await client.query(
      `SELECT DISTINCT ON (${col}) * FROM work_sessions
        WHERE warehouse_id = $1 AND ${col} = ANY($2::uuid[])
        ORDER BY ${col}, (status IN ('active', 'paused')) DESC, started_at DESC, updated_at DESC`,
      [warehouseId, ids],
    );
    const comments = await client.query(
      `SELECT DISTINCT ON (${col}) ${col} AS doc_id, comment, comment_at, worker_name FROM work_sessions
        WHERE warehouse_id = $1 AND ${col} = ANY($2::uuid[]) AND comment IS NOT NULL
        ORDER BY ${col}, comment_at DESC`,
      [warehouseId, ids],
    );
    const prog = await progress(client, warehouseId, ids);
    const byDoc = new Map(sessions.rows.map((r) => [r[col], r]));
    const commentBy = new Map(comments.rows.map((r) => [r.doc_id, r]));
    for (const id of ids) {
      const c = commentBy.get(id);
      out.set(id, {
        // Поле зовётся assembly по первой такой работе — сборке; это заход
        // любой работы, у приёмки тоже (экраны и тесты читают его так).
        assembly: view(byDoc.get(id), staffKeyId),
        lastComment: c ? { text: c.comment, by: c.worker_name, at: c.comment_at } : null,
        ...(prog.get(id) || { taken: 0, total: 0 }),
      });
    }
    return out;
  }

  async function stateOf(client, warehouseId, doc, staffKeyId = null) {
    const st = (await statesFor(client, warehouseId, [doc.id], staffKeyId)).get(doc.id);
    return {
      kind,
      [T.docKey]: { id: doc.id, number: doc.number, status: doc.status },
      ...st,
      // Часы телефона бывают неточны: таймер на экране считается от этого.
      serverNow: new Date().toISOString(),
    };
  }

  async function readState(client, warehouseId, id, staffKeyId = null) {
    if (!UUID.test(String(id || ''))) throw new HttpError(400, T.badId);
    await settle(client, warehouseId, [id]);
    const doc = await T.find(client, warehouseId, id, false);
    if (!doc) throw new HttpError(404, T.missing);
    return stateOf(client, warehouseId, doc, staffKeyId);
  }

  const entry = (client, warehouseId, staffKeyId, doc, actionText, entityType = T.entityType) => journal.createEntry(client, {
    warehouseId,
    agent: 'Кладовщик',
    actionText,
    entityType,
    entityId: doc.id,
    invoiceId: T.journalInvoice(doc),
    actorType: 'worker',
    actorId: staffKeyId,
  });

  // Заход, у которого работа уже сделана — приход принят, поставка собрана
  // или уехала, — не может висеть «идёт» или «на паузе» (случай 27.09.2026:
  // Джоник принял 8 из 8, окно «Закончить приёмку» закрылось кликом мимо, и
  // заход остался на паузе, а грузчик — на уже принятом товаре). Такой заход
  // закрывается как законченный: сам — в той же транзакции, что последняя
  // принятая позиция (receiving/routes.js), а на всякий другой случай —
  // при следующем обращении к спискам и к самой работе.
  //
  // docIds — только эти документы; без них — все зависшие на складе (их
  // единицы: живой заход у документа один) — так зовут списки приходов и
  // поставок и журнал. Документ берём на запись первым — тот же порядок
  // блокировок, что у самой работы.
  //
  // Заход на паузе закрывается сразу. Идущий — только если работа сделана
  // больше SETTLE_GRACE назад: грузчик, взявший последний товар, ещё стоит
  // на окне «Закончить сборку» с комментарием, и чужой список не должен
  // закрывать работу у него из-под рук. force — без этой отсрочки: последняя
  // позиция прихода (та же транзакция) и выход самого грузчика.
  async function settle(client, warehouseId, docIds = null, { force = false } = {}) {
    const ids = docIds ? [...new Set(docIds.filter(Boolean))] : null;
    if (ids && !ids.length) return [];
    const stuck = await client.query(
      `SELECT DISTINCT ws.${col} AS id FROM work_sessions ws JOIN ${T.table} d ON d.id = ws.${col}
        WHERE ws.warehouse_id = $1 AND ws.kind = $2 AND ws.status IN ('active', 'paused')
          AND ($3::uuid[] IS NULL OR ws.${col} = ANY($3::uuid[])) AND ${T.finalSql('d')}
          AND ($4::boolean OR ws.status = 'paused' OR ${T.finalAt('d')} < now() - interval '${SETTLE_GRACE}')
        ORDER BY 1`,
      [warehouseId, kind, ids, force],
    );
    const closed = [];
    for (const { id } of stuck.rows) {
      const doc = await T.find(client, warehouseId, id, true);
      if (!doc || !T.isFinal(doc)) continue;
      const cur = await latest(client, warehouseId, id);
      if (!isLive(cur)) continue;
      const row = await closeRow(client, cur, 'finished');
      const minutes = Math.max(1, Math.round(workMs(row) / 60000));
      const taken = T.takenText(await progressOf(client, warehouseId, id));
      // Запись — от имени того, чей был заход: в журнале это его работа.
      await entry(client, warehouseId, cur.worker_key_id, doc, T.text.settled(row.worker_name, doc, minutes, taken));
      closed.push(row);
    }
    return closed;
  }

  // Начать работу — только после «Начать» в окне с таймером (или скана QR
  // бумажного листа сборки), не от открытия экрана (владелец 27.09.2026).
  //
  // Свой живой заход — продолжить его (с паузы — вернуться). Чужой живой —
  // только забрать, и это видно в журнале: без этого документ, брошенный с
  // разряженным телефоном, так и висел бы «собирает Дима». Отказанную или
  // законченную с недобором работу — продолжить с того же места: сделанное
  // записано.
  async function start(client, warehouseId, staffKeyId, id, { mode = 'app', takeOver = false, comment = '' } = {}) {
    if (!Object.prototype.hasOwnProperty.call(T.modes, mode)) {
      throw new HttpError(400, kind === 'assembly'
        ? 'Сборка бывает в приложении или по бумажному листу' : 'Приёмку ведут в приложении');
    }
    const note = cleanComment(comment);
    const doc = await lock(client, warehouseId, id);
    if (!T.canStart(doc)) throw new HttpError(409, T.done(doc));
    const name = await workerName(client, staffKeyId);
    const cur = await latest(client, warehouseId, doc.id);
    const taken = T.takenText(await progressOf(client, warehouseId, doc.id));

    if (isLive(cur) && cur.worker_key_id === staffKeyId) {
      let row = cur;
      if (row.status === 'paused') {
        const pausedFor = Date.now() - new Date(row.paused_at).getTime();
        const why = row.pause_reason;
        row = await resumeRow(client, row, note);
        await entry(client, warehouseId, staffKeyId, doc,
          withComment(T.text.resumed(name, doc, pausedFor, why, taken), note), 'worker_pause');
      }
      if (row.mode !== mode) {
        await client.query('UPDATE work_sessions SET mode = $2, updated_at = now() WHERE id = $1', [row.id, mode]);
      }
      return { started: false, ...(await stateOf(client, warehouseId, doc, staffKeyId)) };
    }

    let text;
    if (isLive(cur)) {
      if (!takeOver) {
        throw new HttpError(409, T.text.busy(doc, cur), { taken: true, assembly: view(cur, staffKeyId) });
      }
      await closeRow(client, cur, 'abandoned');
      text = T.text.tookOver(name, doc, mode, cur, taken);
    } else if (cur) {
      text = T.text.continued(name, doc, mode, taken);
    } else {
      text = T.text.started(name, doc, mode);
    }
    await client.query(
      `INSERT INTO work_sessions (warehouse_id, kind, ${col}, worker_key_id, worker_name, mode,
                                  comment, comment_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7, ''), CASE WHEN $7 <> '' THEN now() END)`,
      [warehouseId, kind, doc.id, staffKeyId, name, mode, note],
    );
    await entry(client, warehouseId, staffKeyId, doc, withComment(text, note),
      mode === 'paper' ? 'paper_pick' : T.entityType);
    return { started: true, ...(await stateOf(client, warehouseId, doc, staffKeyId)) };
  }

  // Пауза и возврат. Вызывается из POST /api/journal/pause — у паузы один
  // вход, как и раньше; здесь она ещё и останавливает таймер на сервере. Нет
  // своего живого захода — null: пауза записывается в журнал по-старому.
  //
  // exit — грузчик вышел из работы (стрелка «назад», другая вкладка, закрыл
  // страницу): таймер встаёт на паузу сам.
  //
  // at — когда человек на самом деле ушёл: телефон, свёрнутый в фоне, может не
  // успеть сообщить о выходе, и экран присылает время ухода, вернувшись. Раньше
  // последнего изменения захода и позже «сейчас» оно не бывает.
  async function pauseOrResume(client, warehouseId, staffKeyId, id, {
    reason = '', resumed = false, exit = false, comment = '', at = null,
  } = {}) {
    const note = cleanComment(comment);
    if (!UUID.test(String(id || ''))) return null;
    const doc = await T.find(client, warehouseId, id, true);
    if (!doc) return null;
    // Работа уже сделана — не пауза, а конец захода.
    if (T.isFinal(doc)) await settle(client, warehouseId, [doc.id], { force: true });
    const cur = await latest(client, warehouseId, doc.id);
    if (!isLive(cur) || cur.worker_key_id !== staffKeyId) return null;
    const name = await workerName(client, staffKeyId);
    const taken = T.takenText(await progressOf(client, warehouseId, doc.id));
    let text = null;

    if (resumed) {
      if (cur.status === 'paused') {
        const pausedFor = Date.now() - new Date(cur.paused_at).getTime();
        const why = cur.pause_reason || reason;
        await resumeRow(client, cur, note);
        text = T.text.resumed(name, doc, pausedFor, why, taken);
      }
    } else if (cur.status === 'active') {
      const why = exit ? T.exitReason : reason;
      const left = exit && at && !Number.isNaN(new Date(at).getTime()) ? new Date(at) : null;
      const paused = (await client.query(
        `UPDATE work_sessions
            SET status = 'paused', paused_at = GREATEST(updated_at, LEAST(now(), COALESCE($4::timestamptz, now()))),
                pause_reason = $2,
                comment = COALESCE(NULLIF($3, ''), comment),
                comment_at = CASE WHEN $3 <> '' THEN now() ELSE comment_at END,
                updated_at = now()
          WHERE id = $1 RETURNING paused_at`,
        [cur.id, why, note, left ? left.toISOString() : null],
      )).rows[0];
      // Ушёл заметно раньше, чем об этом узнал сервер, — время ухода в тексте.
      const when = Date.now() - new Date(paused.paused_at).getTime() > 60000
        ? ` в ${new Date(paused.paused_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })}`
        : '';
      text = exit ? T.text.exited(name, doc, when, taken) : T.text.paused(name, doc, why, taken);
    } else if (note) {
      // Уже на паузе — второй паузы нет, но комментарий человек оставил.
      await client.query(
        'UPDATE work_sessions SET comment = $2, comment_at = now(), updated_at = now() WHERE id = $1',
        [cur.id, note],
      );
      text = T.text.commented(name, doc, taken);
    }
    const made = text
      ? await entry(client, warehouseId, staffKeyId, doc, withComment(text, note), 'worker_pause')
      : null;
    return { entry: made, state: await stateOf(client, warehouseId, doc, staffKeyId) };
  }

  // Отказаться: сделанное остаётся записанным, документ свободен, и любой
  // грузчик продолжит с того же места.
  async function abandon(client, warehouseId, staffKeyId, id, { comment = '' } = {}) {
    const note = cleanComment(comment);
    const doc = await lock(client, warehouseId, id);
    const cur = await latest(client, warehouseId, doc.id);
    if (!isLive(cur) || cur.worker_key_id !== staffKeyId) throw new HttpError(409, T.text.notMine(doc));
    const name = await workerName(client, staffKeyId);
    const taken = T.takenText(await progressOf(client, warehouseId, doc.id));
    await closeRow(client, cur, 'abandoned', note);
    await entry(client, warehouseId, staffKeyId, doc, withComment(T.text.abandoned(name, doc, taken), note));
    return stateOf(client, warehouseId, doc, staffKeyId);
  }

  // Свой живой заход — для «Закончить» и бумажного листа.
  async function liveOf(client, warehouseId, id, staffKeyId) {
    const cur = await latest(client, warehouseId, id);
    return isLive(cur) && cur.worker_key_id === staffKeyId ? cur : null;
  }

  return {
    kind,
    MODES: T.modes,
    cleanComment,
    lock,
    progress,
    statesFor,
    stateOf,
    readState,
    start,
    pauseOrResume,
    abandon,
    liveOf,
    latest,
    settle,
    closeRow,
    workMs,
    takenText: T.takenText,
    withComment,
    entry,
    notMine: T.text.notMine,
  };
}

module.exports = { createWork, cleanComment, workMs, withComment, minutesText };
