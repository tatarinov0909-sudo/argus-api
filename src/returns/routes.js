const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const { refreshCellFill } = require('../cells/fill');
const journal = require('../journal/repository');
const outbox = require('../sync/outbox');
const { requireQty } = require('../middleware/qty');
const defects = require('../defects/service');
const { zoneOf, todayIn } = require('../warehouses/time');
const vwarehouses = require('../vwarehouses/service');

const router = express.Router();

const BUCKET_LABEL = {
  good: 'хороший товар',
  defective: 'брак',
  packaging_defect: 'брак упаковки',
};

// Worker records one quality-bucket split of a return line: how much of it
// is good/defective/packaging-damaged, and — for a bucket the owner shelves —
// which cell it went into. A single declared line is closed over one or more
// of these calls (one per bucket), mirroring how a shipping pick is closed
// over one call per cell visited.
router.post('/', requireAuth, requireRole('worker'), async (req, res, next) => {
  try {
    const { warehouseId, staffKeyId } = req.auth;
    const {
      invoiceItemId, qty, qualityBucket, pausedMs, pauseReasons, defectNote, seenQty,
    } = req.body;
    let { cellBlockId } = req.body;
    if (!invoiceItemId || qty == null || !qualityBucket) {
      throw new HttpError(400, 'Нужны позиция накладной, количество и категория качества');
    }
    if (!BUCKET_LABEL[qualityBucket]) {
      throw new HttpError(400, 'Категория качества может быть good, defective или packaging_defect');
    }
    // Целое и больше нуля: `cell_stock.qty` — NUMERIC, и «1.5» спокойно ложилось
    // на полку дробью, а потом складывалось с целыми в остатке продавца.
    requireQty(qty, 'Количество', { min: 1 });
    // Описание дефекта — свободный текст работника, поэтому режем длину:
    // в журнал и продавцу это уходит целиком, и полотно там никому не нужно.
    const note = typeof defectNote === 'string' ? defectNote.trim().slice(0, 300) : null;
    // Брак — только в ячейку (владелец 02.10.2026): он ложится на склад брака
    // продавца, и решать по нему продавец будет по конкретной ячейке.
    if (qualityBucket !== 'good' && !cellBlockId) {
      throw new HttpError(400, 'Укажите ячейку для брака');
    }
    // Годное — тоже только в ячейку (проверка 03.10.2026): без ячейки возврат
    // закрывался, а в остаток товар не попадал и потом не размещался.
    if (!cellBlockId) throw new HttpError(400, 'Укажите ячейку, куда кладёте товар');

    const record = await withTenantContext({ warehouseId }, async (client) => {
      // Возврат целиком — на запись первым: две последние строки одного
      // возврата, разобранные одновременно, иначе не видели друг друга и
      // возврат оставался «в работе» (проверка 03.10.2026).
      await client.query(
        `SELECT i.id FROM invoices i JOIN invoice_items ii ON ii.invoice_id = i.id
          WHERE ii.id = $1 AND ii.warehouse_id = $2 FOR UPDATE OF i`,
        [invoiceItemId, warehouseId],
      );
      const itemResult = await client.query(
        // Идентификаторы 1С забираем сразу: событие для обмена собирается в
        // той же транзакции, и второй заход в базу ради них не нужен.
        `SELECT ii.id, ii.name, ii.sku, ii.declared_qty, ii.company_id, ii.invoice_id,
                ii.external_id,
                i.direction, i.number AS invoice_number,
                i.external_id AS invoice_external_id,
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
      if (item.direction !== 'return') {
        throw new HttpError(400, 'Эта накладная не на возврат');
      }

      // Строка накладной заблокирована выше (FOR UPDATE OF ii): без этого два
      // одновременных разбора (двойной тап, два работника) проходили проверку
      // оба, и на полке оказывалось больше, чем реально приехало.
      const soFar = await client.query(
        `SELECT COALESCE(SUM(qty), 0) AS total FROM return_records WHERE invoice_item_id = $1`,
        [invoiceItemId],
      );
      const alreadyLogged = Number(soFar.rows[0].total);
      const declared = Number(item.declared_qty);
      // Экран видел другое «уже разобрано» — эту часть разобрали в другой
      // вкладке или повтором (проверка 03.10.2026).
      if (seenQty != null && Number(seenQty) !== alreadyLogged) {
        throw new HttpError(409, `По позиции уже разобрано ${alreadyLogged} шт. — обновите экран`);
      }
      if (alreadyLogged + Number(qty) > declared) {
        throw new HttpError(
          409,
          `По позиции заявлено ${declared}, уже разобрано ${alreadyLogged} — нельзя добавить ещё ${qty}`,
        );
      }

      if (cellBlockId) {
        const blockResult = await client.query(
          `SELECT id FROM cell_blocks WHERE id = $1 AND warehouse_id = $2`,
          [cellBlockId, warehouseId],
        );
        if (!blockResult.rows[0]) throw new HttpError(404, 'Ячейка не найдена');
        // Хранение выключено — возврат ложится в «Склад», и в истории тоже
        // «Склад», а не выбранная на экране ячейка (проверка 07.10, замечание 9).
        cellBlockId = await require('../cells/addressing').place(client, warehouseId, cellBlockId);

        // Склад «хранить отдельно» и зоны складов продавца (02.10.2026).
        await require('../vwarehouses/separate').checkPut(client, warehouseId, {
          cellBlockId, companyId: item.company_id, quality: qualityBucket,
          vw: (await client.query('SELECT virtual_warehouse_id FROM invoice_items WHERE id = $1', [item.id])).rows[0]?.virtual_warehouse_id || null,
        });
        // Состояние едет в остаток вместе с количеством: брак на полке обязан
        // отличаться от годного, иначе отгрузка предложит его клиенту.
        await client.query(
          // Возврат ложится на склад строки возврата (виртуальный склад,
          // 02.10.2026; брак помнит его же); не выбран — «Основной».
          `INSERT INTO cell_stock (cell_block_id, warehouse_id, company_id, sku, qty, quality, virtual_warehouse_id)
           VALUES ($1, $2, $3, $4, $5, $6, (SELECT virtual_warehouse_id FROM invoice_items WHERE id = $7))`,
          [cellBlockId, warehouseId, item.company_id, item.sku, qty, qualityBucket, item.id],
        );
        await refreshCellFill(client, cellBlockId);
      }

      const recordResult = await client.query(
        `INSERT INTO return_records
           (invoice_item_id, warehouse_id, company_id, quality_bucket, qty, cell_block_id,
            worker_key_id, paused_ms, pause_reasons, defect_note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, quality_bucket, qty, cell_block_id, finished_at, paused_ms, defect_note`,
        [
          invoiceItemId, warehouseId, item.company_id, qualityBucket, qty, cellBlockId || null,
          staffKeyId, pausedMs || 0, JSON.stringify(pauseReasons || []), note || null,
        ],
      );

      // Возврат физически прибавил товар на складе — 1С должна об этом узнать
      // так же, как о приёмке. В одной транзакции с движением остатка: запись
      // без события означала бы тихое расхождение с 1С.
      await outbox.appendReturn(client, {
        warehouseId,
        item,
        invoice: {
          id: item.invoice_id,
          number: item.invoice_number,
          external_id: item.invoice_external_id,
        },
        company: { id: item.company_id, external_id: item.company_external_id },
        actualQty: qty,
        quality: qualityBucket,
        defectNote: note,
      });

      const newTotal = alreadyLogged + Number(qty);
      // Брак — документ «Перемещение на склад брака» (запись журнала пишет он).
      let move = null;
      if (qualityBucket !== 'good') {
        move = await defects.createMove(client, {
          warehouseId, companyId: item.company_id, sku: item.sku, qty, bucket: qualityBucket, note,
          source: 'return', invoiceId: item.invoice_id, cellBlockId, staffKeyId,
          vw: (await client.query('SELECT virtual_warehouse_id FROM invoice_items WHERE id = $1', [item.id])).rows[0]?.virtual_warehouse_id || null,
        });
      } else await journal.createEntry(client, {
        warehouseId,
        agent: 'Кладовщик',
        // Причина едет в журнал вместе с количеством: владельцу и продавцу
        // «2 шт брак» без причины решать не помогает.
        actionText: `Разобрал возврат «${item.name}» (${item.sku}): ${qty} шт. — ${BUCKET_LABEL[qualityBucket]}.`
          + (note ? ` Дефект: ${note}` : ''),
        entityType: 'invoice_item',
        entityId: invoiceItemId,
        invoiceId: item.invoice_id,
        cellBlockId: cellBlockId || null,
        actorType: 'worker',
        actorId: staffKeyId,
        status: 'auto',
      });

      // The line is done when every declared unit has been sorted into a
      // bucket — same completion shape as receiving (one line closes when its
      // quantity is fully accounted for), generalized to a sum since a return
      // line can take several calls instead of one.
      const remaining = await client.query(
        `SELECT ii.id, ii.declared_qty, COALESCE(SUM(rr.qty), 0) AS total
         FROM invoice_items ii
         LEFT JOIN return_records rr ON rr.invoice_item_id = ii.id
         WHERE ii.invoice_id = $1
         GROUP BY ii.id, ii.declared_qty
         HAVING COALESCE(SUM(rr.qty), 0) < ii.declared_qty`,
        [item.invoice_id],
      );
      const newStatus = remaining.rows.length === 0 ? 'completed' : 'in_progress';
      await client.query(`UPDATE invoices SET status = $2 WHERE id = $1`, [item.invoice_id, newStatus]);

      return { ...recordResult.rows[0], newTotal, declaredQty: declared, move };
    });
    res.status(201).json(record);
  } catch (err) {
    next(err);
  }
});

// «Новый возврат» (владелец 02.10.2026): пока возвраты не приходят из WB,
// склад заводит пришедшую коробку возвратов сам — продавец, товары,
// количество — и сразу разбирает её на годное и брак тем же экраном.
router.post('/manual', requireAuth, requireRole('worker', 'owner', 'manager'), async (req, res, next) => {
  try {
    const { warehouseId } = req.auth;
    const b = req.body || {};
    if (!Array.isArray(b.items) || !b.items.length) throw new HttpError(400, 'Добавьте хотя бы один товар');
    if (b.items.length > 200) throw new HttpError(400, 'В одном возврате — не больше 200 строк');
    const out = await withTenantContext({ warehouseId }, async (client) => {
      const company = (await client.query(
        'SELECT id, name, ff_rights FROM companies WHERE id = $1 AND warehouse_id = $2 AND archived_at IS NULL',
        [b.companyId, warehouseId])).rows[0];
      if (!company) throw new HttpError(404, 'Продавец не найден');
      // Склад продавца, на который ляжет возврат (владелец 02.10.2026): по
      // умолчанию склад заказа — заказа у ручного возврата нет, значит
      // «Основной». Другой склад — решение склада: продавцу «обратите
      // внимание», а запретил решать без него — нельзя.
      const vw = await vwarehouses.requireVw(client, company.id, b.vw || null);
      if (vw && !vwarehouses.rightsOf(company).decide) {
        throw new HttpError(409, `Продавец «${company.name}» запретил складу решать без него, на какой склад его товар, — `
          + `возврат ляжет на «${vwarehouses.MAIN_NAME}»`);
      }
      const bySku = new Map();
      for (const it of b.items) {
        const sku = typeof it?.sku === 'string' ? it.sku.trim() : '';
        if (!sku) throw new HttpError(400, 'У каждой строки — товар');
        const q = requireQty(it.qty, 'Количество', { min: 1 });
        bySku.set(sku, (bySku.get(sku) || 0) + q);
      }
      const found = new Map((await client.query(
        'SELECT sku, name FROM products WHERE company_id = $1 AND sku = ANY($2::text[])',
        [company.id, [...bySku.keys()]])).rows.map((r) => [r.sku, r.name]));
      const missing = [...bySku.keys()].filter((sku) => !found.has(sku));
      if (missing.length) throw new HttpError(400, `Нет в каталоге продавца: ${missing.slice(0, 3).join(', ')}`);
      // Номер ВЗ-ДДММГГ-N — под замком склада, день по поясу склада.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('manual-return:' || $1))", [warehouseId]);
      const [y, m, d] = todayIn(await zoneOf(client, warehouseId)).split('-');
      const head = `ВЗ-${d}${m}${y.slice(2)}-`;
      const used = (await client.query('SELECT number FROM invoices WHERE warehouse_id = $1 AND number LIKE $2',
        [warehouseId, `${head}%`])).rows.map((r) => Number(r.number.slice(head.length)) || 0);
      const number = head + (Math.max(0, ...used) + 1);
      const inv = (await client.query(
        `INSERT INTO invoices (warehouse_id, company_id, number, direction, source, source_document_type)
         VALUES ($1, $2, $3, 'return', 'manual', 'manual_return') RETURNING id, number`,
        [warehouseId, company.id, number])).rows[0];
      const items = [...bySku].map(([sku, qty]) => ({ sku, name: found.get(sku), qty }));
      await client.query(
        `INSERT INTO invoice_items (invoice_id, warehouse_id, company_id, name, sku, declared_qty, virtual_warehouse_id)
         SELECT $1, $2, $3, x.name, x.sku, x.qty, $5 FROM jsonb_to_recordset($4::jsonb) AS x(name text, sku text, qty int)`,
        [inv.id, warehouseId, company.id, JSON.stringify(items), vw ? vw.id : null]);
      const units = items.reduce((sum, i) => sum + i.qty, 0);
      const comment = typeof b.comment === 'string' && b.comment.trim() ? b.comment.trim().slice(0, 300) : null;
      await journal.createEntry(client, {
        warehouseId, agent: 'Кладовщик', status: 'auto',
        actionText: `Заведён возврат ${number} продавца «${company.name}» вручную: ${items.length} товаров, ${units} шт.`
          + (vw ? ` На склад продавца «${vw.name}».` : '')
          + (comment ? ` Комментарий: ${comment}` : '') + ' Возвраты из WB пока не приходят сами.',
        entityType: 'invoice', entityId: inv.id, invoiceId: inv.id,
        actorType: req.auth.role === 'seller' ? 'seller' : req.auth.role,
        actorId: req.auth.staffKeyId || req.auth.ownerId || null,
      });
      return { id: inv.id, number, items: items.length, units };
    });
    res.status(201).json(out);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
