const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { withTenantContext } = require('../db/pool');
const { HttpError } = require('../middleware/errorHandler');
const journal = require('../journal/repository');
const inbound = require('../sellers/inbound');

// Привоз товара после оформления (владелец 26.09.2026): карточка привоза,
// правка и отмена до приезда машины, «машина приехала», документы
// поставщика, переписка склада с продавцом и ответ продавца на акт
// расхождений. Всё — в контексте склада; продавцу — только его приходы
// (проверка ниже, как у акта приёмки).
const router = express.Router();

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FILE = 10 * 1024 * 1024;
const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const MAX_DOCS = 20;

const actorOf = (auth) => (auth.role === 'seller'
  ? { type: 'seller', id: auth.sellerKeyId || null }
  : { type: auth.role, id: auth.staffKeyId || auth.ownerId || null });

async function findInbound(client, auth, id, { lock = false } = {}) {
  if (!uuid.test(String(id))) throw new HttpError(404, 'Приход не найден');
  const inv = (await client.query(
    `SELECT i.*, c.name AS company_name FROM invoices i JOIN companies c ON c.id = i.company_id
      WHERE i.warehouse_id = $1 AND i.id = $2 ${lock ? 'FOR UPDATE OF i' : ''}`, [auth.warehouseId, id])).rows[0];
  if (!inv || inv.direction !== 'in' || (auth.role === 'seller' && inv.company_id !== auth.companyId)) {
    throw new HttpError(404, 'Приход не найден');
  }
  return inv;
}

async function authorName(client, auth, inv) {
  if (auth.role === 'seller') return inv.company_name;
  if (auth.role === 'owner') return 'Руководитель склада';
  const s = (await client.query('SELECT name FROM staff_keys WHERE id = $1', [auth.staffKeyId])).rows[0];
  return s ? `Менеджер ${s.name}` : 'Менеджер склада';
}

const run = (req, fn) => withTenantContext({ warehouseId: req.auth.warehouseId }, (c) => fn(c));
const fmtDate = (d) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10).split('-').reverse().join('.') : '');
const hhmm = (t) => (t ? String(t).slice(0, 5) : null);

