const wbWrite = require('../marketplaces/wbWrite');
const credentials = require('../marketplaces/credentials');
const journal = require('../journal/repository');
const { plural } = require('../journal/plural');

// Передача поставки на Wildberries и обратно.
//
// Смысл всей затеи: пока Аргус только читал, поставку на стороне WB делали
// руками в её кабинете. Без этой поставки собранный товар не примут на
// воротах, а один и тот же заказ мог попасть и в поставку WB, и в поставку
// Аргуса — и его собирали дважды.
//
// Порядок такой и другим быть не может:
//   1) местная поставка уже создана и записана в базу;
//   2) обращения к площадке идут БЕЗ открытой транзакции — соединение с базой
//      не должно ждать чужую сеть (см. db/pool.js);
//   3) результат записывается отдельной короткой транзакцией.
//
// Запись включает владелец флагом `write_enabled` у ключа продавца. Пока он
// выключен, здесь ничего не происходит вовсе: `skipped: 'write_disabled'`.

// Пауза между запросами к WB: его лимит — не чаще раза в 200 мс.
const PACE_MS = 250;
const pause = (ms) => (ms > 0 ? new Promise((resolve) => { setTimeout(resolve, ms); }) : Promise.resolve());

// Заказ, который площадка не приняла в поставку, из местной поставки убираем.
// Иначе склад собирал бы то, что на WB в этой поставке не значится.
async function detachRejected(client, warehouseId, supply, rejected) {
  for (const row of rejected) {
    await client.query(
      'UPDATE invoices SET supply_id = NULL WHERE warehouse_id = $1 AND id = $2',
      [warehouseId, row.invoiceId],
    );
    await journal.createEntry(client, {
      warehouseId,
      agent: 'Обмен с WB',
      actorType: 'system',
      entityType: 'invoice',
      entityId: row.invoiceId,
      invoiceId: row.invoiceId,
      status: 'pending',
      actionText: `Заказ «${row.number}» не принят в поставку WB: ${row.error}.`
        + ` Убран из поставки «${supply.number}» — собирать его по этой поставке нельзя.`,
    });
  }
}

// Создать поставку на площадке и подтвердить в ней заказы.
//
// `api` и `withTx` подменяются в тестах: сети и базы в проверках нет.
async function handOver({
  warehouseId, companyId, supply, orders, withTx, api = wbWrite, tokenFor = credentials.writeTokenFor,
}) {
  const token = await withTx((client) => tokenFor(client, warehouseId, companyId, 'wb'));
  if (!token) return { skipped: 'write_disabled' };

  const mpSupplyId = await api.createSupply(token, supply.number);
  let confirmed = [];
  let rejected = [];
  // WB пускает не чаще раза в 200 мс, всплеском до 20 запросов, а каждая
  // ошибка 4xx считается за десять. Поэтому не прошедшую пачку не разбираем
  // по одному заказу (90 запросов подряд — и WB начнёт отказывать уже по
  // частоте, а мы выкинем из поставки исправные заказы), а делим пополам,
  // пока не останется виноватый: на один плохой заказ из ста — около дюжины
  // запросов. «Слишком часто» (429) — подождать и повторить.
  const add = async (ids) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await api.addOrders(token, mpSupplyId, ids);
      } catch (err) {
        if (err.status !== 429 || attempt >= 3) throw err;
        await pause(1000 * (attempt + 1));
      }
    }
  };
  const place = async (part) => {
    try {
      await add(part.map((o) => o.externalId));
      confirmed.push(...part);
    } catch (err) {
      if (part.length === 1) { rejected.push({ ...part[0], error: err.message }); return; }
      const half = Math.ceil(part.length / 2);
      await pause(PACE_MS);
      await place(part.slice(0, half));
      await pause(PACE_MS);
      await place(part.slice(half));
    }
  };
  for (let i = 0; i < orders.length; i += 100) {
    if (i > 0) await pause(PACE_MS);
    await place(orders.slice(i, i + 100));
  }
  // Если что-то не прошло, решает не наш подсчёт, а состав поставки на WB:
  // пачка могла закрепиться частично.
  if (rejected.length > 0) {
    try {
      const onWb = new Set(await api.supplyOrderIds(token, mpSupplyId));
      const all = [...confirmed, ...rejected];
      confirmed = all.filter((o) => onWb.has(String(o.externalId)));
      rejected = all.filter((o) => !onWb.has(String(o.externalId)))
        .map((o) => ({ ...o, error: o.error || 'не закреплён за поставкой на WB' }));
    } catch { /* нет ответа — остаётся наш подсчёт */ }
  }

  // Ни одного заказа площадка не приняла — поставке на её стороне взяться
  // неоткуда, и пустую мы убираем за собой.
  if (confirmed.length === 0) {
    try { await api.deleteSupply(token, mpSupplyId); } catch { /* пустая поставка не помеха */ }
    await withTx(async (client) => {
      await detachRejected(client, warehouseId, supply, rejected);
    });
    return { mpSupplyId: null, confirmed: [], rejected };
  }

  // Этикетки заказов печатают сразу. QR поставки WB отдаёт только после
  // передачи в доставку — его забираем в deliver().
  let stickers = [];
  try {
    stickers = await api.orderStickers(token, confirmed.map((o) => o.externalId));
  } catch { stickers = []; }

  await withTx(async (client) => {
    await client.query(
      `UPDATE supplies SET mp_supply_id = $3, mp_handed_at = now()
        WHERE warehouse_id = $1 AND id = $2`,
      [warehouseId, supply.id, mpSupplyId],
    );
    await client.query(
      `UPDATE invoices SET mp_confirmed_at = now(), mp_supplier_status = 'confirm'
        WHERE warehouse_id = $1 AND id = ANY($2::uuid[])`,
      [warehouseId, confirmed.map((o) => o.invoiceId)],
    );
    for (const sticker of stickers) {
      const order = confirmed.find((o) => String(o.externalId) === String(sticker.orderId));
      if (!order) continue;
      await client.query(
        `INSERT INTO marketplace_order_stickers
           (invoice_id, warehouse_id, company_id, part_a, part_b, barcode, file, kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'svg')
         ON CONFLICT (invoice_id) DO UPDATE SET part_a = EXCLUDED.part_a,
           part_b = EXCLUDED.part_b, barcode = EXCLUDED.barcode, file = EXCLUDED.file,
           created_at = now()`,
        [order.invoiceId, warehouseId, companyId, sticker.partA, sticker.partB,
          sticker.barcode, sticker.file],
      );
    }
    await detachRejected(client, warehouseId, supply, rejected);
    await journal.createEntry(client, {
      warehouseId,
      agent: 'Обмен с WB',
      actorType: 'system',
      entityType: 'supply',
      entityId: supply.id,
      status: 'auto',
      actionText: `Поставка «${supply.number}» создана на WB (${mpSupplyId}): `
        + `${confirmed.length} ${plural(confirmed.length, 'заказ', 'заказа', 'заказов')} на сборке`
        + `${rejected.length ? `, не принято ${rejected.length}` : ''}`
        + `${stickers.length ? `, этикеток ${stickers.length}` : ', этикетки не получены'}.`,
    });
  });

  return { mpSupplyId, confirmed, rejected, stickers: stickers.length };
}

