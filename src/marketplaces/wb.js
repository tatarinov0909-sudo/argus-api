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
  common: 'https://common-api.wildberries.ru',
  marketplace: 'https://marketplace-api.wildberries.ru',
};

// У WB на каждую категорию свой поддомен и своя квота. Ошибки отдаются json-ом
// с полем detail — его и показываем: «401 Unauthorized» владельцу ничего не
// говорит, «token is expired» говорит всё.
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
    throw new HttpError(502, `Не удалось связаться с Wildberries: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }

  if (!res.ok) {
    const detail = json?.detail || json?.errorText || text.slice(0, 200);
    if (res.status === 401) throw new HttpError(401, `Ключ Wildberries не принят: ${detail}`);
    if (res.status === 403) {
      throw new HttpError(403, `У ключа нет доступа к этому разделу: ${detail}`);
    }
    if (res.status === 429) throw new HttpError(429, 'Wildberries просит сбавить темп');
    throw new HttpError(502, `Wildberries ответил ${res.status}: ${detail}`);
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

module.exports = { sellerInfo, warehouses, newOrders };
