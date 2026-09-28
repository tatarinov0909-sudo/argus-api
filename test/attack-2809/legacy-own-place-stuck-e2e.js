// Атака: старые приёмки «на своё место» (без ячейки, до 28.09) после
// выкладки 28.09.
//
// Требование: задание 28.09, ответ А — «всё принятое — только в конкретную
// ячейку»; ответ Б — переделать раскладку после закрытия прихода — «через
// «Перепаковка и перестановка»». Хендофф 28.09 про старые данные говорит только
// о незакрытых приходах.
//
// Старые данные готовятся напрямую в базе — так выглядела приёмка без ячейки
// до 28.09 (receiving_records.cell_block_id NULL, укладок нет, в cell_stock
// ничего): нынешний API такую запись создать не даёт.
const { startApp, setup, verdicts, admin } = require('./_lib');

async function legacyReceive(s, item, qty, workerToken) {
  const staffKeyId = JSON.parse(Buffer.from(workerToken.split('.')[1], 'base64url')).staffKeyId;
  await admin(`INSERT INTO receiving_records (invoice_item_id, warehouse_id, company_id, accepted_qty, cell_block_id,
                                              worker_key_id, finished_at)
               VALUES ($1, $2, $3, $4, NULL, $5, now() - interval '2 days')`,
  [item, s.warehouseId, s.company, qty, staffKeyId]);
}

(async () => {
  const { api, ok, stop } = await startApp();
  const v = verdicts('Старое «своё место»');
  try {
    const s = await setup(ok, { skus: [['A-1', 'Зефир'], ['A-2', 'Пастила']] });
    const w = s.staff['Джоник'];

    // Незакрытый приход со «своим местом» — разложить можно (так и обещано).
    const open = await s.invoice('ПР-АТК-СТАР-1', [['A-1', 'Зефир', 30], ['A-2', 'Пастила', 5]]);
    await legacyReceive(s, open.items[0].id, 30, w);
    // Незакрытый приход раскладывают внутри приёмки — после «Начать»
    // (находка 1: без захода сервер теперь отказывает). Правка 28.09 при починке.
    await ok('POST', `/api/receiving/session/${open.id}/start`, w, {}, 201);
    const placeOpen = await api('POST', `/api/receiving/items/${open.items[0].id}/place`, w, { cellBlockId: s.cell(1), qty: 30 });
    v.expect('незакрытый приход: старое «своё место» раскладывается шагом «положить»',
      placeOpen.status === 201, '201', `${placeOpen.status} ${JSON.stringify(placeOpen.body).slice(0, 100)}`);

    // Приход, принятый до 28.09 целиком, где часть легла «на своё место».
    const closed = await s.invoice('ПР-АТК-СТАР-2', [['A-1', 'Зефир', 40]]);
    await legacyReceive(s, closed.items[0].id, 40, w);
    await admin('UPDATE invoices SET status = \'completed\' WHERE id = $1', [closed.id]);

    const seller = await s.sellerToken(s.company);
    const docs = await ok('GET', '/api/sellers/documents', seller);
    const doc = (docs.rows || []).find((d) => d.number === 'ПР-АТК-СТАР-2');
    const place = await api('POST', `/api/receiving/items/${closed.items[0].id}/place`, w, { cellBlockId: s.cell(2), qty: 40 });
    const viaMove = [];
    for (const n of [1, 2, 3, 4]) {
      const r = await api('POST', '/api/cells/move', w, { sku: 'A-1', companyId: s.company, fromCellBlockId: s.cell(n), toCellBlockId: s.cell(n === 4 ? 3 : 4), qty: 40 });
      viaMove.push(`${n}: ${r.status}`);
    }
    const stock = await admin('SELECT COALESCE(SUM(qty), 0) AS n FROM cell_stock WHERE warehouse_id = $1 AND sku = \'A-1\'', [s.warehouseId]);
    v.expect('принятый приход: 40 шт. «своего места» можно положить в ячейку (раскладкой или перестановкой)',
      place.status === 201 || viaMove.some((x) => x.endsWith('201')),
      'хотя бы один путь — «всё принятое — в конкретную ячейку» (ответ А), после закрытия — перестановка (ответ Б)',
      `продавец видит «не размещено» ${doc ? doc.unplaced_qty : '?'} шт.; /place — ${place.status} «${place.body && place.body.error}»; `
        + `перестановка из каждой ячейки — ${viaMove.join(', ')} (в ячейках Аргуса этого товара ${Number(stock[0].n)} шт. — только 30 из первого прихода)`);
  } finally {
    v.done();
    await stop();
  }
})().catch((err) => { console.error('ОШИБКА ТЕСТА', err); process.exitCode = 2; });
