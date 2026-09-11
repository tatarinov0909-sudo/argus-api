const { HttpError } = require('../middleware/errorHandler');

// Wildberries, только чтение.
//
// Здесь СОЗНАТЕЛЬНО нет ни одного метода, который меняет что-либо на площадке:
// ни подтверждения сборочного задания, ни статусов, ни остатков, ни поставок,
// ни карточек. Владелец запретил вносить изменения в кабинет продавца, и
// запрет должен жить в структуре модуля, а не в дисциплине вызывающего: чего
// нет, то нельзя вызвать по ошибке.
//
// Когда запись понадобится — она приедет отдельным модулем и под флагом
// write_enabled, который для этого и заведён.
//
// Площадка пишется прямо, без интерфейсов и фабрик: решено, что общее ядро
// выделяется на ВТОРОЙ площадке, а обобщать, не написав ни одной, значит
// угадывать.

const HOSTS = {
  content: 'https://content-api.wildberries.ru',
  common: 'https://common-api.wildberries.ru',
  marketplace: 'https://marketplace-api.wildberries.ru',
};

// Each category has its own host/quota. Provider error bodies may echo request
// details, so return a useful local error without copying tokens or raw payloads.
async function call(token, host, path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(HOSTS[host] + path, {
      method,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new HttpError(504, 'Wildberries не ответил вовремя');
    throw new HttpError(502, 'Не удалось связаться с Wildberries');
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }

  if (!res.ok) {
    if (res.status === 401) throw new HttpError(401, 'Ключ Wildberries не принят или срок его действия закончился');
    if (res.status === 403) {
      throw new HttpError(403, 'У ключа нет доступа к этому разделу Wildberries');
    }
    if (res.status === 429) throw new HttpError(429, 'Wildberries просит сбавить темп');
    throw new HttpError(502, `Wildberries ответил с ошибкой ${res.status}`);
  }
  return json;
}

// Кто владелец ключа. Первое, что стоит спросить: проверяет и живость ключа, и
// что подключили того продавца, которого собирались.
async function sellerInfo(token) {
  const r = await call(token, 'common', '/api/v1/seller-info');
  return { name: r.name, inn: r.tin, tradeMark: r.tradeMark, sellerId: r.sid };
}

// Склады продавца, зарегистрированные на площадке. Нужны, чтобы понимать, к
// какому из них относятся задания, если складов у продавца несколько.
async function warehouses(token) {
  const r = await call(token, 'marketplace', '/api/v3/warehouses');
  return (r || []).map((w) => ({
    id: w.id, name: w.name, officeId: w.officeId, cargoType: w.cargoType,
  }));
}

// Новые сборочные задания — то, ради чего всё и делается.
//
// Ручка отдаёт задания, которые ещё не в поставке; это ровно «что надо собрать
// прямо сейчас». Постранично она не ходит и лимитов не принимает: у WB это
// снимок текущей очереди целиком.
async function newOrders(token) {
  const r = await call(token, 'marketplace', '/api/v3/orders/new');
  return (r?.orders || []).map(normalizeOrder);
}

function normalizeOrder(o) {
  return {
    externalId: String(o.id),
    article: o.article == null ? null : String(o.article),
    nmId: o.nmId == null ? null : String(o.nmId),
    barcodes: (o.skus || []).map(String),
    // Номер отправления. Это он печатается в упаковочном листе в колонке
    // «№ отправления» и по нему сверяют посылку с наклейкой. Приходит вместе
    // с заказом — проверено живым запросом, никакой поставки для этого
    // создавать не нужно.
    rid: o.rid == null ? null : String(o.rid),
    orderUid: o.orderUid == null ? null : String(o.orderUid),
    // Цена приходит в копейках. Наружу отдаём как есть и подписываем полем —
    // молча делить на сто значит однажды поделить дважды.
    salePriceKopecks: o.salePrice ?? null,
    createdAt: o.createdAt || null,
    warehouseId: o.warehouseId == null ? null : String(o.warehouseId),
    deliveryType: o.deliveryType || null,
    // Требования площадки к позиции: маркировка «Честного ЗНАКа» и прочее.
    // Не используем, но сохраняем: по ним видно, какие товары мы физически не
    // сможем отгрузить, когда дело дойдёт до записи.
    requiredMeta: o.requiredMeta || [],
  };
}

// POST is the read-only catalog listing method, not a card mutation.
async function productCards(token, cursor = {}) {
  return call(token, 'content', '/content/v2/get/cards/list', {
    method: 'POST', body: { settings: { sort: { ascending: true },
      cursor: { ...cursor, limit: 100 }, filter: { withPhoto: -1 } } },
  });
}

// POST reads statuses; it does not confirm/cancel an order on WB.
// https://dev.wildberries.ru/en/openapi/orders-fbs — Get Assembly Orders Statuses.
async function orderStatuses(token, orderIds) {
  if (!Array.isArray(orderIds) || orderIds.length < 1 || orderIds.length > 1000
      || orderIds.some(id => !/^\d+$/.test(String(id))
        || !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
    throw new HttpError(400, 'Для проверки WB нужны от 1 до 1000 корректных номеров заказов');
  }
  const r = await call(token, 'marketplace', '/api/v3/orders/status', {
    method: 'POST', body: { orders: orderIds.map(Number) },
  });
  if (!r || !Array.isArray(r.orders)) {
    throw new HttpError(502, 'Wildberries не передал список статусов заказов');
  }
  return r.orders;
}
module.exports = { sellerInfo, warehouses, newOrders, productCards, orderStatuses };
