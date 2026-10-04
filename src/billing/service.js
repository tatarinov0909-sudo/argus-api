// Расчёты с продавцами, первая версия (владелец 04.10.2026: «давай пока с
// примерными цифрами»; рецензия 04.10, рекомендация 8).
//
// Один склад, один прайс, один месяц. Каждая строка объясняется: услуга,
// количество, единица, ставка, сумма и исходные операции — приходы, дни
// сборки, возвраты, дни хранения. Считаем только то, что склад уже
// записывает; упаковку и маркировку — когда появится, где их записывать.
// Счёт не «выставляется» и не хранится: это расчёт по текущему прайсу.
const { HttpError } = require('../middleware/errorHandler');
const { zoneOf, todayIn } = require('../warehouses/time');

const SERVICES = {
  storage: { title: 'Хранение' },
  receiving: { title: 'Приёмка', unit: 'шт.' },
  picking: { title: 'Сборка заказа', unit: 'заказ' },
  returns: { title: 'Разбор возврата', unit: 'шт.' },
};
const STORAGE_UNITS = { cell_day: 'ячейку в сутки', unit_day: 'штуку в сутки' }; // после «за»
// Примерные ставки — из коммерческого предложения другого фулфилмента.
// Пока склад не сохранил свой прайс, расчёт везде помечен «примерный».
const DEFAULT_PRICES = { storage: 20, receiving: 5, picking: 10, returns: 10 };

async function tariff(client, warehouseId) {
  const r = (await client.query(
    'SELECT prices, storage_unit, show_sellers, updated_at, updated_by FROM billing_tariffs WHERE warehouse_id = $1',
    [warehouseId])).rows[0];
  if (!r) return { prices: { ...DEFAULT_PRICES }, storageUnit: 'cell_day', showSellers: false, approximate: true };
  return { prices: { ...DEFAULT_PRICES, ...r.prices }, storageUnit: r.storage_unit, showSellers: r.show_sellers,
    approximate: false, updatedAt: r.updated_at, updatedBy: r.updated_by };
}

async function saveTariff(client, warehouseId, body, who) {
  const prices = {};
  for (const key of Object.keys(SERVICES)) {
    const v = Number(String(body?.prices?.[key] ?? '').replace(',', '.'));
    if (!Number.isFinite(v) || v < 0 || v > 1e6) throw new HttpError(400, `Цена «${SERVICES[key].title}» — число от 0 до 1 000 000`);
    prices[key] = Math.round(v * 100) / 100;
  }
  const unit = body?.storageUnit;
  if (!STORAGE_UNITS[unit]) throw new HttpError(400, 'Хранение берём за ячейку или за штуку в сутки');
  await client.query(
    `INSERT INTO billing_tariffs (warehouse_id, prices, storage_unit, show_sellers, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, now(), $5)
     ON CONFLICT (warehouse_id) DO UPDATE SET prices = $2, storage_unit = $3, show_sellers = $4,
       updated_at = now(), updated_by = $5`,
    [warehouseId, JSON.stringify(prices), unit, body?.showSellers === true, who || null]);
  return tariff(client, warehouseId);
}