// Карточка привоза: всё, что знают о нём склад и продавец.
router.get('/:id', requireAuth, requireRole('seller', 'owner', 'manager', 'worker'), async (req, res, next) => {
  try {
    const out = await run(req, async (c) => {
      const inv = await findInbound(c, req.auth, req.params.id);
      const items = (await c.query(
        `SELECT ii.sku, ii.name, ii.declared_qty,
                (SELECT SUM(rr.accepted_qty) FROM receiving_records rr WHERE rr.invoice_item_id = ii.id) AS accepted,
                (SELECT SUM(rr.accepted_qty) FROM receiving_records rr WHERE rr.invoice_item_id = ii.id AND rr.cell_block_id IS NULL) AS unplaced,
                (SELECT MIN(rr.finished_at) FROM receiving_records rr WHERE rr.invoice_item_id = ii.id) AS first_at,
                (SELECT MAX(rr.finished_at) FROM receiving_records rr WHERE rr.invoice_item_id = ii.id) AS last_at
           FROM invoice_items ii WHERE ii.invoice_id = $1 ORDER BY ii.name`, [inv.id])).rows;
      const num = (v) => (v == null ? null : Number(v));
      const done = items.filter((i) => i.accepted != null);
      const completed = inv.status === 'completed';
      const firstAt = done.map((i) => i.first_at).sort((a, b) => a - b)[0] || null;
      const lastAt = done.map((i) => i.last_at).sort((a, b) => b - a)[0] || null;
      const worker = req.auth.role === 'worker';
      const docs = worker ? [] : (await c.query(
        `SELECT id, kind, number, to_char(doc_date, 'DD.MM.YYYY') AS doc_date, supplier, file_name, file_type, file_size, added_by, created_at
           FROM invoice_documents WHERE invoice_id = $1 ORDER BY created_at`, [inv.id])).rows;
      // Переписка — между складом и продавцом; у грузчика чата нет (правило владельца).
      const comments = worker ? [] : (await c.query(
        `SELECT id, sku, author_role, author_name, body, created_at FROM invoice_comments
          WHERE invoice_id = $1 ORDER BY created_at, id`, [inv.id])).rows;
      const names = new Map(items.map((i) => [i.sku, i.name]));
      return {
        id: inv.id, number: inv.number, status: inv.status, companyId: inv.company_id, companyName: inv.company_name,
        sellerInbound: inv.source_document_type === 'seller_inbound', createdAt: inv.created_at,
        plannedDate: inv.source_document_type === 'seller_inbound' && inv.source_document_date ? String(inv.source_document_date).slice(0, 10) : null,
        plannedFrom: hhmm(inv.planned_from), plannedTo: hhmm(inv.planned_to),
        boxes: inv.boxes, pallets: inv.pallets, weightKg: num(inv.weight_kg),
        carrier: inv.carrier, vehicle: inv.vehicle, comment: inv.inbound_comment,
        arrivedAt: inv.arrived_at, arrivedBoxes: inv.arrived_boxes, arrivedPallets: inv.arrived_pallets,
        firstAt, lastAt,
        declared: items.reduce((s, i) => s + Number(i.declared_qty), 0),
        accepted: done.length ? done.reduce((s, i) => s + Number(i.accepted), 0) : null,
        // Принято «на своё место», без ячейки: ещё не размещено по ячейкам.
        unplaced: items.reduce((s, i) => s + Number(i.unplaced || 0), 0),
        editable: inv.source_document_type === 'seller_inbound' && inv.status === 'open' && !inv.arrived_at && !done.length,
        discrepancy: completed ? done.reduce((s, i) => s + Number(i.accepted), 0) - items.reduce((s, i) => s + Number(i.declared_qty), 0) : null,
        lines: items.map((i) => ({ sku: i.sku, name: i.name, declared: Number(i.declared_qty), accepted: num(i.accepted) })),
        verdict: inv.seller_verdict ? { value: inv.seller_verdict, at: inv.seller_verdict_at, note: inv.seller_verdict_note } : null,
        documents: docs.map((d) => ({ id: d.id, kind: d.kind, number: d.number, date: d.doc_date,
          supplier: d.supplier, fileName: d.file_name, fileType: d.file_type, fileSize: d.file_size, addedBy: d.added_by, createdAt: d.created_at })),
        comments: comments.map((m) => ({ id: m.id, sku: m.sku, productName: m.sku ? names.get(m.sku) || m.sku : null,
          authorRole: m.author_role, authorName: m.author_name, body: m.body, createdAt: m.created_at })),
      };
    });
    res.set('Cache-Control', 'no-store').json(out);
  } catch (err) { next(err); }
});

// Изменить привоз до приезда машины: дата, окно, грузоместа, кто везёт.
// Список товаров меняется повторной загрузкой файла (POST /api/sellers/inbound
// с invoiceId).
router.patch('/:id', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const out = await run(req, async (c) => {
      const found = await findInbound(c, req.auth, req.params.id);
      const inv = await inbound.lockEditable(c, req.auth.warehouseId, found.id);
      const d = inbound.readDetails(req.body || {});
      await inbound.saveDetails(c, inv.id, d);
      await journal.createEntry(c, {
        warehouseId: req.auth.warehouseId, agent: 'Кладовщик',
        actionText: `${req.auth.role === 'seller' ? `Продавец «${found.company_name}»` : 'Склад'} изменил привоз ${inv.number}. `
          + (inbound.describe(d) || 'Дата, окно и грузоместа не указаны.'),
        entityType: 'invoice', entityId: inv.id, invoiceId: inv.id, ...actorFields(req.auth),
      });
      return { ok: true };
    });
    res.json(out);
  } catch (err) { next(err); }
});

// Отменить привоз до приезда машины. Приход удаляется целиком; журнал
// помнит, что он был и кто отменил.
router.delete('/:id', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const out = await run(req, async (c) => {
      const found = await findInbound(c, req.auth, req.params.id);
      const inv = await inbound.lockEditable(c, req.auth.warehouseId, found.id);
      const t = (await c.query('SELECT count(*)::int AS n, COALESCE(SUM(declared_qty), 0)::int AS units FROM invoice_items WHERE invoice_id = $1', [inv.id])).rows[0];
      await c.query('DELETE FROM invoices WHERE id = $1', [inv.id]);
      await c.query('INSERT INTO inbound_canceled_numbers (warehouse_id, number) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [req.auth.warehouseId, inv.number]);
      await journal.createEntry(c, {
        warehouseId: req.auth.warehouseId, agent: 'Кладовщик',
        actionText: `${req.auth.role === 'seller' ? `Продавец «${found.company_name}»` : 'Склад'} отменил привоз ${inv.number} `
          + `(${t.n} товаров, ${t.units} шт.) — машина не приедет.`,
        entityType: 'invoice', entityId: inv.id, ...actorFields(req.auth),
      });
      return { ok: true, number: inv.number };
    });
    res.json(out);
  } catch (err) { next(err); }
});

