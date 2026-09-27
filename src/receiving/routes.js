const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const { requireQty } = require('../middleware/qty');
const { refreshCellFill } = require('../cells/fill');
const { blockLabelSql } = require('../cells/label');
const journal = require('../journal/repository');
const kladovshchik = require('../agents/kladovshchik');
const outbox = require('../sync/outbox');
const work = require('./session');

const router = express.Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PLACEMENTS = 20;

// Куда лёг принятый товар — список укладок «N шт. в ячейку X».
//
// placements: [{cellBlockId, qty}] — несколько ячеек (владелец 27.09.2026,
// третье задание): в сумме ровно принятое, одна ячейка — один раз. Каждая
// укладка останется отдельным шагом (receiving_placements) — позже её
// подтвердят сканом QR, поэтому одинаковые ячейки не складываются молча.
// cellBlockId — одна ячейка, как было: всё принятое туда. Ни того ни
// другого — «своё место» без ячейки: принято, но ещё не размещено.
function planPlacements({ accepted, cellBlockId, placements }) {
  if (placements != null) {
    if (cellBlockId) throw new HttpError(400, 'Ячейка указана и одна, и списком — нужно что-то одно');
    if (!Array.isArray(placements) || !placements.length) throw new HttpError(400, 'Укажите, в какие ячейки положили товар');
    if (placements.length > MAX_PLACEMENTS) throw new HttpError(400, `Не больше ${MAX_PLACEMENTS} ячеек на один товар`);
    const seen = new Set();
    const plan = placements.map((p) => {
      const id = p && typeof p.cellBlockId === 'string' ? p.cellBlockId : '';
      if (!UUID.test(id)) throw new HttpError(400, 'Ячейка не найдена');
      if (seen.has(id)) throw new HttpError(400, 'Одна ячейка указана дважды — поставьте её количество одной строкой');
      seen.add(id);
      return { cellBlockId: id, qty: requireQty(p.qty, 'Сколько кладёте в ячейку', { min: 1 }) };
    });
    const sum = plan.reduce((a, p) => a + p.qty, 0);
    if (accepted === 0) throw new HttpError(400, 'Ничего не принято — класть в ячейку нечего');
    if (sum !== accepted) {
      throw new HttpError(400, sum < accepted
        ? `Разложено ${sum} из ${accepted} шт. — осталось разложить ${accepted - sum}`
        : `Разложено ${sum} шт., а принято ${accepted} — уберите лишние ${sum - accepted}`);
    }
    return plan;
  }
  if (cellBlockId) {
    if (typeof cellBlockId !== 'string' || !UUID.test(cellBlockId)) throw new HttpError(404, 'Ячейка не найдена');
    // Ноль класть некуда: раньше в ячейке появлялась пустая строка остатка.
    return accepted > 0 ? [{ cellBlockId, qty: accepted }] : [];
  }
  return [];
}

// Worker submits one line item: actual quantity, where it went (one cell,
// several cells, or none yet — "своё место"), and the pause tally the
// client already tracked locally during the session.
router.post('/', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const {
      invoiceItemId, acceptedQty, cellBlockId, placements, pausedMs, pauseReasons, suggestionId,
    } = req.body;
    if (!invoiceItemId || acceptedQty == null) {
      throw new HttpError(400, 'Не хватает данных о принятой позиции');
    }
    // Отрицательная приёмка — это не «ничего не приняли», а списание чужого
    // товара с полки: остаток в ячейке уменьшится, и никто не узнает.
    // Пишем в базу проверенное число: «true» и «0x10» превращались в 1 и 16
    // при проверке, а в NUMERIC уезжало сырое значение и Postgres отвечал
    // ошибкой — работник видел «внутреннюю ошибку» вместо понятного отказа.
    const accepted = requireQty(acceptedQty, 'Принятое количество', { min: 0 });
    const plan = planPlacements({ accepted, cellBlockId, placements });

    const record = await withTenantContext({ warehouseId }, (client) => receiveItem(client, {
      warehouseId, staffKeyId, invoiceItemId, accepted, placements: plan, pausedMs, pauseReasons, suggestionId,
    }));
    res.status(201).json(record);
  } catch (err) {
    next(err);
  }
});

// ---------- Ход приёмки прихода (владелец 27.09.2026) ----------
// Так же, как сборка поставки: действует только грузчик; руководитель и
// менеджер видят состояние, но приёмку за грузчика не начинают, не бросают и
// не заканчивают. Пауза и выход — через POST /api/journal/pause с invoiceId.

