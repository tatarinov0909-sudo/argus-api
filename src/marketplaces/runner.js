const { withTenantContext, withoutTenantContext } = require('../db/pool');
const sync = require('./sync');

// Опрос площадок по расписанию.
//
// Опрос, а не вебхуки: у трёх площадок три разных механизма подписки, и
// строить их до того, как хотя бы одна интеграция поработала, значит делать
// два пути получения заказов одновременно. Вебхуки — потом.
//
// Пять минут: сборочные задания на FBS горят по SLA площадки, и штраф за
// просрочку платит продавец. Пятиминутная задержка ничего не решает, а
// получасовая может стоить денег. Нагрузка при этом копеечная — один запрос
// на продавца.
const INTERVAL_MS = 5 * 60 * 1000;
let timer = null;

// Список складов — через ту же узкую SECURITY DEFINER функцию, что и у
// тревог: у warehouses включена изоляция, и обычный SELECT без контекста
// склада молча вернёт ноль строк (на этом уже один раз тихо сломался обход
// тревог на проде).
//
// Отфильтровать здесь же «только те, у кого есть ключ» нельзя по той же
// причине: marketplace_credentials тоже изолирована и снаружи контекста
// пуста. Поэтому фильтрация живёт внутри — pullAll на складе без ключей
// просто ничего не найдёт и вернёт пустой список.
async function allWarehouses() {
  const r = await withoutTenantContext((client) => client.query(
    `SELECT id FROM list_warehouse_ids_for_alerts()`,
  ));
  return r.rows.map((x) => x.id);
}

async function runOnce() {
  const ids = await allWarehouses();
  let done = 0;
  for (const warehouseId of ids) {
    try {
      const results = await withTenantContext({ warehouseId }, (client) => (
        sync.pullAll(client, warehouseId)
      ));
      for (const r of results) {
        if (r.error) {
          console.error(`маркетплейсы: ${r.company} — ${r.error}`);
        } else if (r.created || r.unmapped?.length) {
          console.log(`маркетплейсы: ${r.company} — новых заказов ${r.created}`
            + `, не сопоставлено ${r.unmapped.length}`);
        }
      }
      done += 1;
    } catch (err) {
      // Один склад не должен ронять обход остальных: ключ мог протухнуть.
      console.error(`маркетплейсы: склад ${warehouseId} не опрошен:`, err.message);
    }
  }
  return done;
}

function start() {
  if (timer) return;
  const tick = () => {
    runOnce().catch((err) => console.error('маркетплейсы: проход упал целиком:', err.message));
  };
  timer = setInterval(tick, INTERVAL_MS);
  // Не сразу на старте: дать приложению подняться.
  setTimeout(tick, 45 * 1000).unref?.();
  timer.unref?.();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { runOnce, start, stop, INTERVAL_MS };