function actorFields(auth) {
  const a = actorOf(auth);
  return { actorType: a.type, actorId: a.id };
}

// «Машина приехала» — отмечает склад у ворот: грузчик или руководитель.
// Сколько мест приехало — пересчитывают сразу при выгрузке.
router.post('/:id/arrived', requireAuth, requireRole('owner', 'manager', 'worker'), async (req, res, next) => {
  try {
    const out = await run(req, async (c) => {
      const inv = await findInbound(c, req.auth, req.params.id, { lock: true });
      if (inv.arrived_at) throw new HttpError(409, `Приезд машины по приходу «${inv.number}» уже отмечен`);
      if (inv.status === 'completed') throw new HttpError(409, `Приход «${inv.number}» уже принят`);
      const d = inbound.readDetails({ boxes: (req.body || {}).boxes, pallets: (req.body || {}).pallets });
      const at = (await c.query(
        'UPDATE invoices SET arrived_at = now(), arrived_boxes = $2, arrived_pallets = $3 WHERE id = $1 RETURNING arrived_at',
        [inv.id, d.boxes, d.pallets])).rows[0].arrived_at;
      const differs = (inv.boxes != null && d.boxes != null && inv.boxes !== d.boxes)
        || (inv.pallets != null && d.pallets != null && inv.pallets !== d.pallets);
      const got = inbound.placesText(d.boxes, d.pallets);
      await journal.createEntry(c, {
        warehouseId: req.auth.warehouseId, agent: 'Кладовщик',
        actionText: `Машина по приходу ${inv.number} продавца «${inv.company_name}» приехала.`
          + (got ? ` Мест: ${got}.` : '')
          + (differs ? ` Заявлено было: ${inbound.placesText(inv.boxes, inv.pallets)} — мест не столько, сколько обещал продавец.` : ''),
        entityType: 'invoice', entityId: inv.id, invoiceId: inv.id, status: differs ? 'pending' : 'auto', ...actorFields(req.auth),
      });
      return { arrivedAt: at };
    });
    res.json(out);
  } catch (err) { next(err); }
});

// Переписка по приходу: продавец и склад (владелец 26.09.2026 — «прикрепить
// к поставке комментарий, что в документе не хватает кода товара»). Можно
// про весь приход или про одну его строку.
router.post('/:id/comments', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    if (!body) throw new HttpError(400, 'Напишите комментарий');
    if (body.length > 1000) throw new HttpError(400, 'Комментарий — до 1000 знаков');
    const out = await run(req, async (c) => {
      const inv = await findInbound(c, req.auth, req.params.id);
      const sku = typeof req.body.sku === 'string' && req.body.sku ? req.body.sku : null;
      let product = null;
      if (sku) {
        product = (await c.query('SELECT name FROM invoice_items WHERE invoice_id = $1 AND sku = $2 LIMIT 1', [inv.id, sku])).rows[0];
        if (!product) throw new HttpError(400, 'Такого товара в приходе нет');
      }
      const name = await authorName(c, req.auth, inv);
      const row = (await c.query(
        `INSERT INTO invoice_comments (invoice_id, warehouse_id, company_id, sku, author_role, author_name, body)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, created_at`,
        [inv.id, req.auth.warehouseId, inv.company_id, sku, req.auth.role, name, body])).rows[0];
      const about = product ? ` о товаре «${product.name}»` : '';
      if (req.auth.role === 'seller') {
        // Ждёт ответа склада; ответ в переписке и закрывает эту отметку.
        await journal.createEntry(c, {
          warehouseId: req.auth.warehouseId, agent: 'Кладовщик', status: 'pending',
          actionText: `Продавец «${inv.company_name}» написал по приходу ${inv.number}${about}: «${body}»`,
          entityType: 'invoice_comment', entityId: row.id, invoiceId: inv.id, ...actorFields(req.auth),
        });
      } else {
        const open = (await c.query(
          `SELECT je.id FROM journal_entries je
            WHERE je.warehouse_id = $1 AND je.invoice_id = $2 AND je.entity_type = 'invoice_comment' AND je.status = 'pending'
              AND NOT EXISTS (SELECT 1 FROM journal_entries a WHERE a.related_entry_id = je.id)`,
          [req.auth.warehouseId, inv.id])).rows;
        for (const e of open) {
          await journal.resolveEntry(c, {
            warehouseId: req.auth.warehouseId, originalEntryId: e.id, resolution: 'confirm',
            resolvedByOwnerId: req.auth.role === 'owner' ? req.auth.ownerId || null : null,
            note: `склад ответил продавцу по приходу ${inv.number}: «${body}»`,
            actorType: req.auth.role === 'manager' ? 'manager' : 'owner', actorId: req.auth.staffKeyId || req.auth.ownerId || null,
          });
        }
        if (!open.length) {
          await journal.createEntry(c, {
            warehouseId: req.auth.warehouseId, agent: 'Кладовщик',
            actionText: `${name} написал продавцу «${inv.company_name}» по приходу ${inv.number}${about}: «${body}»`,
            entityType: 'invoice_comment', entityId: row.id, invoiceId: inv.id, ...actorFields(req.auth),
          });
        }
      }
      return { id: row.id, createdAt: row.created_at };
    });
    res.status(201).json(out);
  } catch (err) { next(err); }
});