router.get('/session/:invoiceId', requireAuth, requireRole('owner', 'manager', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const out = await withTenantContext({ warehouseId }, (client) => work.readState(
      client, warehouseId, req.params.invoiceId, staffKeyId || null,
    ));
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// «Начать» в окне «Сейчас запустится таймер приёмки». takeOver — забрать
// приёмку, которую ведёт другой грузчик (он ушёл, телефон сел).
router.post('/session/:invoiceId/start', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const body = req.body || {};
    const out = await withTenantContext({ warehouseId }, (client) => work.start(
      client, warehouseId, staffKeyId, req.params.invoiceId,
      { mode: 'app', takeOver: body.takeOver === true, comment: body.comment },
    ));
    res.status(out.started ? 201 : 200).json(out);
  } catch (err) {
    next(err);
  }
});

router.post('/session/:invoiceId/abandon', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const out = await withTenantContext({ warehouseId }, (client) => work.abandon(
      client, warehouseId, staffKeyId, req.params.invoiceId, { comment: (req.body || {}).comment },
    ));
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// «Закончить приёмку». Всё принято — это конец работы с временем и
// комментарием. Остались непринятые позиции — они не приехали: каждая
// записывается как принятая нулём, то есть расхождением руководителю, как
// если бы грузчик ввёл 0 сам (так же сборка отдаёт недобор отметками «нет
// товара»). Грузчик видит это в окне «Закончить» до нажатия.
router.post('/session/:invoiceId/finish', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const out = await withTenantContext({ warehouseId }, (client) => finishReceiving(
      client, warehouseId, staffKeyId, req.params.invoiceId, { comment: (req.body || {}).comment },
    ));
    res.json(out);
  } catch (err) {
    next(err);
  }
});

async function finishReceiving(client, warehouseId, staffKeyId, invoiceId, { comment }) {
  const note = work.cleanComment(comment);
  const invoice = await work.lock(client, warehouseId, invoiceId);
  const cur = await work.liveOf(client, warehouseId, invoice.id, staffKeyId);
  if (!cur) {
    // Последняя позиция уже закрыла приёмку сама (или её закрыл список) —
    // «Закончить» ничего не ломает: показываем итог того же захода.
    const last = await work.latest(client, warehouseId, invoice.id);
    if (invoice.status === 'completed' && last && last.worker_key_id === staffKeyId && last.status === 'finished') {
      if (note) {
        await client.query(
          'UPDATE work_sessions SET comment = $2, comment_at = now(), updated_at = now() WHERE id = $1', [last.id, note]);
        await work.entry(client, warehouseId, staffKeyId, invoice,
          work.withComment(`${last.worker_name} оставил комментарий к приёмке прихода «${invoice.number}».`, note));
      }
      return {
        ...(await work.stateOf(client, warehouseId, invoice, staffKeyId)),
        minutes: Math.max(1, Math.round(work.workMs(last) / 60000)),
        notArrived: [],
      };
    }
    throw new HttpError(409, `${work.notMine(invoice)} — откройте приход заново`);
  }
  const rest = (await client.query(
    `SELECT ii.id, ii.sku, ii.name, ii.declared_qty FROM invoice_items ii
      WHERE ii.invoice_id = $1 AND NOT EXISTS (SELECT 1 FROM receiving_records rr WHERE rr.invoice_item_id = ii.id)
      ORDER BY ii.id`,
    [invoice.id],
  )).rows;
  // Сколько принято на самом деле — до того, как не приехавшее запишется
  // нулём: «принято 1 из 3 позиций. Не приехало: …», а не «3 из 3».
  const prog = (await work.progress(client, warehouseId, [invoice.id])).get(invoice.id) || { taken: 0, total: 0 };
  for (const it of rest) {
    await receiveItem(client, { warehouseId, staffKeyId, invoiceItemId: it.id, accepted: 0, closeWork: false });
  }
  const closed = await work.closeRow(client, cur, 'finished', note);
  const minutes = Math.max(1, Math.round(work.workMs(closed) / 60000));
  const notArrived = rest.map((it) => ({ sku: it.sku, name: it.name, qty: Number(it.declared_qty) }));
  await work.entry(client, warehouseId, staffKeyId, invoice, work.withComment(
    `${closed.worker_name} закончил приёмку прихода «${invoice.number}» за ${minutes} мин: ${work.takenText(prog)}`
    + (notArrived.length
      ? ` Не приехало: ${notArrived.map((x) => `«${x.name}» — ${x.qty} шт.`).join(', ')} Записано расхождением руководителю.`
      : ''),
    note));
  const fresh = (await client.query('SELECT id, number, status FROM invoices WHERE id = $1', [invoice.id])).rows[0];
  return {
    ...(await work.stateOf(client, warehouseId, fresh, staffKeyId)),
    minutes,
    notArrived,
  };
}

