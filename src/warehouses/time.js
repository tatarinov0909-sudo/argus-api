// Время склада (анкета склада, warehouses.timezone; владелец 30.09.2026).
// «Сегодня» в номерах поставок и приходов, «дата отгрузки прошла», утренняя
// сводка и время в текстах журнала считаются по поясу склада, а не по Москве
// и не по поясу сервера: у склада в Новосибирске сутки начинаются раньше.

const DEFAULT_ZONE = 'Europe/Moscow';

async function zoneOf(client, warehouseId) {
  const r = await client.query('SELECT timezone FROM warehouses WHERE id = $1', [warehouseId]);
  return r.rows[0]?.timezone || DEFAULT_ZONE;
}

// ГГГГ-ММ-ДД в поясе склада.
const todayIn = (zone, at = new Date()) => at.toLocaleDateString('sv-SE', { timeZone: zone });

// Час (0–23) в поясе склада.
const hourIn = (zone, at = new Date()) => Number(new Intl.DateTimeFormat('en-GB',
  { hour: '2-digit', hourCycle: 'h23', timeZone: zone }).format(at));

const warehouseToday = async (client, warehouseId) => todayIn(await zoneOf(client, warehouseId));

module.exports = { DEFAULT_ZONE, zoneOf, todayIn, hourIn, warehouseToday };
