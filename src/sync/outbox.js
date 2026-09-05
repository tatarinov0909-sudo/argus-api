// Append-only queue of movements 1C still has to post.
//
// Every write here runs on the caller's client, inside the caller's
// transaction, on purpose: a receiving or shipping record and its sync event
// must commit or roll back together. If they could diverge, stock would move
// in our database with nothing telling 1C about it — the exact silent drift
// this product exists to prevent.
//
// Deliberately absent from every payload: cells. 1C has no concept of a cell
// (warehouse geometry is ours alone — see the 1C architecture notes), it only
// needs warehouse totals. Sending shelf addresses would be noise it cannot use.

const EVENT_RECEIVING = 'receiving_completed';
const EVENT_SHIPPING = 'shipping_completed';
// Возврат, сборка набора и пересчёт тоже двигают остаток — и до сих пор в
// очередь не попадали. То есть обещание «1С узнает обо всём» было верно ровно
// наполовину: приход и расход по документам уезжали, а товар, вернувшийся от
// покупателя, разобранный в набор или найденный при пересчёте, — нет. Включив
// когда-нибудь запись в 1С, мы бы получили расхождение с первого же возврата.
const EVENT_RETURN = 'return_sorted';
const EVENT_ASSEMBLY = 'kit_assembled';
const EVENT_INVENTORY = 'inventory_applied';

async function append(client, { warehouseId, eventType, payload }) {
  const result = await client.query(
    `INSERT INTO sync_outbox (warehouse_id, event_type, payload)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id, event_type, created_at`,
    [warehouseId, eventType, JSON.stringify(payload)],
  );
  return result.rows[0];
}

// Enough for 1C to find the document line it already knows about and post the
// actual quantity against it. externalId fields are null until nomenclature and
// documents have been synced through at least once; the 1C module falls back to
// matching on number/sku in that case.
function movementPayload({
  direction, item, invoice, company, actualQty, occurredAt,
}) {
  return {
    direction,
    invoice: {
      id: invoice.id,
      number: invoice.number,
      externalId: invoice.external_id ?? null,
    },
    line: {
      id: item.id,
      externalId: item.external_id ?? null,
      sku: item.sku,
      name: item.name,
      declaredQty: Number(item.declared_qty),
      actualQty: Number(actualQty),
    },
    company: {
      id: company.id,
      externalId: company.external_id ?? null,
    },
    occurredAt: occurredAt || new Date().toISOString(),
  };
}

async function appendReceiving(client, args) {
  return append(client, {
    warehouseId: args.warehouseId,
    eventType: EVENT_RECEIVING,
    payload: movementPayload({ ...args, direction: 'in' }),
  });
}

async function appendShipping(client, args) {
  return append(client, {
    warehouseId: args.warehouseId,
    eventType: EVENT_SHIPPING,
    payload: movementPayload({ ...args, direction: 'out' }),
  });
}

// Возврат: товар физически прибавился на складе. Состояние передаём, потому
// что от него зависит, можно ли его снова продавать, — а решает это 1С, где
// брак и годное живут по-разному.
async function appendReturn(client, args) {
  return append(client, {
    warehouseId: args.warehouseId,
    eventType: EVENT_RETURN,
    payload: {
      ...movementPayload({ ...args, direction: 'return' }),
      quality: args.quality,
      defectNote: args.defectNote ?? null,
    },
  });
}

// Сборка набора и пересчёт — движения без документа. Здесь нет ни накладной,
// ни строки: есть только «стало столько-то такого-то товара», и именно это
// 1С и нужно, чтобы её остаток сошёлся с полкой.
function adjustmentPayload({ companyId, lines, occurredAt, reason }) {
  return {
    companyId: companyId || null,
    reason,
    // Плюс — прибавилось, минус — убыло. Одним списком, чтобы 1С провела это
    // одним документом, а не пятью.
    lines: lines.map((l) => ({ sku: l.sku, deltaQty: Number(l.deltaQty) })),
    occurredAt: occurredAt || new Date().toISOString(),
  };
}

async function appendAssembly(client, { warehouseId, companyId, kitSku, qty, components }) {
  return append(client, {
    warehouseId,
    eventType: EVENT_ASSEMBLY,
    payload: adjustmentPayload({
      companyId,
      reason: `Собран набор ${kitSku}`,
      lines: [
        { sku: kitSku, deltaQty: qty },
        ...components.map((c) => ({ sku: c.sku, deltaQty: -c.taken })),
      ],
    }),
  });
}

async function appendInventory(client, { warehouseId, companyId, changes, cellLabel }) {
  return append(client, {
    warehouseId,
    eventType: EVENT_INVENTORY,
    payload: adjustmentPayload({
      companyId,
      reason: `Пересчёт ячейки${cellLabel ? ' ' + cellLabel : ''}`,
      lines: changes.map((c) => ({ sku: c.sku, deltaQty: c.diff })),
    }),
  });
}

// Cursor read. `since` is exclusive, so a client that has processed up to N
// asks for N and gets N+1 onward — the same call repeated returns the same
// rows until they are acknowledged, which is what makes retrying safe.
async function listSince(client, warehouseId, { since = 0, limit = 100 } = {}) {
  const result = await client.query(
    `SELECT id, event_type, payload, created_at, delivered_at
     FROM sync_outbox
     WHERE warehouse_id = $1 AND id > $2
     ORDER BY id
     LIMIT $3`,
    [warehouseId, since, limit],
  );
  return result.rows;
}

// Idempotent by construction: marking "everything up to N" twice is a no-op the
// second time, because already-stamped rows are excluded. 1C may retry an ack
// after a network failure without any special handling.
async function markDelivered(client, warehouseId, upToId) {
  const result = await client.query(
    `UPDATE sync_outbox SET delivered_at = now()
     WHERE warehouse_id = $1 AND id <= $2 AND delivered_at IS NULL
     RETURNING id`,
    [warehouseId, upToId],
  );
  return result.rowCount;
}

async function pendingCount(client, warehouseId) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS n FROM sync_outbox
     WHERE warehouse_id = $1 AND delivered_at IS NULL`,
    [warehouseId],
  );
  return result.rows[0].n;
}

module.exports = {
  appendReturn, appendAssembly, appendInventory,
  EVENT_RECEIVING,
  EVENT_SHIPPING,
  appendReceiving,
  appendShipping,
  listSince,
  markDelivered,
  pendingCount,
};
