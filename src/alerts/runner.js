const { withTenantContext, withoutTenantContext } = require('../db/pool');
const { collect } = require('./rules');

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
// Часового пояса у склада в базе нет, поэтому считаем по Москве — почти все
// клиенты в ней и живут. Появится поле — заменить здесь одну строку.
const DIGEST_HOUR_MSK = 7;

function mskNow() {
  return new Date(Date.now() + 3 * 3600000);
}

async function maybeDigest(client, warehouseId) {
  const now = mskNow();
  if (now.getUTCHours() < DIGEST_HOUR_MSK) return null;
  const today = now.toISOString().slice(0, 10);

  const run = await client.query(
    `SELECT last_digest_on FROM alert_runs WHERE warehouse_id = $1`,
    [warehouseId],
  );
  const last = run.rows[0]?.last_digest_on;
  if (last && new Date(last).toISOString().slice(0, 10) >= today) return null;

  const openRows = await client.query(
    `SELECT text FROM alerts WHERE warehouse_id = $1 AND resolved_at IS NULL
       AND alert_key NOT LIKE 'digest:%'
     ORDER BY created_at`,
    [warehouseId],
  );

  const work = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM invoices
        WHERE warehouse_id = $1 AND direction = 'out' AND status IN ('open', 'in_progress')) AS to_pick,
       (SELECT COUNT(*)::int FROM invoices
        WHERE warehouse_id = $1 AND direction = 'in' AND status IN ('open', 'in_progress')) AS to_receive,
       (SELECT COUNT(*)::int FROM invoices
        WHERE warehouse_id = $1 AND direction = 'return' AND status IN ('open', 'in_progress')) AS to_sort`,
    [warehouseId],
  );
  const w = work.rows[0];
  const parts = [];
  if (w.to_pick) parts.push(`${w.to_pick} на сборку`);
  if (w.to_receive) parts.push(`${w.to_receive} на приёмку`);
  if (w.to_sort) parts.push(`${w.to_sort} на разбор возврата`);

  // Ни работы, ни открытых тревог — писать не о чем.
  if (parts.length === 0 && openRows.rows.length === 0) {
    await client.query(
      `UPDATE alert_runs SET last_digest_on = $2::date WHERE warehouse_id = $1`,
      [warehouseId, today],
    );
    return null;
  }

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
