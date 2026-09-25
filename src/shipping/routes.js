const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const { refreshCellFill } = require('../cells/fill');
const journal = require('../journal/repository');
const outbox = require('../sync/outbox');
const { requireQty } = require('../middleware/qty');
const { refreshSupplyStatus, lockSupplyOfInvoice } = require('../supplies/state');
const { buildPickList, parseInvoiceIds } = require('./pickList');

const router = express.Router();

// "Кладовщик подсказывает, откуда брать" — the outbound counterpart of
// receiving's cell suggestion. Receiving asks "where is there free space?";
// shipping asks "where does this SKU physically sit right now?", which we can
// answer exactly, because cell placement is our data (1C never knows about
// cells). Ordered by row/rack so the list doubles as a walking route rather
// than sending the worker back and forth across the warehouse.
router.get('/suggest/:invoiceItemId', requireAuth, requireRole('owner', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const { invoiceItemId } = req.params;

    const suggestion = await withTenantContext({ warehouseId }, async (client) => {
      // Joined on the natural key rather than a FK — see the products
      // migration for why documents keep their own copy of name/sku. LEFT JOIN
      // because a line can reference a SKU that has no directory card yet
      // (hand-entered invoice, or 1C nomenclature not synced through).
      const itemResult = await client.query(
        `SELECT ii.id, ii.name, ii.sku, ii.declared_qty, ii.company_id,
                p.category, p.length_mm, p.width_mm, p.height_mm, p.weight_g
         FROM invoice_items ii
         LEFT JOIN products p
           ON p.warehouse_id = ii.warehouse_id
          AND p.company_id = ii.company_id
          AND p.sku = ii.sku
         WHERE ii.id = $1 AND ii.warehouse_id = $2`,
        [invoiceItemId, warehouseId],
      );
      const item = itemResult.rows[0];
      if (!item) throw new HttpError(404, 'Позиция накладной не найдена');

      const cellsResult = await client.query(
        `SELECT cs.cell_block_id, SUM(cs.qty) AS available,
                wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
         FROM cell_stock cs
         JOIN cell_blocks cb ON cb.id = cs.cell_block_id
         JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
         WHERE cs.warehouse_id = $1 AND cs.company_id = $2 AND cs.sku = $3 AND cs.qty > 0
           AND cs.quality = 'good'
         GROUP BY cs.cell_block_id, wr.row_num, cb.rack_start, cb.rack_end,
                  cb.tier_start, cb.tier_end
         HAVING SUM(cs.qty) > 0
         ORDER BY wr.row_num, cb.rack_start, cb.tier_start`,
        [warehouseId, item.company_id, item.sku],
      );

      const alreadyPicked = await client.query(
        `SELECT COALESCE(SUM(picked_qty), 0) AS picked
         FROM shipping_records WHERE invoice_item_id = $1`,
        [invoiceItemId],
      );

      const totalAvailable = cellsResult.rows
        .reduce((sum, r) => sum + Number(r.available), 0);
      const picked = Number(alreadyPicked.rows[0].picked);

      return {
        item: {
          id: item.id,
          name: item.name,
          sku: item.sku,
          declaredQty: Number(item.declared_qty),
          alreadyPicked: picked,
          remaining: Number(item.declared_qty) - picked,
          // null when the SKU has no directory card yet — the caller must treat
          // that as "unknown", not as "no packaging requirements".
          category: item.category,
          dimensions: item.length_mm === null && item.width_mm === null
            && item.height_mm === null && item.weight_g === null
            ? null
            : {
              lengthMm: item.length_mm === null ? null : Number(item.length_mm),
              widthMm: item.width_mm === null ? null : Number(item.width_mm),
              heightMm: item.height_mm === null ? null : Number(item.height_mm),
              weightG: item.weight_g === null ? null : Number(item.weight_g),
            },
        },
        totalAvailable,
        // Flagged up front so the worker learns the warehouse is short before
        // walking to the cells, not after.
        shortfall: Math.max(0, Number(item.declared_qty) - picked - totalAvailable),
        cells: cellsResult.rows.map((r) => ({
          cellBlockId: r.cell_block_id,
          available: Number(r.available),
          rowNum: r.row_num,
          rackStart: r.rack_start,
          rackEnd: r.rack_end,
          tierStart: r.tier_start,
          tierEnd: r.tier_end,
        })),
      };
    });
    res.json(suggestion);
  } catch (err) {
    next(err);
  }
});

