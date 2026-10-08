// Находка: номер отменённого заказа физлицу выдаётся следующему заказу.
//
// Номер «ЗФ-ДДММГГ-N» считается как «самый большой из существующих + 1»
// (defects/service.js, nextNumber), а отмена удаляет заказ целиком. Отменили
// последний заказ дня — его номер получает следующий, другой заказ другому
// получателю. В журнале под одним номером два разных заказа, а номер уже
// могли назвать покупателю или вписать в накладную службы доставки.
// У поставок это уже решено: «разобранная поставка удаляется, а её номер
// остаётся занятым навсегда — по нему уже напечатан лист» (supplies/service.js).
//
// Ожидание: номер заказа не повторяется.
const { startApp, verdicts, fail, setup, to } = require('./_lib');

(async () => {
  const { ok, stop } = await startApp();
  const v = verdicts('Номер отменённого заказа физлицу');
  try {
    const w = await setup(ok, { skus: ['A-1'] });
    await w.put(w.cells[0], 'A-1', 10);
    const a = await ok('POST', '/api/direct-orders', w.seller, { ...to, items: [{ sku: 'A-1', qty: 1 }] });
    const b = await ok('POST', '/api/direct-orders', w.seller, { ...to, recipient: 'Петров Пётр', items: [{ sku: 'A-1', qty: 1 }] });
    await ok('DELETE', `/api/direct-orders/${b.id}`, w.seller);
    const c = await ok('POST', '/api/direct-orders', w.seller, { ...to, recipient: 'Сидорова Анна', items: [{ sku: 'A-1', qty: 1 }] });
    const journal = (await w.q(`SELECT action_text FROM journal_entries WHERE warehouse_id = $1 AND action_text LIKE $2 ORDER BY created_at`,
      [w.warehouseId, `%«${b.number}»%`])).map((r) => r.action_text);
    v.expect('новый заказ не получает номер отменённого', c.number !== b.number,
      `не ${b.number}`, `${a.number}, ${b.number} (отменён), новый — ${c.number}; журнал: ${JSON.stringify(journal)}`);
  } catch (e) { fail(e); } finally { v.done(); await stop(); }
})();
