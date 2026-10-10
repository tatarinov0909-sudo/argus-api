const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { withWorkerCommand } = require('../worker/commands');
const { HttpError } = require('../middleware/errorHandler');
const { requireQty } = require('../middleware/qty');
const { refreshCellFill } = require('../cells/fill');
const defects = require('../defects/service');
const { takeFromCell } = require('../cells/move');
const { blockLabelSql } = require('../cells/label');
const journal = require('../journal/repository');
const kladovshchik = require('../agents/kladovshchik');
const outbox = require('../sync/outbox');
const work = require('./session');
const vwarehouses = require('../vwarehouses/service');
const addressing = require('../cells/addressing');

const router = express.Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PLACEMENTS = 20;

// Куда лёг принятый товар — первые укладки «N шт. в ячейку X».
//
// Раскладка по шагам (задание 28.09.2026, п. 1): принятое и раскладка —
// отдельно. Пришло 300 — комплектовщик принимает 300 и кладёт в первую ячейку
// сколько влезло (по умолчанию всё); остаток раскладывает следующими шагами
// (POST /items/:id/place). Позиция не закончена, а приход не закрывается,
// пока всё принятое не разложено.
//
// placements: [{cellBlockId, qty}] — одна или несколько ячеек сразу, в сумме
// не больше принятого, одна ячейка — один раз. cellBlockId — одна ячейка, всё
// принятое туда. Принять без ячейки («своё место») нельзя: всё принятое
// лежит в конкретной ячейке. Ноль класть некуда — «не приехало» без ячейки.
function planPlacements({ accepted, cellBlockId, placements, defectQty = 0 }) {
  if (defectQty > accepted) throw new HttpError(400, `Брака ${defectQty} шт., а принято ${accepted} — брак входит в принятое`);
  if (placements != null) {
    if (cellBlockId) throw new HttpError(400, 'Ячейка указана и одна, и списком — нужно что-то одно');
    if (!Array.isArray(placements) || !placements.length) throw new HttpError(400, 'Укажите, в какую ячейку кладёте товар');
    if (placements.length > MAX_PLACEMENTS) throw new HttpError(400, `Не больше ${MAX_PLACEMENTS} ячеек на один товар`);
    if (accepted === 0) throw new HttpError(400, 'Ничего не принято — класть в ячейку нечего');
    const seen = new Set();
    const plan = placements.map((p) => {
      const id = p && typeof p.cellBlockId === 'string' ? p.cellBlockId : '';
      if (!UUID.test(id)) throw new HttpError(400, 'Ячейка не найдена');
      if (seen.has(id)) throw new HttpError(400, 'Одна ячейка указана дважды — поставьте её количество одной строкой');
      seen.add(id);
      return { cellBlockId: id, qty: requireQty(p.qty, 'Сколько кладёте в ячейку', { min: 1 }) };
    });
    const sum = plan.reduce((a, p) => a + p.qty, 0);
    if (sum + defectQty > accepted) {
      throw new HttpError(400, `Разложено ${sum + defectQty} шт.${defectQty ? ` (из них брак ${defectQty})` : ''}, а принято ${accepted} — уберите лишние ${sum + defectQty - accepted}`);
    }
    return plan;
  }
  if (cellBlockId) {
    if (typeof cellBlockId !== 'string' || !UUID.test(cellBlockId)) throw new HttpError(404, 'Ячейка не найдена');
    // Ноль класть некуда: раньше в ячейке появлялась пустая строка остатка.
    if (accepted - defectQty <= 0) throw new HttpError(400, 'Всё принятое — брак: годное в ячейку класть нечего');
    return [{ cellBlockId, qty: accepted - defectQty }];
  }
  // Брак отметили до раскладки (кнопка «Брак», владелец 02.10.2026): брак —
  // в ячейку брака, годное остаётся «разложить» следующими шагами.
  if (accepted > 0 && defectQty > 0) return [];
  if (accepted > 0) {
    throw new HttpError(400, 'Укажите ячейку: принятый товар кладут в конкретную ячейку, без ячейки принять нельзя');
  }
  return [];
}