// Ответ продавца на акт: «согласен» или «не согласен» с причиной. Один раз,
// когда приход принят целиком: дальше спор идёт в переписке.
router.post('/:id/verdict', requireAuth, requireRole('seller'), async (req, res, next) => {
  try {
    const verdict = (req.body || {}).verdict;
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 1000) : '';
    if (!['agreed', 'disputed'].includes(verdict)) throw new HttpError(400, 'Ответ — «согласен» или «не согласен»');
    if (verdict === 'disputed' && note.length < 3) throw new HttpError(400, 'Напишите, с чем вы не согласны');
    const out = await run(req, async (c) => {
      const inv = await findInbound(c, req.auth, req.params.id, { lock: true });
      if (inv.status !== 'completed') throw new HttpError(409, `Приход «${inv.number}» ещё принимается — ответить на акт можно, когда склад закончит`);
      if (inv.seller_verdict) throw new HttpError(409, 'Вы уже ответили на этот акт. Если что-то не так — напишите складу в комментарии');
      await c.query('UPDATE invoices SET seller_verdict = $2, seller_verdict_at = now(), seller_verdict_note = $3 WHERE id = $1',
        [inv.id, verdict, note || null]);
      await journal.createEntry(c, {
        warehouseId: req.auth.warehouseId, agent: 'Кладовщик', status: verdict === 'disputed' ? 'pending' : 'auto',
        actionText: verdict === 'agreed'
          ? `Продавец «${inv.company_name}» согласен с актом приёмки ${inv.number}.${note ? ` Комментарий: ${note}` : ''}`
          : `Продавец «${inv.company_name}» НЕ согласен с актом приёмки ${inv.number}: «${note}»`,
        entityType: 'invoice', entityId: inv.id, invoiceId: inv.id, ...actorFields(req.auth),
      });
      return { ok: true };
    });
    res.json(out);
  } catch (err) { next(err); }
});

