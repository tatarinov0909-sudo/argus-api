// Атака 10. Продавец кладёт API одним файлом (POST /api/sellers/inbound, 25.09).
//
// У «Привезти товар» нет предела числа строк на сервере (у загрузки остатков
// он есть — 5000). Каждая строка файла — отдельный запрос в базу, всё в одной
// транзакции, то есть на одном соединении из общего пула. Ключ продавца —
// внешний пользователь. Несколько таких «предпросмотров» разом занимают весь
// пул соединений, и склады других владельцев перестают получать ответы.
const { startApp, warehouse, assert } = require('./attack-helpers');

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const ROWS = Number(process.env.ATK_ROWS || 40000);
const PARALLEL = Number(process.env.ATK_PARALLEL || 12);

(async () => {
  const { api, ok, stop } = await startApp();
  try {
    const w = await warehouse(ok, 'flood');
    const seller = await w.company('Продавец (синтетика)');
    const st = await w.sellerToken(seller);
    const other = await warehouse(ok, 'victim');   // чужой склад, ни при чём

    // Файл: шапка и ROWS строк «штрихкод — 1». Меньше 5 МБ (лимит тела запроса).
    const grid = [['Баркод', 'Количество']];
    for (let i = 0; i < ROWS; i += 1) grid.push([String(4600000000000 + i), 1]);
    console.log('  размер файла:', Math.round(JSON.stringify({ grid }).length / 1024), 'КБ, строк', ROWS);

    const t0 = Date.now();
    const floods = Array.from({ length: PARALLEL }, () => api('POST', '/api/sellers/inbound', st, { grid }));
    // Пока идут «предпросмотры» продавца, владелец другого склада открывает кабинет.
    await new Promise((r) => setTimeout(r, 1500));
    const t1 = Date.now();
    const victim = await api('GET', '/api/warehouses/me', other.token);
    const victimMs = Date.now() - t1;
    const results = await Promise.all(floods);
    console.log('  ответы продавцу:', results.map((r) => r.status).join(','), 'за', Math.round((Date.now() - t0) / 1000), 'с');
    console.log('  владелец чужого склада ждал ответа', victimMs, 'мс, статус', victim.status);
    check('чужой склад отвечает быстрее 2 секунд, пока продавец грузит файлы', () => assert.ok(victimMs < 2000, `${victimMs} мс`));
  } finally { await stop(); }
  console.log(failed ? `\n${failed} FAIL` : '\nвсе проверки прошли');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error('FAIL', e.stack || e.message); process.exitCode = 1; });