// Брак при приёмке: { qty, bucket, note, cellBlockId }. Нет — null.
function readDefect(defect) {
  if (defect == null) return null;
  if (typeof defect !== 'object') throw new HttpError(400, 'Брак — сколько, вид, описание и ячейка');
  const qty = requireQty(defect.qty, 'Сколько брака', { min: 1 });
  defects.requireBucket(defect.bucket);
  if (typeof defect.cellBlockId !== 'string' || !UUID.test(defect.cellBlockId)) {
    throw new HttpError(400, 'Укажите ячейку для брака');
  }
  return { qty, bucket: defect.bucket, note: defects.cleanNote(defect.note), cellBlockId: defect.cellBlockId };
}

// Worker submits one line item: actual quantity, the first cell(s) it went
// to, and the pause tally the client already tracked locally during the session.
router.post('/', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const {
      invoiceItemId, acceptedQty, cellBlockId, placements, pausedMs, pauseReasons, suggestionId, defect,
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
    // Брак при приёмке (владелец 02.10.2026): часть принятого — брак, он
    // ложится в ячейку брака, на склад брака продавца.
    const defectPlan = readDefect(defect);
    const plan = planPlacements({ accepted, cellBlockId, placements, defectQty: defectPlan ? defectPlan.qty : 0 });

    const record = await withWorkerCommand(req, async (client) => {
      // Адресное хранение выключено (06.10.2026): всё — в «Склад», одной строкой.
      let places = plan;
      if (await addressing.isOff(client, warehouseId)) {
        const general = await addressing.ensureGeneral(client, warehouseId);
        const qty = plan.reduce((n, x) => n + x.qty, 0);
        places = qty ? [{ cellBlockId: general, qty }] : [];
        if (defectPlan) defectPlan.cellBlockId = general;
      }
      return receiveItem(client, {
        warehouseId, staffKeyId, invoiceItemId, accepted, placements: places, pausedMs, pauseReasons, suggestionId,
        requireWork: true, defect: defectPlan, completionEvent: req.workerCommand,
      });
    });
    res.status(201).json(record);
  } catch (err) {
    next(err);
  }
});