// «Лист грузчика» — один обход склада на несколько заказов сразу.
// ?supplyId=… — вся поставка (печать листа поставки: номера двухсот заказов
// в адресе не помещаются, сервер отвечает 414).
// ?invoiceIds=a,b,c — конкретные заказы; без параметра берутся все, что ждут
// отбора. Кладовщик здесь именно сводит, а не решает: количество и маршрут —
// арифметика (см. pickList.js).
router.get('/pick-list', requireAuth, requireRole('owner', 'manager', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const invoiceIds = parseInvoiceIds(req.query.invoiceIds);
    const supplyId = req.query.supplyId ? parseInvoiceIds(String(req.query.supplyId))[0] : null;
    const list = await withTenantContext({ warehouseId }, (client) => (
      buildPickList(client, warehouseId, invoiceIds, supplyId)
    ));
    res.json(list);
  } catch (err) {
    next(err);
  }
});

// «Товара нет» — отметка грузчика со сборки.
//
// Грузчик собирает заказ, а товара нет или не хватает. Раньше он мог только
// отложить позицию и «сказать менеджеру» устно — в базу ничего не попадало.
// Теперь отметка уходит в журнал с пометкой «очень важно» владельцу и
// менеджеру с правом «отметки о нехватке» и видна в самой поставке.
//
// Это отметка, а не отбор: остаток, строку заказа и 1С она не трогает.
// Строка остаётся открытой, поэтому поставка не уедет полупустой, пока
// руководитель не решит, что делать.
router.post('/missing', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const { invoiceItemId, missingQty, note } = req.body || {};
    if (!invoiceItemId) throw new HttpError(400, 'Нужна позиция заказа');
    const qty = requireQty(missingQty, 'Сколько не хватает', { min: 1 });
    const comment = typeof note === 'string' ? note.trim().replace(/\s+/g, ' ').slice(0, 300) : '';

    const out = await withTenantContext({ warehouseId }, async (client) => {
      const pre = await client.query(
        'SELECT invoice_id FROM invoice_items WHERE id = $1 AND warehouse_id = $2',
        [invoiceItemId, warehouseId],
      );
      if (!pre.rows[0]) throw new HttpError(404, 'Позиция заказа не найдена');
      // Тот же порядок блокировок, что у отбора: поставка, потом заказ.
      await lockSupplyOfInvoice(client, warehouseId, pre.rows[0].invoice_id);
      const itemResult = await client.query(
        `SELECT ii.id, ii.name, ii.sku, ii.declared_qty, ii.invoice_id,
                i.number AS invoice_number, i.direction, i.status, i.mp_closed_at, s.number AS supply_number
           FROM invoice_items ii
           JOIN invoices i ON i.id = ii.invoice_id
           JOIN companies c ON c.id = ii.company_id AND c.archived_at IS NULL
           LEFT JOIN supplies s ON s.id = i.supply_id
          WHERE ii.id = $1 AND ii.warehouse_id = $2 FOR UPDATE OF i`,
        [invoiceItemId, warehouseId],
      );
      const item = itemResult.rows[0];
      if (!item) throw new HttpError(404, 'Позиция заказа не найдена');
      if (item.direction !== 'out') throw new HttpError(400, 'Это не заказ на отгрузку');
      if (item.mp_closed_at || item.status === 'shipped') {
        throw new HttpError(409, 'Заказ уже закрыт — отмечать нечего');
      }
      const picked = await client.query(
        `SELECT COALESCE(SUM(picked_qty), 0) AS picked, COALESCE(BOOL_OR(is_final), false) AS closed
           FROM shipping_records WHERE invoice_item_id = $1`,
        [invoiceItemId],
      );
      if (picked.rows[0].closed) throw new HttpError(409, 'Эта позиция уже собрана и закрыта');
      const remaining = Number(item.declared_qty) - Number(picked.rows[0].picked);
      if (qty > remaining) {
        throw new HttpError(400, `По позиции осталось собрать ${remaining} шт. — не хватать может не больше`);
      }

      // Второе нажатие (или та же позиция с другого экрана) — не вторая
      // тревога: возвращаем уже отправленную, пока по ней не ответили.
      const open = await client.query(
        `SELECT je.* FROM journal_entries je
          WHERE je.warehouse_id = $1 AND je.urgent AND je.status = 'pending'
            AND je.entity_type = 'invoice_item' AND je.entity_id = $2
            AND NOT EXISTS (SELECT 1 FROM journal_entries a WHERE a.related_entry_id = je.id)
          ORDER BY je.created_at DESC LIMIT 1`,
        [warehouseId, invoiceItemId],
      );
      if (open.rows[0]) return { repeated: true, entry: open.rows[0] };

      const who = await client.query('SELECT name FROM staff_keys WHERE id = $1', [staffKeyId]);
      const entry = await journal.createEntry(client, {
        warehouseId,
        agent: 'Кладовщик',
        actionText: `ОЧЕНЬ ВАЖНО: нет товара «${item.name}» (${item.sku}) — не хватает ${qty} из ${remaining} шт. `
          + `Заказ «${item.invoice_number}»`
          + (item.supply_number ? `, поставка «${item.supply_number}»` : '')
          + `. Отметил ${who.rows[0] ? who.rows[0].name : 'грузчик'} при сборке.`
          + (comment ? ` Комментарий: ${comment}` : ''),
        entityType: 'invoice_item',
        entityId: item.id,
        invoiceId: item.invoice_id,
        actorType: 'worker',
        actorId: staffKeyId,
        status: 'pending',
        urgent: true,
      });
      return { repeated: false, entry };
    });
    res.status(out.repeated ? 200 : 201).json(out);
  } catch (err) {
    next(err);
  }
});