// Одна принятая позиция: товар в ячейки, запись приёмки, журнал, очередь для
// 1С, статус прихода. Общая для кнопки «Подтвердить» и для «Закончить
// приёмку», которая записывает не приехавшее нулём.
//
// placements — уже проверенный planPlacements список «N шт. в ячейку X».
// closeWork — закрыть заход приёмки, если эта позиция была последней
// (выключает только «Закончить приёмку»: она закрывает заход сама, со своим
// текстом и комментарием).
async function receiveItem(client, {
  warehouseId, staffKeyId, invoiceItemId, accepted, placements = [], pausedMs = 0, pauseReasons = [],
  suggestionId = null, closeWork = true,
}) {
  // Приход — на запись первым, строка — вторым: тот же порядок, что у
  // «Закончить приёмку» и у хода приёмки (receiving/session.js). Иначе две
  // транзакции по одному приходу могли бы ждать друг друга.
  await client.query(
    `SELECT i.id FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
      WHERE ii.id = $1 AND ii.warehouse_id = $2 FOR UPDATE OF i`,
    [invoiceItemId, warehouseId],
  );
  // Invoice and company are joined in for the sync payload, so the outbox
  // row carries the 1C identifiers without a second round trip.
  // Строку блокируем до проверки «уже принята»: два нажатия подряд
  // (двойной тап, повтор по таймауту) проходили проверку оба и клали
  // товар в ячейку дважды — на полке десять, в базе двадцать, и оба
  // прихода уезжали в 1С.
  const itemResult = await client.query(
    `SELECT ii.id, ii.name, ii.sku, ii.declared_qty, ii.company_id, ii.invoice_id,
            ii.external_id, i.direction,
            i.number AS invoice_number, i.external_id AS invoice_external_id,
            c.external_id AS company_external_id
     FROM invoice_items ii
     JOIN invoices i ON i.id = ii.invoice_id
     JOIN companies c ON c.id = ii.company_id AND c.archived_at IS NULL
     WHERE ii.id = $1 AND ii.warehouse_id = $2
     FOR UPDATE OF ii`,
    [invoiceItemId, warehouseId],
  );
  const item = itemResult.rows[0];
  if (!item) throw new HttpError(404, 'Позиция накладной не найдена');
  // Принять можно приход и возврат, но не заказ на отгрузку: иначе товар
  // заказа приписался бы на полку, а сам заказ закрылся бы несобранным.
  // В отгрузке такая же проверка стоит с самого начала.
  if (item.direction === 'out') {
    throw new HttpError(400, `«${item.invoice_number}» — это заказ на отгрузку, его не принимают`);
  }

  // Начали выгружать — значит, машина приехала, даже если у ворот это
  // забыли отметить.
  if (item.direction === 'in') {
    await client.query('UPDATE invoices SET arrived_at = COALESCE(arrived_at, now()) WHERE id = $1', [item.invoice_id]);
  }

  const existing = await client.query(
    `SELECT id FROM receiving_records WHERE invoice_item_id = $1`,
    [invoiceItemId],
  );
  if (existing.rows[0]) throw new HttpError(409, 'Эта позиция уже принята');

  // Все ячейки — этого склада; адреса — для записи в журнал.
  const cells = new Map();
  if (placements.length) {
    const found = await client.query(
      `SELECT cb.id, ${blockLabelSql('cb', 'wr')} AS label
         FROM cell_blocks cb JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
        WHERE cb.warehouse_id = $1 AND cb.id = ANY($2::uuid[])`,
      [warehouseId, placements.map((p) => p.cellBlockId)],
    );
    found.rows.forEach((r) => cells.set(r.id, r.label));
    if (cells.size !== placements.length) throw new HttpError(404, 'Ячейка не найдена');
  }
  const firstCell = placements.length ? placements[0].cellBlockId : null;

  // cell_block_id записи приёмки — ячейка первой укладки: на неё ведёт
  // запись журнала, по ней старые отчёты видят «размещено». Где лежит всё
  // принятое — в receiving_placements.
  const recordResult = await client.query(
    `INSERT INTO receiving_records
       (invoice_item_id, warehouse_id, company_id, accepted_qty, cell_block_id,
        worker_key_id, finished_at, paused_ms, pause_reasons)
     VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8)
     RETURNING id, accepted_qty, finished_at, paused_ms, pause_reasons`,
    [
      invoiceItemId, warehouseId, item.company_id, accepted, firstCell,
      staffKeyId, pausedMs || 0, JSON.stringify(pauseReasons || []),
    ],
  );
  const record = recordResult.rows[0];

  // Каждая укладка — своя строка остатка в своей ячейке и свой шаг.
  const placed = [];
  for (const [i, p] of placements.entries()) {
    await client.query(
      `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty)
       VALUES ($1, $2, $3, $4, $5)`,
      [p.cellBlockId, warehouseId, item.company_id, item.sku, p.qty],
    );
    const row = (await client.query(
      `INSERT INTO receiving_placements
         (receiving_record_id, invoice_item_id, warehouse_id, company_id, cell_block_id, sku, qty, step, placed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, cell_block_id, qty, step, placed_at`,
      [record.id, invoiceItemId, warehouseId, item.company_id, p.cellBlockId, item.sku, p.qty, i + 1, staffKeyId],
    )).rows[0];
    placed.push({
      id: row.id, cellBlockId: row.cell_block_id, label: cells.get(p.cellBlockId), qty: Number(row.qty), step: row.step,
    });
    // Процент считается от того, сколько штук в ячейке, а не ставится в
    // сотню при любом приходе: иначе ячейка с пятью штуками горит на карте
    // так же, как забитая под завязку.
    await refreshCellFill(client, p.cellBlockId);
  }

  const hasDiscrepancy = accepted !== Number(item.declared_qty);
  // Несколько ячеек — адреса в тексте: запись журнала ведёт только на первую.
  const where = placed.length > 1
    ? ` Разложил по ячейкам: ${placed.map((p) => `${p.label} — ${p.qty} шт.`).join(', ')}` : '';
  const actionText = (hasDiscrepancy
    ? `Нашёл расхождение по «${item.name}» (${item.sku}): заявлено ${item.declared_qty}, по факту ${accepted}.`
    : `Принял «${item.name}» (${item.sku}) по факту ${accepted} — расхождений не найдено.`) + where;
  await journal.createEntry(client, {
    warehouseId,
    agent: 'Кладовщик',
    actionText,
    entityType: 'invoice_item',
    entityId: invoiceItemId,
    invoiceId: item.invoice_id,
    cellBlockId: firstCell,
    actorType: 'worker',
    actorId: staffKeyId,
    status: hasDiscrepancy ? 'pending' : 'auto',
  });

  // Same transaction as the stock movement above — a receiving record can
  // never exist without the event that tells 1C about it. В 1С — одна
  // приёмка позиции, сколько бы ячеек ни было.
  await outbox.appendReceiving(client, {
    warehouseId,
    item,
    invoice: {
      id: item.invoice_id,
      number: item.invoice_number,
      external_id: item.invoice_external_id,
    },
    company: { id: item.company_id, external_id: item.company_external_id },
    actualQty: accepted,
  });

  // Чем кончилась подсказка: согласился работник или положил по-своему.
  // Выводов пока никаких — сначала факты, потом правило.
  await kladovshchik.recordSuggestionOutcome(client, warehouseId, suggestionId, firstCell);

  const remaining = await client.query(
    `SELECT COUNT(*)::int AS n FROM invoice_items ii
     WHERE ii.invoice_id = $1 AND NOT EXISTS (
       SELECT 1 FROM receiving_records rr WHERE rr.invoice_item_id = ii.id
     )`,
    [item.invoice_id],
  );
  const newStatus = remaining.rows[0].n === 0 ? 'completed' : 'in_progress';
  await client.query(`UPDATE invoices SET status = $2 WHERE id = $1`, [item.invoice_id, newStatus]);

  // Последняя позиция — приёмка закончена: заход закрывается здесь же, в
  // этой транзакции (случай 27.09.2026 — окно «Закончить» закрылось мимо, и
  // заход остался на паузе у принятого прихода). Экран получает итог сразу.
  let finished = null;
  if (newStatus === 'completed' && item.direction === 'in' && closeWork) {
    const [row] = await work.settle(client, warehouseId, [item.invoice_id], { force: true });
    if (row) {
      const invoice = { id: item.invoice_id, number: item.invoice_number, status: newStatus };
      finished = {
        ...(await work.stateOf(client, warehouseId, invoice, staffKeyId)),
        minutes: Math.max(1, Math.round(work.workMs(row) / 60000)),
        notArrived: [],
      };
    }
  }
  return {
    ...record,
    placements: placed,
    invoiceStatus: newStatus,
    // Итог приёмки, если эта позиция закрыла приход: тот же ответ, что у
    // «Закончить приёмку».
    finished,
  };
}

module.exports = router;