// ---------- Ход приёмки прихода (владелец 27.09.2026) ----------
// Так же, как сборка поставки: действует только комплектовщик; руководитель и
// менеджер видят состояние, но приёмку за комплектовщика не начинают, не бросают и
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
// приёмку, которую ведёт другой комплектовщик (он ушёл, телефон сел).
router.post('/session/:invoiceId/start', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const body = req.body || {};
    const out = await withWorkerCommand(req, (client) => work.start(
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
    const out = await withWorkerCommand(req, (client) => work.abandon(
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
// если бы комплектовщик ввёл 0 сам (так же сборка отдаёт недобор отметками «нет
// товара»). Комплектовщик видит это в окне «Закончить» до нажатия.
router.post('/session/:invoiceId/finish', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const out = await withWorkerCommand(req, (client) => finishReceiving(
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
  // Принятое, но не разложенное — приёмку не закончить (задание 28.09.2026):
  // сначала в ячейки. Экран показывает это в окне «Закончить» заранее.
  const unplaced = await unplacedItems(client, invoice.id);
  if (unplaced.length) {
    throw new HttpError(409, `Не разложено по ячейкам: ${unplaced.map((u) => `«${u.name}» — ${u.left} шт.`).join(', ')}`
      + ' Разложите и закончите приёмку.');
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
  suggestionId = null, closeWork = true, defect = null, completionEvent = null,
  // Приход принимает только тот, кто ведёт приёмку, и не на паузе
  // (requireActive). «Закончить приёмку» уже проверила заход сама — ей можно
  // и с паузы.
  requireWork = false,
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
  // Возврат разбирается только своим экраном (годное, брак) — второй путь
  // проводил один возврат дважды (проверка 03.10.2026).
  if (item.direction === 'return') {
    throw new HttpError(400, `«${item.invoice_number}» — это возврат, его разбирают в «Возвратах»`);
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
  // После «уже принята»: по этому ответу экран комплектовщика идёт к следующей.
  if (requireWork && item.direction === 'in') {
    await work.requireActive(client, warehouseId, staffKeyId, { id: item.invoice_id, number: item.invoice_number });
  }

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
  for (const p of placements) {
    const row = await putStep(client, {
      warehouseId, staffKeyId, recordId: record.id, item: { ...item, id: invoiceItemId }, cellBlockId: p.cellBlockId, qty: p.qty,
    });
    placed.push({
      id: row.id, cellBlockId: row.cell_block_id, label: cells.get(p.cellBlockId), qty: Number(row.qty), step: row.step,
    });
  }
  // Брак — своим шагом: в ячейку брака с состоянием «брак», документ
  // «Перемещение на склад брака».
  let defectMove = null;
  if (defect) {
    const step = await putStep(client, {
      warehouseId, staffKeyId, recordId: record.id, item: { ...item, id: invoiceItemId },
      cellBlockId: defect.cellBlockId, qty: defect.qty, quality: defect.bucket,
    });
    defectMove = await defects.createMove(client, {
      warehouseId, companyId: item.company_id, sku: item.sku, qty: defect.qty, bucket: defect.bucket,
      note: defect.note, source: 'receiving', invoiceId: item.invoice_id, cellBlockId: defect.cellBlockId, staffKeyId,
      vw: await itemVw(client, invoiceItemId),
    });
    placed.push({ id: step.id, cellBlockId: step.cell_block_id, qty: Number(step.qty), step: step.step, defect: true });
  }
  const unplaced = accepted - placed.reduce((a, p) => a + p.qty, 0);

  const hasDiscrepancy = accepted !== Number(item.declared_qty);
  // Несколько ячеек — адреса в тексте: запись журнала ведёт только на первую.
  // Всё в одну ячейку — адрес и так на ссылке записи.
  const goodPlaced = placed.filter((p) => !p.defect);
  const where = (goodPlaced.length > 1
    ? ` Разложил по ячейкам: ${goodPlaced.map((p) => `${p.label} — ${p.qty} шт.`).join(', ')}`
    : goodPlaced.length && unplaced > 0 ? ` Положил ${goodPlaced[0].qty} шт. в ячейку ${goodPlaced[0].label}.` : '')
    + (defectMove ? ` Из них брак ${defectMove.qty} шт. — на склад брака (${defectMove.number}).` : '');
  const actionText = (hasDiscrepancy
    ? `Нашёл расхождение по «${item.name}» (${item.sku}): заявлено ${item.declared_qty}, по факту ${accepted}.`
    : `Принял «${item.name}» (${item.sku}) по факту ${accepted} — расхождений не найдено.`) + where
    + (unplaced > 0 ? ` Осталось разложить ${unplaced} шт.` : '');
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

  const { status: newStatus, finished } = await settleInvoice(client, {
    warehouseId, staffKeyId, invoiceId: item.invoice_id, number: item.invoice_number, direction: item.direction, closeWork, completionEvent,
  });
  return {
    ...record,
    placements: placed.filter((p) => !p.defect),
    defects: defectMove ? [{ ...defectMove, cellBlockId: defect.cellBlockId }] : [],
    unplaced,
    invoiceStatus: newStatus,
    // Итог приёмки, если эта позиция закрыла приход: тот же ответ, что у
    // «Закончить приёмку».
    finished,
  };
}

// Приход принят, когда каждая позиция принята (в том числе нулём — «не
// приехало») и всё принятое разложено по ячейкам (задание 28.09.2026).
// Тогда заход приёмки закрывается здесь же, в этой транзакции (случай
// 27.09.2026 — окно «Закончить» закрылось мимо, и заход остался на паузе у
// принятого прихода). Экран получает итог сразу.
async function settleInvoice(client, { warehouseId, staffKeyId, invoiceId, number, direction, closeWork = true, completionEvent = null }) {
  const left = (await client.query(
    `SELECT count(*) FILTER (WHERE rr.id IS NULL)::int AS open,
            count(*) FILTER (WHERE rr.accepted_qty > COALESCE(p.placed, 0))::int AS unplaced
       FROM invoice_items ii
       LEFT JOIN receiving_records rr ON rr.invoice_item_id = ii.id
       LEFT JOIN LATERAL (SELECT SUM(rp.qty) AS placed FROM receiving_placements rp
                           WHERE rp.receiving_record_id = rr.id) p ON true
      WHERE ii.invoice_id = $1`,
    [invoiceId],
  )).rows[0];
  const status = left.open === 0 && left.unplaced === 0 ? 'completed' : 'in_progress';
  const was = (await client.query('SELECT status FROM invoices WHERE id = $1', [invoiceId])).rows[0];
  await client.query('UPDATE invoices SET status = $2 WHERE id = $1', [invoiceId, status]);
  // Приход только что принят: товар одной позиции на разных складах продавца
  // принят не так, как заявлен, — продавцу уведомление или его решение.
  if (status === 'completed' && direction === 'in' && was && was.status !== 'completed') {
    await vwarehouses.receivingSplits(client, { warehouseId, invoiceId });
  }
  let finished = null;
  if (status === 'completed' && direction === 'in' && closeWork) {
    const [row] = await work.settle(client, warehouseId, [invoiceId], { force: true, completionEvent });
    if (row) {
      finished = {
        ...(await work.stateOf(client, warehouseId, { id: invoiceId, number, status }, staffKeyId)),
        minutes: Math.max(1, Math.round(work.workMs(row) / 60000)),
        notArrived: [],
      };
    }
  }
  return { status, finished };
}

// Что принято, но ещё не разложено: позиция и сколько осталось.
async function unplacedItems(client, invoiceId) {
  const r = await client.query(
    `SELECT ii.id, ii.name, ii.sku, rr.accepted_qty - COALESCE(p.placed, 0) AS left
       FROM invoice_items ii
       JOIN receiving_records rr ON rr.invoice_item_id = ii.id
       LEFT JOIN LATERAL (SELECT SUM(rp.qty) AS placed FROM receiving_placements rp
                           WHERE rp.receiving_record_id = rr.id) p ON true
      WHERE ii.invoice_id = $1 AND rr.accepted_qty > COALESCE(p.placed, 0)
      ORDER BY ii.id`,
    [invoiceId],
  );
  return r.rows.map((x) => ({ id: x.id, name: x.name, sku: x.sku, left: Number(x.left) }));
}

// Виртуальный склад строки документа: null — «Основной».
async function itemVw(client, invoiceItemId) {
  const r = (await client.query('SELECT virtual_warehouse_id FROM invoice_items WHERE id = $1', [invoiceItemId])).rows[0];
  return r ? r.virtual_warehouse_id || null : null;
}

// Шаг «положил N шт. в ячейку»: строка остатка в ячейке и строка укладки со
// следующим номером шага. pairId — у второй половины «Переложить»: шаг
// «забрал», к которому она относится.
async function putStep(client, {
  warehouseId, staffKeyId, recordId, item, cellBlockId, qty, pairId = null, quality = 'good',
}) {
  // Товар ложится на склад строки привоза (виртуальный склад продавца,
  // 02.10.2026); не выбран — «Основной». Склад «хранить отдельно» не
  // смешивается с другими, зона склада — только его.
  await require('../vwarehouses/separate').checkPut(client, warehouseId, {
    cellBlockId, companyId: item.company_id, vw: await itemVw(client, item.id), quality,
  });
  await client.query(
    `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty, quality, virtual_warehouse_id)
     VALUES ($1, $2, $3, $4, $5, $6, (SELECT virtual_warehouse_id FROM invoice_items WHERE id = $7))`,
    [cellBlockId, warehouseId, item.company_id, item.sku, qty, quality, item.id],
  );
  const row = (await client.query(
    `INSERT INTO receiving_placements
       (receiving_record_id, invoice_item_id, warehouse_id, company_id, cell_block_id, sku, qty, step, placed_by, kind, pair_id, quality)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             (SELECT COALESCE(MAX(step), 0) + 1 FROM receiving_placements WHERE receiving_record_id = $1), $8, 'put', $9, $10)
     RETURNING id, cell_block_id, qty, step, placed_at`,
    [recordId, item.id, warehouseId, item.company_id, cellBlockId, item.sku, qty, staffKeyId, pairId, quality],
  )).rows[0];
  // Процент считается от того, сколько штук в ячейке, а не ставится в
  // сотню при любом приходе: иначе ячейка с пятью штуками горит на карте
  // так же, как забитая под завязку.
  await refreshCellFill(client, cellBlockId);
  return row;
}

// Шаг «забрал N шт. из ячейки»: товар снимается с полки (строки остатка —
// с самой давней), укладка пишется с минусом. Позже шаг подтвердят сканом
// QR ячейки.
async function takeStep(client, { warehouseId, staffKeyId, recordId, item, cellBlockId, qty }) {
  // С полки снимается самое свежее этого товара — то, что положила эта
  // приёмка, а не весенний остаток: иначе весенний товар «молодел» бы, а его
  // время укладки и порядок «сначала старое» врали.
  // Только товар склада этой строки привоза: не чужой склад того же продавца.
  const vw = await itemVw(client, item.id);
  await takeFromCell(client, warehouseId, { cellBlockId, sku: item.sku, companyId: item.company_id, qty, verb: 'забрать', newest: true, vw });
  const row = (await client.query(
    `INSERT INTO receiving_placements
       (receiving_record_id, invoice_item_id, warehouse_id, company_id, cell_block_id, sku, qty, step, placed_by, kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             (SELECT COALESCE(MAX(step), 0) + 1 FROM receiving_placements WHERE receiving_record_id = $1), $8, 'take')
     RETURNING id, cell_block_id, qty, step, placed_at`,
    [recordId, item.id, warehouseId, item.company_id, cellBlockId, item.sku, -qty, staffKeyId],
  )).rows[0];
  await refreshCellFill(client, cellBlockId);
  return row;
}

// Раскладка позиции сейчас: ячейка и сколько в ней лежит (сумма шагов), в
// порядке первой укладки.
async function layoutOf(client, recordId, quality = 'good') {
  const r = await client.query(
    `SELECT rp.cell_block_id, SUM(rp.qty) AS qty, ${blockLabelSql('cb', 'wr')} AS label
       FROM receiving_placements rp
       JOIN cell_blocks cb ON cb.id = rp.cell_block_id
       JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
      WHERE rp.receiving_record_id = $1 AND rp.quality = $2
      GROUP BY rp.cell_block_id, cb.id, wr.id
     HAVING SUM(rp.qty) > 0
      ORDER BY MIN(rp.step)`,
    [recordId, quality],
  );
  return r.rows.map((x) => ({ cellBlockId: x.cell_block_id, label: x.label, qty: Number(x.qty) }));
}

// Брак позиции на складе брака — по ячейкам (оба вида брака).
async function defectLayoutOf(client, recordId) {
  const r = await client.query(
    `SELECT rp.cell_block_id, rp.quality, SUM(rp.qty) AS qty, ${blockLabelSql('cb', 'wr')} AS label
       FROM receiving_placements rp
       JOIN cell_blocks cb ON cb.id = rp.cell_block_id
       JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
      WHERE rp.receiving_record_id = $1 AND rp.quality <> 'good'
      GROUP BY rp.cell_block_id, rp.quality, cb.id, wr.id
     HAVING SUM(rp.qty) > 0
      ORDER BY MIN(rp.step)`,
    [recordId],
  );
  return r.rows.map((x) => ({ cellBlockId: x.cell_block_id, label: x.label, qty: Number(x.qty), bucket: x.quality }));
}

// Ячейка записи приёмки — первая, где товар позиции лежит сейчас: на неё
// ведёт запись журнала, по ней старые отчёты видят «размещено». Всё убрали —
// пусто.
async function syncRecordCell(client, recordId) {
  await client.query(
    `UPDATE receiving_records SET cell_block_id = (
       SELECT rp.cell_block_id FROM receiving_placements rp
        WHERE rp.receiving_record_id = $1 AND rp.cell_block_id IS NOT NULL
        GROUP BY rp.cell_block_id HAVING SUM(rp.qty) > 0 ORDER BY MIN(rp.step) LIMIT 1)
      WHERE id = $1`,
    [recordId],
  );
}

// ---------- Раскладка принятого (задание 28.09.2026, п. 1) ----------
// «Осталось разложить 50 шт.» — следующая ячейка; «Переложить» — забрать N
// шт. из одной ячейки и положить в другую; «Убрать из ячейки» — вернуть в
// «осталось разложить». Каждое — отдельный шаг раскладки и запись журнала.
// Только пока приход не принят: после — через «Перепаковка и перестановка»,
// чтобы закрытый акт не менялся задним числом.

// action 'place' на уже принятом приходе — только для старого «своего места»
// (принято без ячейки до 28.09.2026): его разложить можно и после приёмки —
// акт от этого не меняется, а иначе товар навсегда «не размещён». Такой
// приход не переоткрывается, заход для этого не нужен.
async function lockPlacing(client, warehouseId, invoiceItemId, { staffKeyId, action }) {
  if (!UUID.test(String(invoiceItemId || ''))) throw new HttpError(404, 'Позиция накладной не найдена');
  // Приход — на запись первым, строка — вторым: тот же порядок, что у приёмки.
  const invoice = (await client.query(
    `SELECT i.id, i.number, i.status, i.direction FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
      WHERE ii.id = $1 AND ii.warehouse_id = $2 FOR UPDATE OF i`,
    [invoiceItemId, warehouseId],
  )).rows[0];
  if (!invoice) throw new HttpError(404, 'Позиция накладной не найдена');
  const item = (await client.query(
    `SELECT ii.id, ii.name, ii.sku, ii.company_id, rr.id AS record_id, rr.accepted_qty,
            COALESCE((SELECT SUM(rp.qty) FROM receiving_placements rp WHERE rp.receiving_record_id = rr.id), 0) AS placed
       FROM invoice_items ii
       LEFT JOIN receiving_records rr ON rr.invoice_item_id = ii.id
      WHERE ii.id = $1 FOR UPDATE OF ii`,
    [invoiceItemId],
  )).rows[0];
  if (!item.record_id) throw new HttpError(409, 'Сначала примите товар: сколько пришло и первая ячейка');
  const unplaced = Number(item.accepted_qty) - Number(item.placed);
  const legacy = invoice.status === 'completed' && action === 'place' && unplaced > 0;
  if (invoice.status === 'completed' && !legacy) {
    throw new HttpError(409, `Приход «${invoice.number}» уже принят — переложить товар можно через «Перепаковка и перестановка»`);
  }
  if (!legacy) await work.requireActive(client, warehouseId, staffKeyId, invoice);
  return { invoice, item, unplaced, legacy };
}

async function cellLabelOf(client, warehouseId, cellBlockId) {
  if (typeof cellBlockId !== 'string' || !UUID.test(cellBlockId)) throw new HttpError(404, 'Ячейка не найдена');
  const r = await client.query(
    `SELECT ${blockLabelSql('cb', 'wr')} AS label FROM cell_blocks cb JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
      WHERE cb.warehouse_id = $1 AND cb.id = $2`,
    [warehouseId, cellBlockId],
  );
  if (!r.rows[0]) throw new HttpError(404, 'Ячейка не найдена');
  return r.rows[0].label;
}

async function inCell(client, recordId, cellBlockId) {
  const r = await client.query(
    "SELECT COALESCE(SUM(qty), 0) AS n FROM receiving_placements WHERE receiving_record_id = $1 AND cell_block_id = $2 AND quality = 'good'",
    [recordId, cellBlockId],
  );
  return Number(r.rows[0].n);
}

// Шаг сделан: ячейка записи приёмки, запись журнала, статус прихода (всё
// разложено — принят, заход закрыт) и раскладка позиции для экрана.
async function placingDone(client, {
  warehouseId, staffKeyId, invoice, item, journalText, entryStep, cellBlockId, legacy = false, skipJournal = false, completionEvent = null,
}) {
  await syncRecordCell(client, item.record_id);
  if (!skipJournal) await journal.createEntry(client, {
    warehouseId,
    agent: 'Кладовщик',
    actionText: journalText,
    entityType: 'receiving_placement',
    entityId: entryStep.id,
    invoiceId: invoice.id,
    cellBlockId,
    actorType: 'worker',
    actorId: staffKeyId,
  });
  // Старое «своё место» принятого прихода — приход остаётся принятым.
  const { status, finished } = legacy ? { status: invoice.status, finished: null } : await settleInvoice(client, {
    warehouseId, staffKeyId, invoiceId: invoice.id, number: invoice.number, direction: invoice.direction, completionEvent,
  });
  const placed = await client.query(
    'SELECT COALESCE(SUM(qty), 0) AS n FROM receiving_placements WHERE receiving_record_id = $1', [item.record_id]);
  return {
    invoiceItemId: item.id,
    placements: await layoutOf(client, item.record_id),
    defects: await defectLayoutOf(client, item.record_id),
    unplaced: Number(item.accepted_qty) - Number(placed.rows[0].n),
    invoiceStatus: status,
    finished,
  };
}

const what = (item) => `«${item.name}» (${item.sku})`;

// «Осталось разложить 50 шт.» → следующая ячейка.
router.post('/items/:invoiceItemId/place', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const body = req.body || {};
    const qty = requireQty(body.qty, 'Сколько кладёте в ячейку', { min: 1 });
    const out = await withWorkerCommand(req, async (client) => {
      const { invoice, item, unplaced, legacy } = await lockPlacing(client, warehouseId, req.params.invoiceItemId, { staffKeyId, action: 'place' });
      if (unplaced <= 0) throw new HttpError(409, 'Всё принятое уже разложено');
      if (qty > unplaced) throw new HttpError(400, `Осталось разложить ${unplaced} шт. — больше положить нельзя`);
      // Адресное хранение выключено (06.10.2026): кладут в «Склад».
      const cellBlockId = await addressing.place(client, warehouseId, body.cellBlockId);
      const label = await cellLabelOf(client, warehouseId, cellBlockId);
      const step = await putStep(client, {
        warehouseId, staffKeyId, recordId: item.record_id, item, cellBlockId, qty,
      });
      const left = unplaced - qty;
      return placingDone(client, {
        warehouseId, staffKeyId, invoice, item, entryStep: step, cellBlockId, legacy, completionEvent: req.workerCommand,
        journalText: `Положил ${qty} шт. ${what(item)} в ячейку ${label}. `
          + (left ? `Осталось разложить ${left} шт.` : `Разложено всё принятое — ${Number(item.accepted_qty)} шт.`),
      });
    });
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
});

// «Брак» на экране приёмки (владелец 02.10.2026): часть уже принятого, но
// ещё не разложенного — брак. Ложится в ячейку брака, на склад брака.
router.post('/items/:invoiceItemId/defect', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const plan = readDefect(req.body || {});
    const out = await withWorkerCommand(req, async (client) => {
      const { invoice, item, unplaced, legacy } = await lockPlacing(client, warehouseId, req.params.invoiceItemId, { staffKeyId, action: 'defect' });
      if (unplaced <= 0) throw new HttpError(409, 'Всё принятое уже разложено — брак отметьте через «Перепаковка и перестановка»');
      if (plan.qty > unplaced) throw new HttpError(400, `Осталось разложить ${unplaced} шт. — брака больше быть не может`);
      plan.cellBlockId = await addressing.place(client, warehouseId, plan.cellBlockId);
      await cellLabelOf(client, warehouseId, plan.cellBlockId);
      const step = await putStep(client, {
        warehouseId, staffKeyId, recordId: item.record_id, item, cellBlockId: plan.cellBlockId, qty: plan.qty, quality: plan.bucket,
      });
      const move = await defects.createMove(client, {
        warehouseId, companyId: item.company_id, sku: item.sku, qty: plan.qty, bucket: plan.bucket, note: plan.note,
        source: 'receiving', invoiceId: invoice.id, cellBlockId: plan.cellBlockId, staffKeyId,
        vw: await itemVw(client, item.id),
      });
      const done = await placingDone(client, {
        warehouseId, staffKeyId, invoice, item, entryStep: step, cellBlockId: plan.cellBlockId, legacy, skipJournal: true,
      });
      return { ...done, move };
    });
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
});

// «Переложить»: забрать N шт. из одной ячейки и положить в другую.
router.post('/items/:invoiceItemId/move', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const body = req.body || {};
    const qty = requireQty(body.qty, 'Сколько перекладываете', { min: 1 });
    // Та же ячейка — и когда тот же номер прислали заглавными буквами.
    if (String(body.fromCellBlockId || '').toLowerCase() === String(body.toCellBlockId || '').toLowerCase()) {
      throw new HttpError(400, 'Это та же ячейка — выберите другую');
    }
    const out = await withWorkerCommand(req, async (client) => {
      const { invoice, item } = await lockPlacing(client, warehouseId, req.params.invoiceItemId, { staffKeyId, action: 'move' });
      const from = await cellLabelOf(client, warehouseId, body.fromCellBlockId);
      const to = await cellLabelOf(client, warehouseId, body.toCellBlockId);
      const here = await inCell(client, item.record_id, body.fromCellBlockId);
      if (here <= 0) throw new HttpError(409, `В ячейке ${from} этого товара из этой приёмки нет`);
      if (qty > here) throw new HttpError(400, `В ячейку ${from} положено ${here} шт. — переложить больше нельзя`);
      const take = await takeStep(client, {
        warehouseId, staffKeyId, recordId: item.record_id, item, cellBlockId: body.fromCellBlockId, qty,
      });
      const put = await putStep(client, {
        warehouseId, staffKeyId, recordId: item.record_id, item, cellBlockId: body.toCellBlockId, qty, pairId: take.id,
      });
      return placingDone(client, {
        warehouseId, staffKeyId, invoice, item, entryStep: put, cellBlockId: body.toCellBlockId,
        journalText: `Переложил ${qty} шт. ${what(item)} из ячейки ${from} в ячейку ${to}.`,
      });
    });
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
});

// «Убрать из ячейки»: вернуть N шт. в «осталось разложить».
router.post('/items/:invoiceItemId/remove', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const body = req.body || {};
    const qty = requireQty(body.qty, 'Сколько убираете из ячейки', { min: 1 });
    const out = await withWorkerCommand(req, async (client) => {
      const { invoice, item, unplaced } = await lockPlacing(client, warehouseId, req.params.invoiceItemId, { staffKeyId, action: 'remove' });
      const label = await cellLabelOf(client, warehouseId, body.cellBlockId);
      const here = await inCell(client, item.record_id, body.cellBlockId);
      if (here <= 0) throw new HttpError(409, `В ячейке ${label} этого товара из этой приёмки нет`);
      if (qty > here) throw new HttpError(400, `В ячейку ${label} положено ${here} шт. — убрать больше нельзя`);
      const take = await takeStep(client, {
        warehouseId, staffKeyId, recordId: item.record_id, item, cellBlockId: body.cellBlockId, qty,
      });
      return placingDone(client, {
        warehouseId, staffKeyId, invoice, item, entryStep: take, cellBlockId: body.cellBlockId,
        journalText: `Убрал ${qty} шт. ${what(item)} из ячейки ${label} — осталось разложить ${unplaced + qty} шт.`,
      });
    });
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
