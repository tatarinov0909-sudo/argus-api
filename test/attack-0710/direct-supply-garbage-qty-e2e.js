// Проверка 07.10: поставка физлицу (POST /api/supplies/direct) и мусор на входе.
//
// Остальные входы Аргуса ограничивают количество (привоз продавца — до
// 10 000 000 в строке, перенос в виртуальный склад — до 2 147 483 647,
// загрузка остатков — до 1 000 000). Поставка физлицу берёт любое целое:
// 1 000 000 000 000 000 шт. — и продавец видит это в «В сборке».
// Артикул числом (777 вместо "777") и пустая строка товара роняют сервер
// с «внутренней ошибкой».
//
// Код выхода: 1 — ошибка Аргуса, 2 — сломался тест.
const { startApp, stand, verdicts, fail } = require('../attack-0310/_lib');

(async () => {
  const app = await startApp();
  const v = verdicts('Поставка физлицу: мусор на входе');
  try {
    const s = await stand(app, { skus: [['R-1', 'Резинки чёрные'], ['777', 'Резинки белые']] });
    const huge = await app.api('POST', '/api/supplies/direct', s.owner, { companyId: s.company, destination: 'Иванов',
      items: [{ sku: 'R-1', qty: 1e15 }] });
    const row = (await app.ok('GET', '/api/sellers/stock', s.seller)).rows.find((r) => r.sku === 'R-1');
    v.expect('1 000 000 000 000 000 шт. в одной строке — отказ, как у других входов', huge.status === 400,
      '400 «слишком много»', `${huge.status}, поставка ${huge.body && huge.body.number}; у продавца «В сборке» ${row.inAssembly}`);

    const numeric = await app.api('POST', '/api/supplies/direct', s.owner, { companyId: s.company, destination: 'Петров',
      items: [{ sku: 777, qty: 1 }] });
    v.expect('артикул числом — поставка или понятный отказ, не «внутренняя ошибка»', numeric.status !== 500,
      '201 или 400', `${numeric.status} ${JSON.stringify(numeric.body)}`);
    const empty = await app.api('POST', '/api/supplies/direct', s.owner, { companyId: s.company, destination: 'Петров', items: [null] });
    v.expect('пустая строка товара — понятный отказ, не «внутренняя ошибка»', empty.status === 400,
      '400', `${empty.status} ${JSON.stringify(empty.body)}`);
  } catch (e) { fail(e); } finally { v.done(); await app.stop(); }
})();
