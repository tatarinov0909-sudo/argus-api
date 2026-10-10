// Заказы физлицам по полной схеме (схема 06.10.2026, владелец 08.10.2026).
//
// Заказ заводит склад (руководитель, менеджер) или сам продавец, если склад
// это разрешил (warehouses.sellers_direct_orders). Это обычный заказ на
// отгрузку (invoices, source 'direct'): стоит в «Заказах», склад составляет из
// таких заказов поставку — несколько физлиц в одной, комплектовщик видит заказ
// только в поставке. Здесь — получатель и то, что после отъезда: трек-номер и
// статусы «в пути», «доставлен», «отказ / возврат», которые ставят вручную.
const { HttpError } = require('../middleware/errorHandler');
const { plural } = require('../journal/plural');
const journal = require('../journal/repository');
const vwarehouses = require('../vwarehouses/service');
const supplies = require('../supplies/service');
const { loadStock } = require('../sellers/stock');
const { warehouseToday } = require('../warehouses/time');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Сам вид документа: заказ живёт и без поставки (её можно разобрать — заказ
// вернётся в очередь), в отличие от «поставки физлицу одним шагом».
const DOC_TYPE = 'direct_order';
const DELIVERY = { in_transit: 'В пути', delivered: 'Доставлен', refused: 'Отказ / возврат' };
const STATUS_NAMES = { new: 'Новый', assembly: 'Собирается', ready: 'Собран', shipped: 'Уехал', ...DELIVERY };

// Статус заказа: до отъезда — сам, по работе склада; после — что отметили.
const STATUS_SQL = `CASE WHEN d.delivery_status IS NOT NULL THEN d.delivery_status
                         WHEN i.status = 'shipped' THEN 'shipped'
                         WHEN i.status = 'ready' THEN 'ready'
                         WHEN i.supply_id IS NOT NULL OR i.status = 'in_progress' THEN 'assembly'
                         ELSE 'new' END`;
// Поля заказа физлицу в общих списках заказов (d — direct_orders, i — invoices).
const DIRECT_FIELDS = `d.recipient, d.address, d.phone, d.delivery_service, d.track_number,
                to_char(d.planned_date, 'YYYY-MM-DD') AS planned_date, d.comment AS direct_comment,
                d.created_role, CASE WHEN d.invoice_id IS NOT NULL THEN ${STATUS_SQL} END AS direct_status`;

function text(value, label, max, { required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new HttpError(400, `${label} — текстом`);
  const t = String(value).trim().replace(/\s+/g, ' ');
  if (required && !t) throw new HttpError(400, `Укажите: ${label.toLowerCase()}`);
  if (t.length > max) throw new HttpError(400, `${label} — не длиннее ${max} знаков`);
  return t || null;
}

const actorName = (actor) => actor.name || (actor.type === 'seller' ? 'Продавец' : 'Склад');

async function companyName(client, companyId) {
  return (await client.query('SELECT name FROM companies WHERE id = $1', [companyId])).rows[0]?.name || '';
}

// Продавцу — не больше свободного (того же «Доступно», что он видит у себя,
// а на своём складе — его «Доступно», но не больше общего: товар, обещанный
// заказу «весь мой товар» или заказам WB вне поставки, лежит и на этом
// складе — проверка 08.10, Н1). Склад может больше: учёт бывает неточным,
// экран склада переспрашивает сам.
async function requireFree(client, warehouseId, companyId, vw, lines) {
  const source = (await client.query('SELECT stock_source FROM warehouses WHERE id = $1', [warehouseId]))
    .rows[0]?.stock_source === 'argus' ? 'argus' : '1c';
  const rows = new Map((await loadStock(client, companyId, { source })).map((r) => [r.sku, r]));
  for (const l of lines) {
    const r = rows.get(l.sku);
    // «Свободно» склада уже не больше общего «Доступно» (stock.js, splitOf).
    const free = !r || r.sellerAvailable == null ? null
      : vw ? (r.byWarehouse || []).find((w) => w.id === vw.id)?.available ?? null : r.sellerAvailable;
    if (free === null) throw new HttpError(409, `Сколько «${l.name}» на складе, пока неизвестно — заказ не создать. Спросите склад.`);
    if (l.qty > free) {
      throw new HttpError(409, `«${l.name}»: свободно ${free} шт.${vw ? ` на складе «${vw.name}»` : ''}, а в заказе ${l.qty}.`);
    }
  }
}

// Номер заказа физлицу — ЗФ-ДДММГГ-N. Выданный номер занят навсегда, и у
// отменённого заказа: его называют покупателю и пишут в накладную службы
// (проверка 08.10, Н7). Занятые номера лежат там же, где номера поставок.
async function nextOrderNumber(client, warehouseId) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('direct-number:' || $1))", [warehouseId]);
  const [y, m, d] = (await warehouseToday(client, warehouseId)).split('-');
  const head = `ЗФ-${d}${m}${y.slice(2)}-`;
  const taken = (await client.query(
    `SELECT number FROM supply_numbers WHERE warehouse_id = $1 AND number LIKE $2
     UNION ALL SELECT number FROM invoices WHERE warehouse_id = $1 AND number LIKE $2`,
    [warehouseId, `${head}%`])).rows.map((r) => Number(r.number.slice(head.length)) || 0);
  const number = head + (Math.max(0, ...taken) + 1);
  await client.query('INSERT INTO supply_numbers (warehouse_id, number) VALUES ($1, $2)', [warehouseId, number]);
  return number;
}

