// Находка: повтор окна «Заказ физлицу» с исправленным адресом молча
// возвращает прежний заказ со старым адресом — и экран пишет «Заказ создан».
//
// Номер операции окна (requestId) живёт, пока заказ не создан: ответ не
// дошёл (обрыв связи, долгий ответ) — человек видит ошибку, правит опечатку в
// адресе или получателе и жмёт ещё раз. Сервер сравнивает при повторе только
// товары и склад продавца; другой получатель, адрес, телефон, служба и дата
// не замечаются: ответ 200 «тот же заказ», в базе — старый адрес. Курьер
// поедет по адресу с опечаткой.
//
// Ожидание: при повторе с другими данными получателя — отказ «по этому окну
// уже создан заказ … — обновите экран» (как при других товарах) или
// исправленные данные в заказе.
const crypto = require('node:crypto');
const { startApp, verdicts, fail, setup } = require('./_lib');

(async () => {
  const { ok, api, stop } = await startApp();
  const v = verdicts('Повтор окна заказа физлицу с исправленным адресом');
  try {
    const w = await setup(ok, { skus: ['A-1'] });
    await w.put(w.cells[0], 'A-1', 10);
    const requestId = crypto.randomUUID();
    const body = { companyId: w.companyId, recipient: 'Иванов Иван', address: 'Казань, ул. Баумана, 1', phone: '+7 900 000-00-00',
      deliveryService: 'СДЭК', items: [{ sku: 'A-1', qty: 2 }], requestId };
    const first = await api('POST', '/api/direct-orders', w.token, body);
    // Ответ «не дошёл»; человек исправил адрес и получателя и нажал ещё раз.
    const again = await api('POST', '/api/direct-orders', w.token, { ...body, recipient: 'Иванова Анна', address: 'Казань, ул. Баумана, 11' });
    const saved = (await ok('GET', '/api/direct-orders', w.token)).rows.find((r) => r.id === first.body.id);
    v.expect('первый заказ создан', first.status === 201, '201', String(first.status));
    v.expect('повтор с другим адресом и получателем не отвечает «создан» со старыми данными',
      again.status === 409 || (saved && saved.address === 'Казань, ул. Баумана, 11'),
      '409 «по этому окну уже создан заказ…» или исправленный адрес',
      `${again.status} ${JSON.stringify(again.body)}; в заказе: ${saved && saved.recipient}, ${saved && saved.address}`);

    // То же у «поставки физлицу одним шагом» (POST /api/supplies/direct, 07.10).
    const rid = crypto.randomUUID();
    const sBody = { companyId: w.companyId, destination: 'Петров, Тверь, ул. Советская, 1', items: [{ sku: 'A-1', qty: 1 }], requestId: rid };
    const s1 = await api('POST', '/api/supplies/direct', w.token, sBody);
    const s2 = await api('POST', '/api/supplies/direct', w.token, { ...sBody, destination: 'Петров, Тверь, ул. Советская, 11' });
    const dest = (await w.q('SELECT destination FROM supplies WHERE id = $1', [s1.body.id]))[0];
    v.expect('поставка физлицу: повтор окна с исправленным «куда / кому» не отвечает «создана» со старым адресом',
      s2.status === 409 || (dest && dest.destination.endsWith('11')),
      '409 или исправленный адрес', `${s1.status} → ${s2.status} ${JSON.stringify(s2.body)}; в поставке: ${dest && dest.destination}`);
  } catch (e) { fail(e); } finally { v.done(); await stop(); }
})();