// Одна запись отбора: сколько взяли из какой ячейки по одной позиции заказа.
// Общая для отбора по заказу и по товару — правила (что можно, откуда
// списать, журнал, 1С, статусы заказа и поставки) не должны разойтись.
async function recordPick(client, warehouseId, staffKeyId, {
  invoiceItemId, qty, cellBlockId, isFinal = true, pausedMs, pauseReasons,
}) {
  const pre = await client.query(
    'SELECT invoice_id FROM invoice_items WHERE id = $1 AND warehouse_id = $2',
    [invoiceItemId, warehouseId],
  );
  if (!pre.rows[0]) throw new HttpError(404, 'Позиция накладной не найдена');
  const supplyId = await lockSupplyOfInvoice(client, warehouseId, pre.rows[0].invoice_id);
  const itemResult = await client.query(
    `SELECT ii.id, ii.name, ii.sku, ii.declared_qty, ii.company_id, ii.invoice_id,
            ii.external_id,
            i.direction, i.status, i.mp_closed_at, i.number AS invoice_number,
            i.external_id AS invoice_external_id, i.source, i.supply_id,
            c.external_id AS company_external_id
     FROM invoice_items ii
     JOIN invoices i ON i.id = ii.invoice_id
     JOIN companies c ON c.id = ii.company_id AND c.archived_at IS NULL
     WHERE ii.id = $1 AND ii.warehouse_id = $2 FOR UPDATE OF i`,
    [invoiceItemId, warehouseId],
  );
  const item = itemResult.rows[0];
  if (!item) throw new HttpError(404, 'Позиция накладной не найдена');
  if ((item.supply_id || null) !== supplyId) {
    throw new HttpError(409, 'Заказ только что перенесли в другую поставку — обновите экран');
  }
  // Guard against a receiving invoice being picked as if it were a
  // shipment — that would silently drain stock that was just accepted.
  if (item.direction !== 'out') {
    throw new HttpError(400, 'Эта накладная не на отгрузку');
  }
  if (item.mp_closed_at || item.status === 'shipped') {
    throw new HttpError(409, 'Заказ уже закрыт. Отбор остановлен; руководитель проверит его в сверке заказов WB.');
  }
  // Заказ с площадки собирают только в составе поставки: какие заказы
  // уезжают сегодня, решает менеджер, а не тот, кто первым открыл список.
  if (item.source !== '1c' && !item.supply_id) {
    throw new HttpError(409, 'Этот заказ ещё не отправлен на сборку — его включает в поставку менеджер');
  }

  const closed = await client.query(
    `SELECT id FROM shipping_records WHERE invoice_item_id = $1 AND is_final = true`,
    [invoiceItemId],
  );
  if (closed.rows[0]) throw new HttpError(409, 'Эта позиция уже отгружена');

  const before = await client.query(
    'SELECT COALESCE(SUM(picked_qty), 0) AS picked FROM shipping_records WHERE invoice_item_id = $1',
    [invoiceItemId],
  );
  const remainingQty = Number(item.declared_qty) - Number(before.rows[0].picked);
  if (qty > remainingQty) {
    throw new HttpError(409, `По заказу осталось собрать ${remainingQty} шт., нельзя записать ${qty}`);
  }

  // Lock the stock rows for this cell/sku so two workers picking the same
  // cell at once can't both pass the availability check and drive qty
  // negative — the second one waits here and then sees the real remainder.
  const stockResult = await client.query(
    // quality = 'good': брак и ждущий перепаковки товар физически лежат в
    // ячейках, но клиенту не уезжают ни при каких условиях.
    `SELECT id, qty FROM cell_stock
     WHERE cell_block_id = $1 AND warehouse_id = $2 AND company_id = $3 AND sku = $4
       AND qty > 0 AND quality = 'good'
     ORDER BY updated_at
     FOR UPDATE`,
    [cellBlockId, warehouseId, item.company_id, item.sku],
  );
  const availableInCell = stockResult.rows
    .reduce((sum, r) => sum + Number(r.qty), 0);
  if (availableInCell <= 0) {
    throw new HttpError(409, 'В этой ячейке нет такого товара');
  }
  if (qty > availableInCell) {
    throw new HttpError(
      409,
      `В ячейке только ${availableInCell}, нельзя забрать ${qty}`,
    );
  }

  // Receiving INSERTs a fresh cell_stock row per acceptance, so one cell
  // can hold several rows for the same SKU. Draw down oldest-first.
  let toTake = qty;
  for (const row of stockResult.rows) {
    if (toTake <= 0) break;
    const take = Math.min(toTake, Number(row.qty));
    const left = Number(row.qty) - take;
    if (left === 0) {
      await client.query(`DELETE FROM cell_stock WHERE id = $1`, [row.id]);
    } else {
      await client.query(
        `UPDATE cell_stock SET qty = $2, updated_at = now() WHERE id = $1`,
        [row.id, left],
      );
    }
    toTake -= take;
  }

  // A block with nothing left in it goes back to being free space, so the
  // map and the receiving-side cell suggestions stay truthful.
  // Забрали часть — ячейка не пустеет, но и полной больше не считается.
  // Тот же пересчёт, что и на приёмке: одно место, одна формула.
  await refreshCellFill(client, cellBlockId);

  const recordResult = await client.query(
    `INSERT INTO shipping_records
       (invoice_item_id, warehouse_id, company_id, picked_qty, cell_block_id,
        worker_key_id, is_final, finished_at, paused_ms, pause_reasons)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9)
     RETURNING id, picked_qty, cell_block_id, is_final, finished_at, paused_ms`,
    [
      invoiceItemId, warehouseId, item.company_id, qty, cellBlockId,
      staffKeyId, isFinal, pausedMs || 0, JSON.stringify(pauseReasons || []),
    ],
  );

  const totalsResult = await client.query(
    `SELECT COALESCE(SUM(picked_qty), 0) AS picked
     FROM shipping_records WHERE invoice_item_id = $1`,
    [invoiceItemId],
  );
  const totalPicked = Number(totalsResult.rows[0].picked);
  const declared = Number(item.declared_qty);

  // Only a closed line can be short — a partial pick mid-walk is normal
  // and must not be reported to the owner as a discrepancy.
  const hasDiscrepancy = isFinal && totalPicked !== declared;
  const actionText = hasDiscrepancy
    ? `Расхождение при отгрузке «${item.name}» (${item.sku}): нужно ${declared}, собрано ${totalPicked}.`
    : `Собрал «${item.name}» (${item.sku}) — ${qty} шт.${isFinal ? ` Позиция закрыта, итого ${totalPicked}.` : ''}`;
  await journal.createEntry(client, {
    warehouseId,
    agent: 'Кладовщик',
    actionText,
    entityType: 'invoice_item',
    entityId: invoiceItemId,
    invoiceId: item.invoice_id,
    cellBlockId: cellBlockId || null,
    actorType: 'worker',
    actorId: staffKeyId,
    status: hasDiscrepancy ? 'pending' : 'auto',
  });

  // Only on the pick that closes the line. A partial pick mid-walk is not a
  // completed movement — emitting one per cell visited would have 1C post
  // the same shipment two or three times.
  if (isFinal) {
    await outbox.appendShipping(client, {
      warehouseId,
      item,
      invoice: {
        id: item.invoice_id,
        number: item.invoice_number,
        external_id: item.invoice_external_id,
      },
      company: { id: item.company_id, external_id: item.company_external_id },
      actualQty: totalPicked,
    });
  }

  // The invoice is done when every line has been explicitly closed —
  // 'ready' (собран), not 'completed': picking finished is not the same
  // event as the truck actually leaving, see POST /:id/ship below.
  const remaining = await client.query(
    `SELECT COUNT(*)::int AS n FROM invoice_items ii
     WHERE ii.invoice_id = $1 AND NOT EXISTS (
       SELECT 1 FROM shipping_records sr
       WHERE sr.invoice_item_id = ii.id AND sr.is_final = true
     )`,
    [item.invoice_id],
  );
  const newStatus = remaining.rows[0].n === 0 ? 'ready' : 'in_progress';
  await client.query(`UPDATE invoices SET status = $2 WHERE id = $1`, [item.invoice_id, newStatus]);
  // Последний собранный заказ делает поставку «собранной» — сам.
  if (item.supply_id) await refreshSupplyStatus(client, warehouseId, item.supply_id);

  return { ...recordResult.rows[0], totalPicked, declaredQty: declared };
}