// Документы поставщика: сначала реквизиты, потом, если есть, файл.
router.post('/:id/documents', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : null);
    const kind = str(b.kind, 40);
    if (!kind) throw new HttpError(400, 'Укажите вид документа: УПД, ТТН или другой');
    const date = b.date ? inbound.readDetails({ plannedDate: b.date }).plannedDate : null;
    const out = await run(req, async (c) => {
      const inv = await findInbound(c, req.auth, req.params.id, { lock: true });
      const count = (await c.query('SELECT count(*)::int AS n FROM invoice_documents WHERE invoice_id = $1', [inv.id])).rows[0].n;
      if (count >= MAX_DOCS) throw new HttpError(409, `К приходу — не больше ${MAX_DOCS} документов`);
      const row = (await c.query(
        `INSERT INTO invoice_documents (invoice_id, warehouse_id, company_id, kind, number, doc_date, supplier, added_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [inv.id, req.auth.warehouseId, inv.company_id, kind, str(b.number, 60), date, str(b.supplier, 200),
          req.auth.role === 'seller' ? 'seller' : 'warehouse'])).rows[0];
      const what = [kind, str(b.number, 60) && `№ ${str(b.number, 60)}`, date && `от ${fmtDate(date)}`,
        str(b.supplier, 200) && `(${str(b.supplier, 200)})`].filter(Boolean).join(' ');
      await journal.createEntry(c, {
        warehouseId: req.auth.warehouseId, agent: 'Кладовщик',
        actionText: `${req.auth.role === 'seller' ? `Продавец «${inv.company_name}»` : 'Склад'} добавил документ к приходу ${inv.number}: ${what}.`,
        entityType: 'invoice', entityId: inv.id, invoiceId: inv.id, ...actorFields(req.auth),
      });
      return { id: row.id };
    });
    res.status(201).json(out);
  } catch (err) { next(err); }
});

async function findDocument(c, auth, invoiceId, docId) {
  const inv = await findInbound(c, auth, invoiceId);
  if (!uuid.test(String(docId))) throw new HttpError(404, 'Документ не найден');
  const doc = (await c.query('SELECT id, added_by, kind FROM invoice_documents WHERE id = $1 AND invoice_id = $2', [docId, inv.id])).rows[0];
  if (!doc) throw new HttpError(404, 'Документ не найден');
  return { inv, doc };
}

// Файл читается после проверки входа: чужой не зальёт на сервер 10 МБ.
const rawFile = express.raw({ type: () => true, limit: MAX_FILE });
const readFile = (req, res, next) => rawFile(req, res, (err) => next(err && err.type === 'entity.too.large'
  ? new HttpError(413, 'Файл больше 10 МБ — сожмите скан или разбейте на части') : err));

router.put('/:id/documents/:docId/file', requireAuth, requireRole('seller', 'owner', 'manager'), readFile,
  async (req, res, next) => {
    try {
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!FILE_TYPES.includes(type)) throw new HttpError(400, 'Файл — PDF или фото (JPG, PNG, WEBP, HEIC)');
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Файл пустой');
      let name = 'документ';
      try { name = decodeURIComponent(String(req.headers['x-file-name'] || '')).slice(0, 200) || name; } catch { /* имя не обязательно */ }
      await run(req, async (c) => {
        const { doc } = await findDocument(c, req.auth, req.params.id, req.params.docId);
        if (req.auth.role === 'seller' && doc.added_by !== 'seller') throw new HttpError(403, 'Это документ склада');
        await c.query('UPDATE invoice_documents SET file_name = $2, file_type = $3, file_size = $4, file_data = $5 WHERE id = $1',
          [doc.id, name, type, req.body.length, req.body]);
      });
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

router.get('/:id/documents/:docId/file', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    const file = await run(req, async (c) => {
      const { doc } = await findDocument(c, req.auth, req.params.id, req.params.docId);
      return (await c.query('SELECT file_name, file_type, file_data FROM invoice_documents WHERE id = $1', [doc.id])).rows[0];
    });
    if (!file.file_data) throw new HttpError(404, 'Файл к документу не приложен');
    res.set('Content-Type', file.file_type);
    res.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.file_name || 'документ')}`);
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.send(file.file_data);
  } catch (err) { next(err); }
});

// Продавец убирает свой документ, пока приход не принят; склад — любой.
router.delete('/:id/documents/:docId', requireAuth, requireRole('seller', 'owner', 'manager'), async (req, res, next) => {
  try {
    await run(req, async (c) => {
      const { inv, doc } = await findDocument(c, req.auth, req.params.id, req.params.docId);
      if (req.auth.role === 'seller' && (doc.added_by !== 'seller' || inv.status === 'completed')) {
        throw new HttpError(403, doc.added_by !== 'seller' ? 'Это документ склада' : 'Приход уже принят — документ остаётся при нём');
      }
      await c.query('DELETE FROM invoice_documents WHERE id = $1', [doc.id]);
      await journal.createEntry(c, {
        warehouseId: req.auth.warehouseId, agent: 'Кладовщик',
        actionText: `${req.auth.role === 'seller' ? `Продавец «${inv.company_name}»` : 'Склад'} убрал документ «${doc.kind}» из прихода ${inv.number}.`,
        entityType: 'invoice', entityId: inv.id, invoiceId: inv.id, ...actorFields(req.auth),
      });
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
