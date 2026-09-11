// Правила, по которым Кладовщик решает заговорить первым.
//
// Каждое правило — обычный запрос к базе. Модель здесь не участвует вообще:
// найти проблему стоит ноль токенов, текст собирается шаблоном. Это не
// экономия ради экономии — правило ещё и не может ошибиться в цифре, а
// сообщение, которое приходит без спроса, обязано быть точным.
//
// Что должно быть в каждом правиле:
//   key   — устойчивое имя проблемы. Пока она жива, второго сообщения нет.
//   text  — законченная фраза человеку, с числами и без жаргона.
// Правило возвращает пустой список, когда всё в порядке: молчание и означает
// «проблем нет», иначе владелец перестанет читать.

// Пороги. Начинаем осторожно: лучше пропустить, чем приучить нажимать «скрыть».
const THRESHOLDS = {
  discrepancyHours: 12, // расхождение ждёт решения владельца
  returnUnsortedHours: 24, // возврат приехал и лежит неразобранным
  readyNotShippedHours: 8, // заказ собран, но не уехал
  syncSilentMinutes: 90, // 1С молчит (обмен идёт раз в полчаса)
  freeCellsPct: 5, // свободных ячеек осталось меньше этой доли от всех
  minCellsToWatch: 20, // на складе меньше этого размера про место не говорим
  defectWaitingDays: 7, // брак ждёт решения продавца
};

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function hoursAgo(ts) {
  return Math.floor((Date.now() - new Date(ts).getTime()) / 3600000);
}

// Расхождения ждут владельца: пока он не решил, акт продавцу не закрыт.
async function discrepancies(client, warehouseId) {
  // Журнал append-only: подтверждение НЕ меняет исходную запись, а дописывает
  // новую со ссылкой на неё (см. journal/repository.js). Искать просто
  // status = 'pending' нельзя — тогда агент вечно напоминал бы о том, что
  // владелец уже решил. Ждущей считается запись, на которую никто не ответил.
  const r = await client.query(
    `SELECT COUNT(*)::int AS n, MIN(je.created_at) AS oldest
     FROM journal_entries je
     WHERE je.warehouse_id = $1 AND je.status = 'pending'
       AND je.created_at < now() - ($2 || ' hours')::interval
       AND NOT EXISTS (
         SELECT 1 FROM journal_entries answer
         WHERE answer.warehouse_id = je.warehouse_id
           AND answer.related_entry_id = je.id
       )`,
    [warehouseId, THRESHOLDS.discrepancyHours],
  );
  const { n, oldest } = r.rows[0];
  if (!n) return [];
  const h = hoursAgo(oldest);
  return [{
    key: 'discrepancies_pending',
    text: `${n} ${plural(n, 'расхождение ждёт', 'расхождения ждут', 'расхождений ждут')} вашего решения. `
      + `Самое старое висит ${h} ${plural(h, 'час', 'часа', 'часов')} — пока вы не решили, акт продавцу не закрыт.`,
  }];
}

// Возврат приехал, но его не разобрали: товар не в продаже и не в браке — он нигде.
async function unsortedReturns(client, warehouseId) {
  const r = await client.query(
    `SELECT i.number, i.created_at
     FROM invoices i
     WHERE i.warehouse_id = $1 AND i.direction = 'return'
       AND i.status IN ('open', 'in_progress')
       AND i.created_at < now() - ($2 || ' hours')::interval
     ORDER BY i.created_at`,
    [warehouseId, THRESHOLDS.returnUnsortedHours],
  );
  if (r.rows.length === 0) return [];
  const n = r.rows.length;
  const first = r.rows[0];
  const d = Math.floor(hoursAgo(first.created_at) / 24);
  return [{
    key: 'returns_unsorted',
    text: n === 1
      ? `Возврат ${first.number} лежит неразобранным ${d >= 1 ? `${d} ${plural(d, 'день', 'дня', 'дней')}` : 'больше суток'}. `
        + 'Пока его не разобрали, товар не в продаже и не в браке — он нигде.'
      : `${n} ${plural(n, 'возврат лежит', 'возврата лежат', 'возвратов лежат')} неразобранными. `
        + `Самый старый — ${first.number}. Этот товар сейчас не числится ни в продаже, ни в браке.`,
  }];
}