// Worker records one pick: how much was taken out of which cell. Called once
// per cell visited, with isFinal on the last one to close the line item.
router.post('/', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const {
      invoiceItemId, pickedQty, cellBlockId, isFinal = true, pausedMs, pauseReasons,
    } = req.body;
    if (!invoiceItemId || pickedQty == null || !cellBlockId) {
      throw new HttpError(400, 'Нужны позиция накладной, количество и ячейка');
    }
    // Целое и больше нуля: «NaN» и «1.5» проходили прежнюю проверку и
    // записывались в остаток ячейки как есть.
    const qty = requireQty(pickedQty, 'Количество', { min: 1 });
    const record = await withTenantContext({ warehouseId }, (client) => recordPick(
      client, warehouseId, staffKeyId, { invoiceItemId, qty, cellBlockId, isFinal, pausedMs, pauseReasons },
    ));
    res.status(201).json(record);
  } catch (err) {
    next(err);
  }
});

// Отбор по товару (решение владельца 24.09.2026): грузчик идёт к ячейке и
// берёт сразу всё нужное поставке по этому товару, а не по штуке на заказ.
// Взятое раскладываем по заказам поставки — старшим номерам первыми; заказ,
// которому хватило, закрыт, последний может остаться собранным частично.
// Всё в одной транзакции: либо записан весь отбор, либо ничего.
router.post('/product', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const { supplyId, sku, cellBlockId, pickedQty, pausedMs, pauseReasons } = req.body || {};
    if (!supplyId || !sku || !cellBlockId || pickedQty == null) {
      throw new HttpError(400, 'Нужны поставка, товар, ячейка и количество');
    }
    const qty = requireQty(pickedQty, 'Количество', { min: 1 });
    const out = await withTenantContext({ warehouseId }, async (client) => {
      const lines = (await client.query(
        `SELECT ii.id, ii.declared_qty - COALESCE((SELECT SUM(sr.picked_qty) FROM shipping_records sr
                                                    WHERE sr.invoice_item_id = ii.id), 0) AS left_qty
           FROM invoice_items ii
           JOIN invoices i ON i.id = ii.invoice_id
          WHERE i.warehouse_id = $1 AND i.supply_id = $2 AND ii.sku = $3
            AND i.status NOT IN ('shipped') AND i.mp_closed_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM shipping_records sr
                             WHERE sr.invoice_item_id = ii.id AND sr.is_final)
            -- Позицию с неразобранной отметкой «нет товара» экран грузчика не
            -- считает, и сюда взятое не кладём: иначе штука уйдёт в заказ,
            -- который руководитель уберёт из поставки, а тот, ради которого
            -- её брали, останется несобранным (проверка 25.09.2026). То же
            -- условие, что у состава поставки (supplies/service.js, missing).
            AND NOT EXISTS (SELECT 1 FROM journal_entries je
                             WHERE je.warehouse_id = ii.warehouse_id AND je.urgent AND je.status = 'pending'
                               AND je.entity_type = 'invoice_item' AND je.entity_id = ii.id
                               AND NOT EXISTS (SELECT 1 FROM journal_entries a WHERE a.related_entry_id = je.id))
          ORDER BY i.number, ii.id`,
        [warehouseId, supplyId, sku],
      )).rows.filter((l) => Number(l.left_qty) > 0);
      const need = lines.reduce((sum, l) => sum + Number(l.left_qty), 0);
      if (!need) throw new HttpError(409, 'По этому товару в поставке больше нечего собирать');
      if (qty > need) throw new HttpError(409, `Поставке нужно ещё ${need} шт., нельзя записать ${qty}`);
      let left = qty;
      const records = [];
      for (const l of lines) {
        if (left <= 0) break;
        const give = Math.min(left, Number(l.left_qty));
        records.push(await recordPick(client, warehouseId, staffKeyId, {
          invoiceItemId: l.id, qty: give, cellBlockId,
          isFinal: give === Number(l.left_qty),
          // Пауза — у всего отбора одна, пишем её в первую запись.
          pausedMs: records.length ? 0 : pausedMs, pauseReasons: records.length ? [] : pauseReasons,
        }));
        left -= give;
      }
      return { picked: qty, orders: records.length, stillNeeded: need - qty };
    });
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
});

