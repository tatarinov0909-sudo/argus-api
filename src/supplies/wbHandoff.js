const wbWrite = require('../marketplaces/wbWrite');
const credentials = require('../marketplaces/credentials');
const journal = require('../journal/repository');
const { plural } = require('../journal/plural');
const { moscowToday } = require('./service');

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
  // «Заказ не подходит» и «площадка недоступна» — разные вещи. Пока всё
  // подряд считалось отказом по заказу, один обрыв связи выкидывал из местной
  // поставки ВСЕ заказы и заводил на каждый задачу в журнале. Содержательным
  // считаем только ответ самой площадки про содержимое пачки (400/409).
  // Содержательный отказ: так ответила площадка про содержимое пачки, либо
  // наша же проверка не пустила кривой номер заказа (HttpError 400 из
  // wbWrite). Всё остальное — «площадка недоступна», и состав поставки при
  // этом трогать нельзя.
  const aboutOrders = (err) => [400, 409, 422].includes(err.marketplaceStatus)
    || (!err.marketplaceStatus && err.status === 400);
  const place = async (part) => {
    try {
      await add(part.map((o) => o.externalId));
      confirmed.push(...part);
    } catch (err) {
      if (!aboutOrders(err)) throw err;
      if (part.length === 1) { rejected.push({ ...part[0], error: err.message }); return; }
      const half = Math.ceil(part.length / 2);
      await pause(PACE_MS);
      await place(part.slice(0, half));
      await pause(PACE_MS);
      await place(part.slice(half));
    }
  };
  try {
    for (let i = 0; i < orders.length; i += 100) {
      if (i > 0) await pause(PACE_MS);
      await place(orders.slice(i, i + 100));
    }
  } catch (err) {
    // Площадка недоступна. Состав местной поставки не трогаем — товар уже
    // расписан по листам, и разбирать её из-за обрыва связи нельзя. Номер
    // созданной поставки WB запоминаем, иначе она останется сиротой.
    await withTx(async (client) => {
      await client.query(
        `UPDATE supplies SET mp_supply_id = COALESCE(mp_supply_id, $3)
          WHERE warehouse_id = $1 AND id = $2`,
        [warehouseId, supply.id, mpSupplyId],
      );
      await journal.createEntry(client, {
        warehouseId,
        agent: 'Обмен с WB',
        actorType: 'system',
        entityType: 'supply',
        entityId: supply.id,
        status: 'pending',
        actionText: `Поставка «${supply.number}»: WB не ответил (${err.message}).`
          + ` Поставка на площадке ${mpSupplyId} создана, но заказы в неё добавлены не все.`
          + ' Состав поставки в Аргусе не меняли — повторите передачу или доделайте в кабинете WB.',
      });
    });
    return { mpSupplyId, confirmed: [], rejected: [], error: err.message };
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

  // Пункт и плановую дату отгрузки — сразу: WB покажет их в кабинете, а
  // отказ (прошедшая дата, пункт не тот) узнаем сейчас, а не у ворот.
  let shippingError = null;
  if (supply.mp_shipping_point_id && supply.ship_date) {
    try {
      await api.setShipping(token, mpSupplyId, { pointId: supply.mp_shipping_point_id, date: supply.ship_date });
    } catch (err) { shippingError = err.message; }
  } else {
    const missing = [!supply.mp_shipping_point_id && 'пункт', !supply.ship_date && 'дата'].filter(Boolean);
    shippingError = `не ${missing.length > 1 ? 'выбраны' : 'выбран' + (missing[0] === 'дата' ? 'а' : '')} `
      + `${missing.join(' и ')} отгрузки`;
  }

  // Этикетки заказов печатают сразу. QR поставки WB отдаёт только после
  // передачи в доставку — его забираем в deliver().
  //
  // Пачками по сотне, как и добавление заказов: WB больше ста за раз не
  // отдаёт, и поставка из полутора сотен заказов оставалась вообще без
  // этикеток. Неудача одной пачки теперь не обнуляет остальные.
  const stickers = [];
  for (let i = 0; i < confirmed.length; i += 100) {
    if (i > 0) await pause(PACE_MS);
    const part = confirmed.slice(i, i + 100).map((o) => o.externalId);
    try {
      stickers.push(...await api.orderStickers(token, part));
    } catch { /* этикетки этой пачки возьмём позже, из кабинета WB */ }
  }

  await withTx(async (client) => {
    await client.query(
      `UPDATE supplies SET mp_supply_id = $3, mp_handed_at = now(),
              mp_shipping_set_at = CASE WHEN $4 THEN now() END
        WHERE warehouse_id = $1 AND id = $2`,
      [warehouseId, supply.id, mpSupplyId, !shippingError],
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
    if (shippingError) {
      await journal.createEntry(client, {
        warehouseId,
        agent: 'Обмен с WB',
        actorType: 'system',
        entityType: 'supply',
        entityId: supply.id,
        status: 'pending',
        actionText: `Поставке «${supply.number}» на WB не заданы параметры отгрузки: ${shippingError}.`
          + ' Без них WB не примет её в доставку — задайте пункт и дату в кабинете WB.',
      });
    }
  });

  return {
    mpSupplyId, confirmed, rejected, stickers: stickers.length, shippingError,
  };
}

// Передать поставку в доставку: для площадки это «уехало».
async function deliver({
  warehouseId, companyId, supply, withTx, api = wbWrite, tokenFor = credentials.writeTokenFor,
}) {
  if (!supply.mp_supply_id) return { skipped: 'no_mp_supply' };

  // Машина уже ушла — местную отгрузку отменять нельзя. Говорим человеку,
  // что на площадке поставка осталась несданной, и оставляем след.
  const complain = async (reason) => {
    await withTx((client) => journal.createEntry(client, {
      warehouseId,
      agent: 'Обмен с WB',
      actorType: 'system',
      entityType: 'supply',
      entityId: supply.id,
      status: 'pending',
      actionText: `Поставку «${supply.number}» не удалось передать в доставку на WB: `
        + `${reason}. Сделайте это в кабинете WB или повторите из Аргуса.`,
    }));
    return { error: reason };
  };

  // Ключ читаем здесь же: раньше его ошибка (сменился MARKETPLACE_KEY_SECRET,
  // ключ удалили) улетала мимо журнала — поставка уезжала, на WB оставалась
  // «на сборке», и следа не было нигде.
  let token;
  try {
    token = await withTx((client) => tokenFor(client, warehouseId, companyId, 'wb'));
  } catch (err) {
    return complain(err.message);
  }
  if (!token) return { skipped: 'write_disabled' };

  // Дата — сегодняшняя: машина уехала сейчас, что бы ни планировали.
  //
  // Пункта у поставки может не быть вовсе — например, она составлена до того,
  // как в Аргусе появился выбор пункта, или список пунктов не загрузился, а
  // менеджер задал их руками в кабинете WB. Тогда просто не трогаем параметры
  // и всё равно пробуем сдать: отказать должна площадка и назвать причину,
  // а не мы — молча.
  if (supply.mp_shipping_point_id) {
    try {
      await api.setShipping(token, supply.mp_supply_id, { pointId: supply.mp_shipping_point_id, date: moscowToday() });
    } catch (err) {
      if (!supply.mp_shipping_set_at) return complain(err.message);
      // Параметры на площадке остались прежними: дата там будет плановая, а
      // не сегодняшняя. Это не повод не сдавать поставку, но человек должен
      // знать — на воротах сверяют именно её.
      await withTx((client) => journal.createEntry(client, {
        warehouseId,
        agent: 'Обмен с WB',
        actorType: 'system',
        entityType: 'supply',
        entityId: supply.id,
        status: 'pending',
        actionText: `Поставка «${supply.number}»: дату отгрузки на WB сменить не удалось (${err.message}).`
          + ' На площадке осталась прежняя дата — проверьте её в кабинете WB.',
      }));
    }
  }

  try {
    await api.deliverSupply(token, supply.mp_supply_id);
  } catch (err) {
    return complain(err.message);
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