async function create(client, warehouseId, {
  companyId, vwId = null, items, recipient, address, phone, deliveryService, plannedDate, comment,
  toSupply = false, requestId = null, actor,
}) {
  if (requestId !== null && requestId !== undefined && !UUID.test(String(requestId))) {
    throw new HttpError(400, 'Неверный номер операции');
  }
  const to = {
    recipient: text(recipient, 'Кому', 120, { required: true }),
    // Адрес — необязательный (владелец 10.10.2026): забирают сами или уточнят позже.
    address: text(address, 'Адрес', 300),
    phone: text(phone, 'Телефон', 40),
    service: text(deliveryService, 'Служба доставки', 60),
    comment: text(comment, 'Комментарий', 500),
    date: supplies.cleanShipDate(plannedDate, await warehouseToday(client, warehouseId)),
  };
  const seller = actor.type === 'seller';
  if (seller) {
    const allowed = (await client.query('SELECT sellers_direct_orders FROM warehouses WHERE id = $1', [warehouseId])).rows[0];
    if (!allowed || !allowed.sellers_direct_orders) {
      throw new HttpError(403, 'Склад не принимает заказы физлицам от продавцов — заказ оформит сам склад.');
    }
  }
  const lines = await supplies.cleanItems(client, warehouseId, companyId, items);
  const vw = await vwarehouses.requireVw(client, companyId, vwId);

  // Заказы одного продавца — по очереди: «свободно» и повтор окна считаются
  // по уже записанным заказам, а не по тем, что пишутся рядом.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('direct-order:' || $1))", [companyId]);
  if (requestId) {
    const prior = (await client.query(
      `SELECT i.id, i.number, d.virtual_warehouse_id, d.recipient, d.address, d.phone, d.delivery_service, d.comment,
              to_char(d.planned_date, 'YYYY-MM-DD') AS planned_day,
              (SELECT string_agg(ii.sku || ':' || ii.declared_qty, ',' ORDER BY ii.sku)
                 FROM invoice_items ii WHERE ii.invoice_id = i.id) AS lines
         FROM direct_orders d JOIN invoices i ON i.id = d.invoice_id
        WHERE d.company_id = $1 AND d.request_id = $2`, [companyId, requestId])).rows[0];
    if (prior) {
      const asked = lines.map((l) => `${l.sku}:${l.qty}`).sort().join(',');
      if (prior.lines !== asked || (prior.virtual_warehouse_id || null) !== (vw ? vw.id : null)) {
        throw new HttpError(409, `По этому окну уже создан заказ ${prior.number} с другими товарами — обновите экран.`);
      }
      // Исправили получателя и нажали ещё раз — не «создан» со старым адресом
      // (проверка 08.10, Н5).
      const same = (a, b) => (a || null) === (b || null);
      if (!same(prior.recipient, to.recipient) || !same(prior.address, to.address) || !same(prior.phone, to.phone)
          || !same(prior.delivery_service, to.service) || !same(prior.comment, to.comment) || !same(prior.planned_day, to.date)) {
        throw new HttpError(409, `По этому окну уже создан заказ ${prior.number} с другим получателем — обновите экран `
          + 'и поправьте получателя в заказе.');
      }
      return { id: prior.id, number: prior.number, replayed: true };
    }
  }
  if (seller) await requireFree(client, warehouseId, companyId, vw, lines);

  const number = await nextOrderNumber(client, warehouseId);
  const order = (await client.query(
    `INSERT INTO invoices (warehouse_id, company_id, number, direction, source, source_document_type)
     VALUES ($1, $2, $3, 'out', 'direct', '${DOC_TYPE}') RETURNING id, number`,
    [warehouseId, companyId, number])).rows[0];
  await supplies.insertLines(client, warehouseId, companyId, order.id, lines, vw ? vw.id : null);
  await client.query(
    `INSERT INTO direct_orders (invoice_id, warehouse_id, company_id, virtual_warehouse_id, recipient, address, phone,
                                delivery_service, planned_date, comment, created_role, created_by_name, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [order.id, warehouseId, companyId, vw ? vw.id : null, to.recipient, to.address, to.phone, to.service, to.date,
      to.comment, actor.type, actorName(actor), requestId || null]);

  const units = lines.reduce((n, l) => n + l.qty, 0);
  await journal.createEntry(client, {
    warehouseId,
    agent: 'Кладовщик',
    actionText: `Заказ физлицу «${number}»${seller ? ' от продавца' : ''} «${await companyName(client, companyId)}»: `
      + `${units} шт. — ${to.recipient}${to.address ? `, ${to.address}` : ''}${to.service ? `, ${to.service}` : ''}`
      + `${vw ? `, со склада «${vw.name}»` : ''}.`,
    entityType: 'invoice', entityId: order.id, invoiceId: order.id,
    actorType: actor.type, actorId: actor.id || null,
  });

  // «Создать и сразу на сборку» — только склад: поставку составляет он.
  let supply = null;
  if (toSupply && !seller) {
    supply = await supplies.create(client, warehouseId, {
      invoiceIds: [order.id], shipDate: to.date, actor: { type: actor.type, id: actor.id },
    });
  }
  return { id: order.id, number, supply: supply && { id: supply.id, number: supply.number } };
}

function view(r) {
  return {
    id: r.id, number: r.number, companyId: r.company_id, companyName: r.company_name,
    createdAt: r.created_at, createdRole: r.created_role, createdBy: r.created_by_name,
    recipient: r.recipient, address: r.address, phone: r.phone, deliveryService: r.delivery_service,
    plannedDate: r.planned_date, comment: r.comment, trackNumber: r.track_number,
    vwName: r.virtual_warehouse_id ? r.vw_name : null,
    status: r.state, statusName: STATUS_NAMES[r.state],
    statusAt: r.delivery_status_at || r.shipped_at || null,
    supplyNumber: r.supply_number || null,
    canCancel: r.state === 'new' && !r.picked,
    canMark: r.invoice_status === 'shipped',
    items: r.items || [],
  };
}

// Последние заказы физлицам — склада (все продавцы) или одного продавца.
async function list(client, { companyId = null, limit = 300 } = {}) {
  const rows = (await client.query(
    `SELECT i.id, i.number, i.company_id, c.name AS company_name, i.status AS invoice_status, i.shipped_at,
            d.*, to_char(d.planned_date, 'YYYY-MM-DD') AS planned_date, vw.name AS vw_name,
            ${STATUS_SQL} AS state, s.number AS supply_number,
            EXISTS (SELECT 1 FROM shipping_records sr JOIN invoice_items x ON x.id = sr.invoice_item_id
                     WHERE x.invoice_id = i.id) AS picked,
            (SELECT json_agg(json_build_object('sku', ii.sku, 'name', ii.name, 'qty', ii.declared_qty) ORDER BY ii.name)
               FROM invoice_items ii WHERE ii.invoice_id = i.id) AS items
       FROM direct_orders d
       JOIN invoices i ON i.id = d.invoice_id
       JOIN companies c ON c.id = d.company_id AND c.archived_at IS NULL
       LEFT JOIN supplies s ON s.id = i.supply_id
       LEFT JOIN virtual_warehouses vw ON vw.id = d.virtual_warehouse_id
      WHERE ($1::uuid IS NULL OR d.company_id = $1)
      ORDER BY d.created_at DESC
      LIMIT $2`, [companyId, limit + 1])).rows;
  return { rows: rows.slice(0, limit).map(view), hasMore: rows.length > limit };
}

async function lockOrder(client, warehouseId, invoiceId, companyId) {
  if (!UUID.test(String(invoiceId))) throw new HttpError(404, 'Заказ не найден');
  const r = (await client.query(
    `SELECT i.id, i.number, i.status, i.supply_id, i.company_id, d.track_number, d.delivery_status
       FROM invoices i JOIN direct_orders d ON d.invoice_id = i.id
      WHERE i.warehouse_id = $1 AND i.id = $2 FOR UPDATE OF i, d`, [warehouseId, invoiceId])).rows[0];
  // Продавец — только свои заказы; чужой для него «не найден».
  if (!r || (companyId && r.company_id !== companyId)) throw new HttpError(404, 'Заказ не найден');
  return r;
}

// Трек-номер — когда угодно (служба выдаёт его и до отъезда); статус после
// отъезда — только когда заказ уехал. null снимает отметку.
async function setDelivery(client, warehouseId, invoiceId, { companyId = null, body = {}, actor }) {
  const order = await lockOrder(client, warehouseId, invoiceId, companyId);
  const sets = [];
  const args = [invoiceId];
  const said = [];
  if (Object.prototype.hasOwnProperty.call(body, 'trackNumber')) {
    const track = text(body.trackNumber, 'Трек-номер', 60);
    args.push(track); sets.push(`track_number = $${args.length}`);
    said.push(track ? `трек-номер ${track}` : 'трек-номер убран');
  }
  if (Object.prototype.hasOwnProperty.call(body, 'deliveryStatus')) {
    const status = body.deliveryStatus || null;
    if (status !== null && !DELIVERY[status]) throw new HttpError(400, 'Статус — «в пути», «доставлен» или «отказ / возврат»');
    if (order.status !== 'shipped') throw new HttpError(409, `Заказ «${order.number}» ещё не уехал — этот статус ставят после отъезда.`);
    args.push(status); sets.push(`delivery_status = $${args.length}`, 'delivery_status_at = now()');
    args.push(actorName(actor)); sets.push(`delivery_status_by = $${args.length}`);
    said.push(status ? `статус «${DELIVERY[status]}»` : 'статус после отъезда снят');
  }
  if (!sets.length) throw new HttpError(400, 'Нечего менять');
  await client.query(`UPDATE direct_orders SET ${sets.join(', ')} WHERE invoice_id = $1`, args);
  await journal.createEntry(client, {
    warehouseId, agent: 'Кладовщик',
    actionText: `Заказ физлицу «${order.number}»: ${said.join(', ')} (${actorName(actor)}).`,
    entityType: 'invoice', entityId: invoiceId, invoiceId, actorType: actor.type, actorId: actor.id || null,
  });
  const fresh = await list(client, { companyId: order.company_id, limit: 300 });
  return fresh.rows.find((r) => r.id === invoiceId) || null;
}

// Отменить можно только новый заказ: не в поставке и ничего не отобрано.
// Дальше — через склад: разобрать поставку или убрать заказ из неё.
async function cancel(client, warehouseId, invoiceId, { companyId = null, actor }) {
  const order = await lockOrder(client, warehouseId, invoiceId, companyId);
  const picked = (await client.query(
    `SELECT 1 FROM shipping_records sr JOIN invoice_items ii ON ii.id = sr.invoice_item_id
      WHERE ii.invoice_id = $1 LIMIT 1`, [invoiceId])).rows[0];
  if (order.supply_id || picked || order.status !== 'open') {
    throw new HttpError(409, `Заказ «${order.number}» склад уже взял в работу — отменить его может только склад, `
      + 'убрав заказ из поставки.');
  }
  const units = Number((await client.query(
    'SELECT COALESCE(SUM(declared_qty), 0) AS n FROM invoice_items WHERE invoice_id = $1', [invoiceId])).rows[0].n);
  await client.query('DELETE FROM invoices WHERE warehouse_id = $1 AND id = $2', [warehouseId, invoiceId]);
  await journal.createEntry(client, {
    warehouseId, agent: 'Кладовщик',
    actionText: `Заказ физлицу «${order.number}» отменён (${actorName(actor)}): ${units} `
      + `${plural(units, 'штука', 'штуки', 'штук')} снова ${plural(units, 'свободна', 'свободны', 'свободны')}.`,
    entityType: 'invoice', entityId: invoiceId, actorType: actor.type, actorId: actor.id || null,
  });
  return { number: order.number };
}

module.exports = { create, list, setDelivery, cancel, DIRECT_FIELDS, STATUS_NAMES };