// Marks an order as physically loaded and gone — a separate real-world event
// from finishing the pick (a fully picked order can sit staged for hours).
// Owner or worker can confirm it; no further state after this one.
router.post('/:id/ship', requireAuth, requireRole('owner', 'worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const { id } = req.params;

    const invoice = await withTenantContext({ warehouseId }, async (client) => {
      const result = await client.query(
        `SELECT id, number, status, direction, mp_closed_at, supply_id FROM invoices WHERE id = $1 AND warehouse_id = $2 FOR UPDATE`,
        [id, warehouseId],
      );
      const inv = result.rows[0];
      if (!inv) throw new HttpError(404, 'Накладная не найдена');
      if (inv.direction !== 'out') throw new HttpError(400, 'Эта накладная не на отгрузку');
      // Заказ из поставки уезжает вместе с ней. Отгрузи его отдельно — и
      // поставка навсегда осталась бы «собирается»: её заказы уже уехали.
      if (inv.supply_id) throw new HttpError(409, 'Этот заказ уезжает в составе поставки — отметьте «Уехала» у поставки');
      if (inv.mp_closed_at) throw new HttpError(409, 'Заказ закрыт на WB. Руководитель должен подтвердить судьбу товара в сверке заказов WB.');
      if (inv.status !== 'ready') {
        throw new HttpError(409, 'Заказ ещё не полностью собран');
      }

      const shipped = await client.query(`UPDATE invoices SET status = 'shipped', shipped_at=now() WHERE id = $1 RETURNING shipped_at`, [id]);
      await journal.createEntry(client, {
        warehouseId,
        agent: 'Кладовщик',
        actionText: `Заказ «${inv.number}» отгружен.`,
        entityType: 'invoice',
        entityId: id,
        invoiceId: id,
        actorType: staffKeyId ? 'worker' : 'owner',
        actorId: staffKeyId || null,
        status: 'auto',
      });

      return { id: inv.id, number: inv.number, status: 'shipped', shipped_at: shipped.rows[0].shipped_at };
    });
    res.json(invoice);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