// Передать поставку в доставку: для площадки это «уехало».
async function deliver({
  warehouseId, companyId, supply, withTx, api = wbWrite, tokenFor = credentials.writeTokenFor,
}) {
  if (!supply.mp_supply_id) return { skipped: 'no_mp_supply' };
  const token = await withTx((client) => tokenFor(client, warehouseId, companyId, 'wb'));
  if (!token) return { skipped: 'write_disabled' };

  try {
    await api.deliverSupply(token, supply.mp_supply_id);
  } catch (err) {
    // Машина уже ушла — местную отгрузку отменять нельзя. Говорим человеку,
    // что на площадке поставка осталась несданной, и оставляем след.
    await withTx((client) => journal.createEntry(client, {
      warehouseId,
      agent: 'Обмен с WB',
      actorType: 'system',
      entityType: 'supply',
      entityId: supply.id,
      status: 'pending',
      actionText: `Поставку «${supply.number}» не удалось передать в доставку на WB: `
        + `${err.message}. Сделайте это в кабинете WB или повторите из Аргуса.`,
    }));
    return { error: err.message };
  }

  // QR поставки для ворот: теперь WB его отдаёт. Нет ответа — не беда,
  // поставка уже сдана, QR можно взять в кабинете WB.
  let barcode = null;
  try { barcode = await api.supplyBarcode(token, supply.mp_supply_id); } catch { barcode = null; }

  await withTx(async (client) => {
    await client.query(
      `UPDATE supplies SET mp_delivered_at = now(),
              mp_barcode = COALESCE($3, mp_barcode), mp_barcode_file = COALESCE($4, mp_barcode_file)
        WHERE warehouse_id = $1 AND id = $2`,
      [warehouseId, supply.id, barcode?.barcode || null, barcode?.file || null],
    );
    await journal.createEntry(client, {
      warehouseId,
      agent: 'Обмен с WB',
      actorType: 'system',
      entityType: 'supply',
      entityId: supply.id,
      status: 'auto',
      actionText: `Поставка «${supply.number}» передана в доставку на WB (${supply.mp_supply_id}).`,
    });
  });
  return { delivered: true };
}

module.exports = { handOver, deliver };
