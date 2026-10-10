const vwarehouses = require('../vwarehouses/service');
const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { withWorkerCommand } = require('../worker/commands');
const { HttpError } = require('../middleware/errorHandler');
const repository = require('./repository');
const assembly = require('../shipping/assembly');
const receiving = require('../receiving/session');
const { zoneOf } = require('../warehouses/time');
const { readDay, dayPage } = require('./paging');

const router = express.Router();

// Journal is owner-only (workers act, they don't watch the log; sellers
// never see it at all — see the RLS policy note in the initial migration).
router.get('/', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    // ?cellBlockId= / ?invoiceId= — история одного места или одного документа.
    // Фильтруем в базе, а не в кабинете: в ленте лежат последние 200 записей,
    // и старая история ячейки в них попросту не попадёт.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const one = (v, name) => {
      if (!v) return null;
      if (!uuid.test(String(v))) throw new HttpError(400, `Некорректный ${name}`);
      return String(v);
    };
    const cellBlockId = one(req.query.cellBlockId, 'cellBlockId');
    const invoiceId = one(req.query.invoiceId, 'invoiceId');
    const selectedDay = req.query.date !== undefined;
    // Validate before settle, so an invalid calendar request cannot run work
    // state transitions. Legacy callers continue receiving the array.
    if (selectedDay) readDay(req.query);

    const hideUrgent = req.auth.role === 'manager' && !(req.auth.grants || []).includes('shortages');
    const entries = await withTenantContext({ warehouseId }, async (client) => {
      const scope = { cellBlockId, invoiceId, hideUrgent };
      const page = selectedDay ? dayPage(req.query, {
        warehouseId, ...scope, timezone: await zoneOf(client, warehouseId),
      }) : null;
      // Зависшие заходы — закрыть до чтения: иначе у принятого прихода в
      // журнале висело бы «принимает» (защита, work/sessions.js — settle).
      await receiving.settle(client, warehouseId);
      await assembly.settle(client, warehouseId);
      const result = page ? await repository.listDay(client, warehouseId, page, scope)
        : await repository.listEntries(client, warehouseId, scope);
      const rows = page ? [...result.entries, ...result.pending] : result;
      // Сборка поставки уходит в кабинет одной записью с полосой готовности,
      // поэтому к строкам этой поставки прикладываем её счёт позиций.
      const supplyIds = [...new Set(rows.map((r) => r.invoice_supply_id).filter(Boolean))];
      const progress = await repository.supplyPickProgress(client, warehouseId, supplyIds);
      rows.forEach((row) => {
        const done = progress.get(row.invoice_supply_id);
        if (!done) return;
        row.supply_items_total = done.total;
        row.supply_items_done = done.done;
      });
      // Одна строка на работу: у каждой записи — её работа и то, как эта
      // работа идёт сейчас (этап и прогресс для строки состояния).
      const works = await repository.workStates(client, warehouseId, rows.map((r) => r.work_key), { receiving, assembly });
      rows.forEach((row) => { row.work = works.get(row.work_key) || null; });
      return result;
    });
    res.json(entries);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/resolve', requireAuth, requireRole('owner', 'manager'), async (req, res, next) => {
  try {
    const { warehouseId, ownerId, role, staffKeyId } = req.auth;
    const { id } = req.params;
    // resolution: 'confirm' | 'rollback'; у записки комплектовщика о товаре —
    // 'ack', «Принял к сведению»: соглашаться там не с чем.
    const { resolution, note } = req.body;
    if (!['confirm', 'rollback', 'ack'].includes(resolution)) {
      throw new HttpError(400, 'resolution должен быть confirm, rollback или ack');
    }

    const entry = await withTenantContext({ warehouseId }, async (client) => {
      const original = await client.query(
        `SELECT agent, urgent, entity_type,
                EXISTS (SELECT 1 FROM journal_entries a WHERE a.related_entry_id = je.id) AS answered
           FROM journal_entries je WHERE id = $1 AND warehouse_id = $2`,
        [id, warehouseId],
      );
      if (!original.rows[0]) return null;
      // «Принял к сведению» — записки комплектовщика и предупреждение «зона склада
      // продавца заполнена» (02.10.2026): соглашаться там не с чем.
      const ackOnly = ACK_TYPES.has(original.rows[0].entity_type);
      if (ackOnly !== (resolution === 'ack')) {
        throw new HttpError(400, ackOnly
          ? 'Такую запись отмечают «Принял к сведению»'
          : '«Принял к сведению» — только для записок комплектовщика о товаре и предупреждений о зоне склада');
      }
      // Второй ответ на одну запись — два противоречащих решения в следе.
      // Так бывает с открытого давно кабинета: заказ уже убрали из поставки,
      // а на экране ещё висит «Принять».
      if (original.rows[0].answered) throw new HttpError(409, 'По этой записи уже решено');
      // Срочную отметку решает тот, кому она адресована: менеджер без права
      // «отметки о нехватке» её и не видит.
      // Заявка продавца на перенос — не отметка «нет товара»: её решает любой
      // менеджер (переносы ему разрешены; проверка 03.10.2026).
      if (original.rows[0].urgent && original.rows[0].entity_type !== 'vw_transfer'
          && role === 'manager' && !(req.auth.grants || []).includes('shortages')) {
        throw new HttpError(403, 'Отметки «нет товара» решает владелец или менеджер с этим правом');
      }
      if (original.rows[0].agent === 'Обмен с WB') {
        throw new HttpError(409, 'Решение по заказу WB принимается в разделе «Сверка заказов WB»');
      }
      // Заявка продавца на перенос между складами: «Подтвердить» выполняет
      // перенос, «Отклонить» — отказ; продавцу приходит уведомление.
      if (original.rows[0].entity_type === 'vw_transfer') {
        const t = (await client.query('SELECT entity_id FROM journal_entries WHERE id = $1', [id])).rows[0];
        const s = role === 'manager' ? (await client.query('SELECT name FROM staff_keys WHERE id = $1', [staffKeyId])).rows[0] : null;
        await vwarehouses.decide(client, {
          warehouseId, transferId: t.entity_id, approve: resolution === 'confirm', reason: note,
          actor: role === 'manager'
            ? { role: 'manager', id: staffKeyId, name: s ? `Менеджер ${s.name}` : 'Менеджер склада' }
            : { role: 'owner', id: ownerId, name: 'Руководитель склада' },
        });
        return (await client.query(
          'SELECT * FROM journal_entries WHERE related_entry_id = $1 ORDER BY created_at DESC LIMIT 1', [id])).rows[0];
      }
      return repository.resolveEntry(client, {
        warehouseId, originalEntryId: id, resolution, resolvedByOwnerId: ownerId, note,
        actorType: role === 'manager' ? 'manager' : 'owner',
        actorId: ownerId || staffKeyId || null,
      });
    });
    if (!entry) throw new HttpError(404, 'Запись не найдена');
    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
});