// Заказ собран и стоит. Занимает место у ворот, а клиент ждёт.
async function readyNotShipped(client, warehouseId) {
  const r = await client.query(
    `SELECT i.number, c.name AS company, i.created_at
     FROM invoices i JOIN companies c ON c.id = i.company_id
     WHERE i.warehouse_id = $1 AND i.direction = 'out' AND i.status = 'ready'
       AND i.mp_closed_at IS NULL
       AND i.created_at < now() - ($2 || ' hours')::interval
     ORDER BY i.created_at`,
    [warehouseId, THRESHOLDS.readyNotShippedHours],
  );
  if (r.rows.length === 0) return [];
  const n = r.rows.length;
  const first = r.rows[0];
  return [{
    key: 'ready_not_shipped',
    text: n === 1
      ? `Заказ ${first.number} (${first.company}) собран, но так и не отгружен. Стоит и занимает место.`
      : `${n} ${plural(n, 'собранный заказ', 'собранных заказа', 'собранных заказов')} не отгружены. `
        + `Самый давний — ${first.number} (${first.company}).`,
  }];
}

// Обмен с 1С молчит. Это тише всех остальных поломок и опаснее их: агент
// продолжает уверенно отвечать, просто вчерашними данными.
async function syncSilent(client, warehouseId) {
  const r = await client.query(
    `SELECT MAX(last_seen_at) AS seen FROM integration_keys
     WHERE warehouse_id = $1 AND active AND last_seen_at IS NOT NULL`,
    [warehouseId],
  );
  const seen = r.rows[0].seen;
  // Обмена не было ни разу — это не поломка, а ещё не настроенная интеграция.
  if (!seen) return [];
  const minutes = Math.floor((Date.now() - new Date(seen).getTime()) / 60000);
  if (minutes < THRESHOLDS.syncSilentMinutes) return [];
  const h = Math.floor(minutes / 60);
  return [{
    key: 'sync_silent',
    text: `Обмен с 1С молчит ${h >= 1 ? `${h} ${plural(h, 'час', 'часа', 'часов')}` : `${minutes} минут`}. `
      + 'Остатки и накладные у меня с прошлой связи — отвечать я буду по ним, а склад мог уже измениться.',
  }];
}

const SYNC_STAGE_LABELS = {
  companies: 'компании', counterparties: 'контрагенты', products: 'товары',
  invoices: 'накладные', stock: 'учётные остатки', cells: 'адреса хранения',
  'cell-catalog': 'справочник ячеек',
};

// Авторизация модуля обновляет last_seen_at даже тогда, когда отправка данных
// оборвалась. Следим отдельно за этапами, которые уже приходили автоматически.
// Последняя пачка не доказывает полноту обмена; её ошибки тоже показываем именно
// как ошибки пачки, не всего запуска. Отозванные ключи не создают старые тревоги.
async function syncBatches(client, warehouseId) {
  const r = await client.query(
    `SELECT DISTINCT ON (s.stage) s.stage, s.received_at, s.run_mode, s.summary,
       (SELECT MAX(k.last_seen_at) FROM integration_keys k
        WHERE k.warehouse_id = $1 AND k.active) AS last_seen_at
     FROM integration_sync_state s
     JOIN integration_keys k ON k.id = s.integration_key_id
       AND k.warehouse_id = s.warehouse_id AND k.active
     WHERE s.warehouse_id = $1
     ORDER BY s.stage, s.received_at DESC`,
    [warehouseId],
  );
  const known = r.rows.filter((row) => Object.hasOwn(SYNC_STAGE_LABELS, row.stage));
  if (known.length === 0) return [];
  const now = Date.now();
  const ageMinutes = (value) => (now - new Date(value).getTime()) / 60000;
  const stale = known.filter((row) => row.run_mode === 'automatic'
    && ageMinutes(row.received_at) >= THRESHOLDS.syncSilentMinutes);
  const found = [];
  // При полном обрыве связи уже есть sync_silent: не повторяем ту же проблему.
  const seen = known[0].last_seen_at;
  if (stale.length && seen && ageMinutes(seen) < THRESHOLDS.syncSilentMinutes) {
    found.push({
      key: 'sync_batches_stale',
      text: `Модуль 1С подключается, но больше ${THRESHOLDS.syncSilentMinutes} минут не обновлялись: `
        + `${stale.map((row) => SYNC_STAGE_LABELS[row.stage]).join(', ')}. `
        + 'Проверьте результат автоматического обмена в 1С. В кабинете остаются ранее полученные данные.',
    });
  }
  const errors = known.filter((row) => Number(row.summary?.error) > 0);
  if (errors.length) {
    const total = errors.reduce((sum, row) => sum + Number(row.summary.error), 0);
    found.push({
      key: 'sync_batch_errors',
      text: `В последних полученных порциях данных 1С ${total} ${plural(total, 'ошибка', 'ошибки', 'ошибок')}: `
        + `${errors.map((row) => SYNC_STAGE_LABELS[row.stage]).join(', ')}. `
        + 'Часть строк не обновлена. Откройте «Подключение 1С» и результат обмена в модуле.',
    });
  }
  return found;
}