// Занятость за сутки — наибольшая за день: сторож заходит каждые десять
// минут, и товар, пролежавший полдня, место всё равно занимал.
async function snapshotStorage(client, warehouseId) {
  const day = todayIn(await zoneOf(client, warehouseId));
  await client.query(
    `INSERT INTO billing_storage_days (warehouse_id, company_id, day, cells, units)
     SELECT $1, company_id, $2::date, count(DISTINCT cell_block_id), sum(qty)
       FROM cell_stock WHERE warehouse_id = $1 AND company_id IS NOT NULL AND qty > 0
      GROUP BY company_id
     ON CONFLICT (warehouse_id, company_id, day) DO UPDATE
       SET cells = GREATEST(billing_storage_days.cells, EXCLUDED.cells),
           units = GREATEST(billing_storage_days.units, EXCLUDED.units)`,
    [warehouseId, day]);
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

async function charges(client, warehouseId, { month, companyId = null }) {
  if (!MONTH.test(String(month || ''))) throw new HttpError(400, 'Месяц — в виде ГГГГ-ММ');
  const t = await tariff(client, warehouseId);
  const zone = await zoneOf(client, warehouseId);
  await snapshotStorage(client, warehouseId);
  // Границы месяца — по поясу склада, как и всё время склада.
  const p = [warehouseId, month + '-01', companyId, zone];
  const span = (col) => `${col} >= ($2::date)::timestamp AT TIME ZONE $4
    AND ${col} < (($2::date + interval '1 month')::date)::timestamp AT TIME ZONE $4
    AND ($3::uuid IS NULL OR x.company_id = $3)`;
  const receiving = (await client.query(
    `SELECT x.company_id, i.number, min(x.finished_at) AS at, sum(x.accepted_qty)::int AS qty
       FROM receiving_records x JOIN invoice_items ii ON ii.id = x.invoice_item_id JOIN invoices i ON i.id = ii.invoice_id
      WHERE x.warehouse_id = $1 AND ${span('x.finished_at')}
      GROUP BY x.company_id, i.id, i.number ORDER BY min(x.finished_at)`, p)).rows;
  // Заказ считаем один раз — в месяце, когда его начали собирать.
  const picking = (await client.query(
    `SELECT x.company_id, to_char(x.at AT TIME ZONE $4, 'YYYY-MM-DD') AS day, count(*)::int AS qty
       FROM (SELECT sr.company_id, ii.invoice_id, min(sr.finished_at) AS at
               FROM shipping_records sr JOIN invoice_items ii ON ii.id = sr.invoice_item_id
              WHERE sr.warehouse_id = $1 AND sr.company_id IS NOT NULL AND sr.finished_at IS NOT NULL
              GROUP BY sr.company_id, ii.invoice_id) x
      WHERE ${span('x.at')}
      GROUP BY x.company_id, day ORDER BY day`, p)).rows;
  const returns = (await client.query(
    `SELECT x.company_id, i.number, min(x.finished_at) AS at, sum(x.qty)::int AS qty
       FROM return_records x JOIN invoice_items ii ON ii.id = x.invoice_item_id JOIN invoices i ON i.id = ii.invoice_id
      WHERE x.warehouse_id = $1 AND ${span('x.finished_at')}
      GROUP BY x.company_id, i.id, i.number ORDER BY min(x.finished_at)`, p)).rows;
  const storage = (await client.query(
    `SELECT x.company_id, to_char(x.day, 'YYYY-MM-DD') AS day, x.cells, x.units::bigint AS units
       FROM billing_storage_days x
      WHERE x.warehouse_id = $1 AND x.day >= $2::date AND x.day < ($2::date + interval '1 month')::date
        AND ($3::uuid IS NULL OR x.company_id = $3)
      ORDER BY x.day`, p.slice(0, 3))).rows;
  const since = (await client.query(
    `SELECT to_char(min(day), 'YYYY-MM-DD') AS d FROM billing_storage_days WHERE warehouse_id = $1`, [warehouseId])).rows[0].d;

  const byUnit = t.storageUnit === 'unit_day' ? 'units' : 'cells';
  const sources = {
    storage: storage.map((r) => ({ companyId: r.company_id, label: r.day, qty: Number(r[byUnit]) })),
    receiving: receiving.map((r) => ({ companyId: r.company_id, label: r.number, at: r.at, qty: r.qty })),
    picking: picking.map((r) => ({ companyId: r.company_id, label: r.day, qty: r.qty })),
    returns: returns.map((r) => ({ companyId: r.company_id, label: r.number, at: r.at, qty: r.qty })),
  };
  const ids = [...new Set(Object.values(sources).flat().map((d) => d.companyId))];
  const names = ids.length ? new Map((await client.query(
    'SELECT id, name FROM companies WHERE id = ANY($1::uuid[])', [ids])).rows.map((r) => [r.id, r.name])) : new Map();
  const round = (v) => Math.round(v * 100) / 100;
  const sellers = ids.map((id) => {
    const lines = Object.keys(SERVICES).map((key) => {
      const details = sources[key].filter((d) => d.companyId === id).map(({ companyId, ...d }) => d);
      const qty = details.reduce((a, d) => a + d.qty, 0);
      return { service: key, title: SERVICES[key].title, unit: key === 'storage' ? STORAGE_UNITS[t.storageUnit] : SERVICES[key].unit,
        qty, rate: t.prices[key], amount: round(qty * t.prices[key]), details };
    }).filter((l) => l.qty > 0);
    return { companyId: id, name: names.get(id) || 'продавец', lines, total: round(lines.reduce((a, l) => a + l.amount, 0)) };
  }).sort((a, b) => b.total - a.total);
  return { month, approximate: t.approximate, storageUnit: t.storageUnit, storageSince: since, sellers,
    total: round(sellers.reduce((a, s) => a + s.total, 0)) };
}

module.exports = { SERVICES, STORAGE_UNITS, DEFAULT_PRICES, tariff, saveTariff, snapshotStorage, charges };