// «Написать руководителю о товаре» (владелец 27.09.2026, третье задание):
// комплектовщик на карточке товара — в приёмке или в сборке — пишет, что не так
// («коробка мятая», «штрихкод не читается»). Это запись журнала «ждёт
// решения»: висит, пока руководитель или менеджер не нажмёт «Принял к
// сведению» (resolve с resolution 'ack'), и видна в карточке прихода или
// поставки.
//
// Приёмка и заказ — invoiceItemId (строка документа). Сборка — supplyId и
// sku: на экране сборки товар один на всю поставку, а строк у него столько,
// сколько заказов; запись ведёт на строку первого по номеру заказа, и через
// него — на поставку.
const ITEM_NOTE = 'item_note';
const ACK_TYPES = new Set([ITEM_NOTE, 'vw_zone']);
router.post('/item-note', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text.trim().replace(/\s+/g, ' ') : '';
    if (!text) throw new HttpError(400, 'Напишите, что не так с товаром');
    if (text.length > 500) throw new HttpError(400, 'Слишком длинно — до 500 знаков');
    const uuid = (v) => (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null);
    const invoiceItemId = uuid(body.invoiceItemId);
    const supplyId = uuid(body.supplyId);
    const sku = typeof body.sku === 'string' ? body.sku.trim() : '';
    if (!invoiceItemId && !(supplyId && sku)) throw new HttpError(400, 'Нужен товар: строка документа или поставка и артикул');
    const entry = await withTenantContext({ warehouseId }, async (client) => {
      const item = (await client.query(
        `SELECT ii.id, ii.sku, ii.name, i.id AS invoice_id, i.number, i.direction, s.number AS supply_number
           FROM invoice_items ii
           JOIN invoices i ON i.id = ii.invoice_id
           LEFT JOIN supplies s ON s.id = i.supply_id
          WHERE i.warehouse_id = $1
            AND (CASE WHEN $2::uuid IS NOT NULL THEN ii.id = $2::uuid ELSE i.supply_id = $3::uuid AND ii.sku = $4 END)
          ORDER BY i.number, ii.id LIMIT 1`,
        [warehouseId, invoiceItemId, supplyId, sku],
      )).rows[0];
      if (!item) throw new HttpError(404, 'Товар не найден — возможно, документ изменился');
      const who = (await client.query('SELECT name FROM staff_keys WHERE id = $1', [staffKeyId])).rows[0];
      const where = supplyId && item.supply_number ? `при сборке поставки «${item.supply_number}»`
        : item.direction === 'in' ? `в приходе «${item.number}»`
          : item.direction === 'return' ? `в возврате «${item.number}»` : `в заказе «${item.number}»`;
      return repository.createEntry(client, {
        warehouseId,
        agent: 'Кладовщик',
        actionText: `${who ? who.name : 'Комплектовщик'} пишет о товаре «${item.name}» (${item.sku}) ${where}: «${text}»`,
        entityType: ITEM_NOTE,
        entityId: item.id,
        invoiceId: item.invoice_id,
        actorType: 'worker',
        actorId: staffKeyId,
        status: 'pending',
      });
    });
    res.status(201).json(entry);
  } catch (err) {
    next(err);
  }
});

