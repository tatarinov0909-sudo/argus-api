const { call } = require('./wb');
const { HttpError } = require('../middleware/errorHandler');

// Запись в Wildberries: поставка площадки, подтверждение заказов, этикетки,
// QR поставки и передача в доставку.
//
// Зачем это вообще: без поставки на стороне WB собранный товар не примут на
// воротах сортировочного центра. Пока Аргус только читал, поставку руками
// делали в кабинете WB — и один и тот же заказ мог попасть в две сборки.
//
// Каждый метод здесь МЕНЯЕТ данные в кабинете продавца. Поэтому:
//   * модуль отдельный от чтения (`wb.js`), чтобы читающий код физически не
//     мог ничего изменить;
//   * вызывается только через `writeClientFor` в credentials: он не отдаёт
//     клиента, пока владелец не включил запись флагом `write_enabled`;
//   * идентификаторы заказов проверяются здесь же — в адрес запроса уходит
//     только число.
//
// Документация: https://dev.wildberries.ru/openapi/orders-fbs

const orderId = (value) => {
  const id = String(value);
  if (!/^[0-9]{1,15}$/.test(id) || Number(id) <= 0 || !Number.isSafeInteger(Number(id))) {
    throw new HttpError(400, `Некорректный номер заказа WB: ${id.slice(0, 20)}`);
  }
  return Number(id);
};

const supplyId = (value) => {
  const id = String(value || '');
  // Идентификатор поставки WB выглядит как «WB-GI-1234567».
  if (!/^[A-Za-z0-9-]{1,40}$/.test(id)) {
    throw new HttpError(400, `Некорректный номер поставки WB: ${id.slice(0, 20)}`);
  }
  return id;
};

// Новая поставка на стороне WB. Имя видно продавцу в его кабинете — пишем
// туда номер нашей поставки, чтобы две системы можно было сверить глазами.
async function createSupply(token, name) {
  const r = await call(token, 'marketplace', '/api/v3/supplies', {
    method: 'POST', body: { name: String(name || 'Аргус').slice(0, 128) },
  });
  if (!r || !r.id) throw new HttpError(502, 'Wildberries не вернул номер созданной поставки');
  return String(r.id);
}

// Заказы в поставку — пачкой до 100. Для WB это и есть «на сборке»: заказы
// уходят из очереди новых и получают статус confirm.
//
// Сверено с документацией WB 19.09.2026: прежний метод по одному заказу
// (/api/v3/supplies/{id}/orders/{orderId}) из неё убран, остался пакетный.
async function addOrders(token, supply, orders) {
  const ids = (Array.isArray(orders) ? orders : []).map(orderId);
  if (ids.length < 1 || ids.length > 100) {
    throw new HttpError(400, 'В поставку WB добавляется от 1 до 100 заказов за раз');
  }
  await call(token, 'marketplace', `/api/marketplace/v3/supplies/${supplyId(supply)}/orders`,
    { method: 'PATCH', body: { orders: ids } });
  return true;
}

// Какие заказы действительно закреплены за поставкой на стороне WB. После
// неудачной пачки это единственный честный ответ, что прошло, а что нет.
async function supplyOrderIds(token, supply) {
  const r = await call(token, 'marketplace', `/api/marketplace/v3/supplies/${supplyId(supply)}/order-ids`);
  if (!r || !Array.isArray(r.orderIds)) throw new HttpError(502, 'Wildberries не вернул состав поставки');
  return r.orderIds.map(String);
}

// Передать поставку в доставку: статус заказов становится complete, и с этого
// момента поставку можно сдавать. Делается в момент отгрузки, когда машина
// уже загружена.
async function deliverSupply(token, supply) {
  await call(token, 'marketplace', `/api/v3/supplies/${supplyId(supply)}/deliver`, { method: 'PATCH' });
  return true;
}

// QR поставки — его показывают на воротах. Отдаём как есть: base64-картинку
// и текст штрихкода, чтобы лист можно было напечатать и без картинки.
// WB выдаёт его только после передачи поставки в доставку.
async function supplyBarcode(token, supply, type = 'svg') {
  if (type !== 'svg' && type !== 'png') throw new HttpError(400, 'Тип QR поставки: svg или png');
  const r = await call(token, 'marketplace',
    `/api/v3/supplies/${supplyId(supply)}/barcode?type=${type}`);
  if (!r || !r.barcode) throw new HttpError(502, 'Wildberries не вернул QR поставки');
  return { barcode: String(r.barcode), file: r.file ? String(r.file) : null, type };
}

// Этикетки заказов. Их клеят на посылки, без них заказ не принимают.
// WB отдаёт их пачкой на список заказов — не больше сотни за раз.
async function orderStickers(token, orders, { type = 'svg', width = 58, height = 40 } = {}) {
  const ids = (Array.isArray(orders) ? orders : []).map(orderId);
  if (ids.length < 1 || ids.length > 100) {
    throw new HttpError(400, 'Этикетки запрашиваются на 1–100 заказов за раз');
  }
  if (!['svg', 'png', 'zplv', 'zplh'].includes(type)) throw new HttpError(400, 'Неизвестный тип этикетки');
  const r = await call(token, 'marketplace',
    `/api/v3/orders/stickers?type=${type}&width=${Number(width)}&height=${Number(height)}`,
    { method: 'POST', body: { orders: ids } });
  if (!r || !Array.isArray(r.stickers)) throw new HttpError(502, 'Wildberries не вернул этикетки заказов');
  return r.stickers.map((s) => ({
    orderId: String(s.orderId),
    partA: s.partA == null ? null : String(s.partA),
    partB: s.partB == null ? null : String(s.partB),
    barcode: s.barcode == null ? null : String(s.barcode),
    file: s.file == null ? null : String(s.file),
  }));
}

// Пустую поставку можно удалить — этим откатывается неудачная попытка,
// когда WB не принял ни одного заказа.
async function deleteSupply(token, supply) {
  await call(token, 'marketplace', `/api/v3/supplies/${supplyId(supply)}`, { method: 'DELETE' });
  return true;
}

module.exports = {
  createSupply, addOrders, supplyOrderIds, deliverSupply, supplyBarcode, orderStickers, deleteSupply,
};
