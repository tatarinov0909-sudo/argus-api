const { withTenantContext, withoutTenantContext } = require('../db/pool');
const { collect } = require('./rules');
const { workQueue, vwReminders } = require('../agents/kladovshchik');
const { plural } = require('../journal/plural');
const { zoneOf, todayIn, hourIn } = require('../warehouses/time');

// Проход сторожа по одному складу.
//
// Три действия за раз, и все три обязательны:
//   1. открыть тревоги, которых ещё не было;
//   2. закрыть те, чья причина исчезла сама (разобрали возврат, подтвердили
//      расхождение) — иначе список превратится в кладбище;
//   3. отметить, что проход состоялся: молчание сторожа и молчание склада
//      снаружи выглядят одинаково, и различить их можно только по отметке.
async function checkWarehouse(client, warehouseId) {
  const found = await collect(client, warehouseId);
  const foundKeys = found.map((f) => f.key);

  const openRows = await client.query(
    `SELECT alert_key FROM alerts WHERE warehouse_id = $1 AND resolved_at IS NULL`,
    [warehouseId],
  );
  const openKeys = new Set(openRows.rows.map((r) => r.alert_key));

  let opened = 0;
  for (const f of found) {
    if (openKeys.has(f.key)) continue;
    // Гонки здесь безвредны, но уникальный индекс всё равно один на пару
    // «склад + ключ»: два одновременных прохода не создадут дубль.
    await client.query(
      `INSERT INTO alerts (warehouse_id, alert_key, text) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [warehouseId, f.key, f.text],
    );
    opened += 1;
  }

  let resolved = 0;
  if (openKeys.size > 0) {
    const gone = [...openKeys].filter((k) => !foundKeys.includes(k) && !k.startsWith('digest:'));
    if (gone.length > 0) {
      const res = await client.query(
        `UPDATE alerts SET resolved_at = now()
         WHERE warehouse_id = $1 AND resolved_at IS NULL AND alert_key = ANY($2::text[])`,
        [warehouseId, gone],
      );
      resolved = res.rowCount;
    }
  }

  await client.query(
    `INSERT INTO alert_runs (warehouse_id, last_run_at) VALUES ($1, now())
     ON CONFLICT (warehouse_id) DO UPDATE SET last_run_at = now()`,
    [warehouseId],
  );

  return { opened, resolved, open: found.length };
}

// Утренняя сводка — одно сообщение в день перед сменой, и только если есть о
// чём. «Всё хорошо» не пишем: молчание и должно означать, что всё хорошо.
//
// В 7 утра по поясу склада (анкета склада, 30.09.2026).
const DIGEST_HOUR = 7;

async function maybeDigest(client, warehouseId) {
  const zone = await zoneOf(client, warehouseId);
  if (hourIn(zone) < DIGEST_HOUR) return null;
  const today = todayIn(zone);

  // Дату читаем строкой, а не через JS-Date. Колонка типа DATE приезжает в
  // node-postgres как полночь ПО МЕСТНОМУ времени, и toISOString() сдвигает её
  // на день назад для любой зоны восточнее Гринвича: сводка, записанная
  // сегодня, читалась как вчерашняя, и «Доброе утро» уходило бы владельцу
  // каждые десять минут. Ровно тот спам, против которого всё и строилось.
  const run = await client.query(
    `SELECT to_char(last_digest_on, 'YYYY-MM-DD') AS last_digest_on
     FROM alert_runs WHERE warehouse_id = $1`,
    [warehouseId],
  );
  const last = run.rows[0]?.last_digest_on;
  if (last && last >= today) return null;

  const openRows = await client.query(
    `SELECT text FROM alerts WHERE warehouse_id = $1 AND resolved_at IS NULL
       AND alert_key NOT LIKE 'digest:%'
     ORDER BY created_at`,
    [warehouseId],
  );

  // Работа дня — как её видит грузчик (разбор 02.10.2026): «1202 на сборку»
  // считало все заказы WB, а «46 на приёмку» — заказы поставщику из 1С.
  const w = await workQueue(client, warehouseId);
  const parts = [];
  if (w.suppliesToPick) {
    parts.push(`${w.suppliesToPick} ${plural(w.suppliesToPick, 'поставка', 'поставки', 'поставок')} на сборку `
      + `(${w.ordersToPick} ${plural(w.ordersToPick, 'заказ', 'заказа', 'заказов')})`);
  }
  if (w.onecToPick) parts.push(`${w.onecToPick} ${plural(w.onecToPick, 'отгрузка', 'отгрузки', 'отгрузок')} из 1С`);
  if (w.suppliesReady) parts.push(`${w.suppliesReady} ${plural(w.suppliesReady, 'собранная поставка ждёт', 'собранные поставки ждут', 'собранных поставок ждут')} отгрузки`);
  if (w.toReceive) {
    parts.push(`${w.toReceive} ${plural(w.toReceive, 'привоз', 'привоза', 'привозов')} на приёмку`
      + (w.arrived ? ` (${w.arrived} уже ${plural(w.arrived, 'приехал', 'приехали', 'приехали')})` : ''));
  }
  if (w.returnsToSort) parts.push(`${w.returnsToSort} ${plural(w.returnsToSort, 'возврат', 'возврата', 'возвратов')} на разбор`);
  if (w.defectTasks) parts.push(`${w.defectTasks} ${plural(w.defectTasks, 'задание', 'задания', 'заданий')} склада брака`);
  // Склады продавцов (владелец 02.10.2026) — если напоминания не выключены.
  const vw = await vwReminders(client, warehouseId);
  if (vw) {
    if (vw.sellerRequests.length) parts.push(`${vw.sellerRequests.length} ${plural(vw.sellerRequests.length, 'заявка', 'заявки', 'заявок')} продавцов на перенос ждут вас`);
    if (vw.waitingSellerConsent + vw.waitingSellerDecision) {
      const k = vw.waitingSellerConsent + vw.waitingSellerDecision;
      parts.push(`${k} ${plural(k, 'перенос или решение ждёт', 'переноса или решения ждут', 'переносов или решений ждут')} продавцов`);
    }
    if (vw.moveTasks) parts.push(`${vw.moveTasks} ${plural(vw.moveTasks, 'задание', 'задания', 'заданий')} «переложить» не сделано`);
    for (const z of vw.fullZones) {
      parts.push(`зона склада «${z.warehouse}» продавца «${z.seller}» заполнена${z.incoming ? ` — едет ${z.incoming} шт.` : ''}`);
    }
  }

  // Ни работы, ни открытых тревог — писать не о чем. И день при этом НЕ
  // помечаем сделанным: проверки идут каждые десять минут круглосуточно, и
  // первая же из них после семи утра застаёт склад спокойным. Если бы она
  // сжигала день, сводка не приходила бы никогда — проблемы появляются к
  // девяти, а «на сегодня уже отчитались» стояло бы с рассвета.
  if (parts.length === 0 && openRows.rows.length === 0) return null;

  const lines = [];
  lines.push(parts.length > 0 ? `Доброе утро. Сегодня: ${parts.join(', ')}.` : 'Доброе утро. Новой работы на сегодня нет.');
  for (const row of openRows.rows) lines.push(`• ${row.text}`);

  await client.query(
    `INSERT INTO alerts (warehouse_id, alert_key, text) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [warehouseId, `digest:${today}`, lines.join('\n')],
  );
  await client.query(
    `UPDATE alert_runs SET last_digest_on = $2::date WHERE warehouse_id = $1`,
    [warehouseId, today],
  );
  return today;
}

// Один проход по всем складам. Список складов читается без тенант-контекста
// (это единственное место, которому нужно видеть их все), а сама проверка
// каждого — уже внутри его собственного контекста, как и любая другая работа
// с данными склада.
async function runOnce() {
  // Через узкую SECURITY DEFINER функцию, а не обычным SELECT: у warehouses
  // включена изоляция, и без контекста склада запрос молча возвращает ноль
  // строк — проход тихо не делал ничего и не жаловался (поймано на проде).
  const warehouses = await withoutTenantContext((client) => client.query(
    `SELECT id FROM list_warehouse_ids_for_alerts()`,
  ));

  let checked = 0;
  for (const row of warehouses.rows) {
    try {
      await withTenantContext({ warehouseId: row.id }, async (client) => {
        await checkWarehouse(client, row.id);
        await maybeDigest(client, row.id);
      });
      checked += 1;
    } catch (err) {
      // Один сломанный склад не должен останавливать проверку остальных.
      console.error(`alerts: склад ${row.id} не проверен:`, err.message);
    }
  }
  return checked;
}

// Проверка живёт внутри процесса приложения, а не отдельным демоном: меньше
// деталей, которые могут тихо умереть по отдельности. Если упадёт приложение,
// это заметят и так; отметка last_run_at показывает, ходит ли сторож.
const INTERVAL_MS = 10 * 60 * 1000;
let timer = null;

function start() {
  if (timer) return;
  const tick = () => {
    runOnce().catch((err) => console.error('alerts: проход упал целиком:', err.message));
  };
  // Первый проход не сразу: дать приложению подняться и не мешать старту.
  timer = setInterval(tick, INTERVAL_MS);
  setTimeout(tick, 30 * 1000).unref?.();
  timer.unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { checkWarehouse, maybeDigest, runOnce, start, stop, INTERVAL_MS };