// Комплектовщик поставил работу на паузу или вернулся к ней — руководитель видит
// это в журнале сразу, а не в итоге накладной (владелец 26.09.2026).
// Работник журнал не читает, он только сообщает.
//
// Пауза сборки поставки и приёмки прихода идёт сюда же (владелец 27.09.2026):
// у комплектовщика, который ведёт эту работу, она ещё и останавливает таймер на
// сервере, а exit — «вышел» (стрелка «назад», другая вкладка). Запись в
// журнале при этом одна, с тем, сколько сделано, и комментарием.
router.post('/pause', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const body = req.body || {};
    const { reason, resumed, pausedMs } = body;
    const uuid = (v) => (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null);
    const invoiceId = uuid(body.invoiceId);
    const supplyId = uuid(body.supplyId);
    const why = typeof reason === 'string' ? reason.trim().replace(/\s+/g, ' ').slice(0, 200) : '';
    if (!why) throw new HttpError(400, 'Нужна причина паузы');
    const entry = await withWorkerCommand(req, async (client) => {
      // Сборка поставки — по supplyId, приёмка прихода — по invoiceId
      // (заказ на отгрузку приходом не окажется: у приёмки свой документ).
      const work = supplyId && !invoiceId ? { of: assembly, id: supplyId }
        : invoiceId && !supplyId ? { of: receiving, id: invoiceId } : null;
      if (work) {
        const out = await work.of.pauseOrResume(client, warehouseId, staffKeyId, work.id, {
          reason: why, resumed: resumed === true, exit: body.exit === true, comment: body.comment,
          at: typeof body.at === 'string' ? body.at : null,
          workSessionId: body.workSessionId, eventAt: body.eventAt, eventSequence: body.eventSequence,
        });
        if (out) return { ...(out.entry || { repeated: true }), assembly: out.state };
        // Выход из работы, которую этот комплектовщик уже не ведёт (её забрали,
        // закончили или страница устарела), — не событие для журнала.
        if (body.exit === true) return { repeated: true, assembly: null };
      }
      if (body.workSessionId) throw new HttpError(409, 'Нужен документ текущего захода работы', { code: 'work_session_changed' });
      const who = await client.query('SELECT name FROM staff_keys WHERE id = $1', [staffKeyId]);
      const doc = invoiceId ? (await client.query(
        `SELECT i.id, i.number, s.number AS supply_number FROM invoices i
           LEFT JOIN supplies s ON s.id = i.supply_id
          WHERE i.id = $1 AND i.warehouse_id = $2`, [invoiceId, warehouseId])).rows[0] : null;
      const sup = !doc && supplyId ? (await client.query(
        'SELECT number FROM supplies WHERE id = $1 AND warehouse_id = $2', [supplyId, warehouseId])).rows[0] : null;
      const where = doc
        ? (doc.supply_number ? ` Поставка «${doc.supply_number}», заказ «${doc.number}».` : ` Документ «${doc.number}».`)
        : sup ? ` Поставка «${sup.number}».` : '';
      const name = who.rows[0] ? who.rows[0].name : 'Комплектовщик';
      const ms = Number(pausedMs) || 0;
      const took = ms < 60000 ? 'меньше минуты' : `${Math.round(ms / 60000)} мин`;
      return repository.createEntry(client, {
        warehouseId,
        agent: 'Кладовщик',
        actionText: resumed
          ? `${name} вернулся к работе после паузы (${took}): ${why}.${where}`
          : `${name} поставил работу на паузу: ${why}.${where}`,
        entityType: 'worker_pause',
        invoiceId: doc ? doc.id : null,
        actorType: 'worker',
        actorId: staffKeyId,
      });
    });
    res.status(entry.repeated ? 200 : 201).json(entry);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