// Считаем незанятые ячейки. Их число не доказывает отсутствие места внутри
// занятых ячеек: реальная вместимость ещё не задана.
async function noFreeCells(client, warehouseId) {
  const r = await client.query(
    `SELECT COUNT(*) FILTER (WHERE state = 'empty')::int AS free,
            COUNT(*)::int AS total
     FROM cell_blocks WHERE warehouse_id = $1`,
    [warehouseId],
  );
  const { free, total } = r.rows[0];
  // Порог в штуках не работает: пять свободных ячеек из шести — это не «мало
  // места», а почти пустой склад. Считаем долей и не трогаем маленькие склады
  // вовсе — там это чаще всего демо или ещё не достроенная схема.
  if (total < THRESHOLDS.minCellsToWatch) return [];
  const limit = Math.max(1, Math.ceil(total * THRESHOLDS.freeCellsPct / 100));
  if (free > limit) return [];
  return [{
    key: 'no_free_cells',
    text: free === 0
      ? `Все ${total} ячеек заняты. Проверьте размещение перед следующей приёмкой: вместимость занятых ячеек не задана.`
      : `Незанятых ячеек осталось ${free} из ${total}. Проверьте размещение перед следующей приёмкой: вместимость занятых ячеек не задана.`,
  }];
}

// Брак лежит и ждёт, что с ним решат. Занимает ячейки и не превращается ни во что.
async function defectWaiting(client, warehouseId) {
  const r = await client.query(
    `SELECT COALESCE(SUM(rr.qty), 0)::int AS qty, MIN(rr.finished_at) AS oldest
     FROM return_records rr
     WHERE rr.warehouse_id = $1 AND rr.quality_bucket = 'defective'
       AND rr.finished_at < now() - ($2 || ' days')::interval`,
    [warehouseId, THRESHOLDS.defectWaitingDays],
  );
  const { qty, oldest } = r.rows[0];
  if (!qty) return [];
  const d = Math.floor(hoursAgo(oldest) / 24);
  return [{
    key: 'defect_waiting',
    text: `${qty} ${plural(qty, 'единица брака ждёт', 'единицы брака ждут', 'единиц брака ждут')} решения продавца `
      + `уже ${d} ${plural(d, 'день', 'дня', 'дней')} — вернуть ему или утилизировать. Место при этом занято.`,
  }];
}

const RULES = [
  discrepancies, unsortedReturns, readyNotShipped, syncSilent, syncBatches, noFreeCells, defectWaiting,
];

// Прогон всех правил. Возвращает список найденного — что с ним делать,
// решает вызывающий (см. runner.js).
async function collect(client, warehouseId) {
  const found = [];
  for (const rule of RULES) {
    // Упавшее правило не должно уносить с собой остальные: одна кривая
    // выборка не повод оставить владельца вообще без предупреждений.
    try {
      found.push(...await rule(client, warehouseId));
    } catch (err) {
      console.error(`alerts: правило ${rule.name} упало:`, err.message);
    }
  }
  return found;
}

module.exports = { collect, THRESHOLDS, RULES };
