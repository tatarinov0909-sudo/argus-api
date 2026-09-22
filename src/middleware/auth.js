const jwt = require('jsonwebtoken');
const { withoutTenantContext } = require('../db/pool');

// Отозванный ключ должен переставать работать сразу, а не когда истечёт токен.
// Раньше между «отозвал» и «перестал пускать» было до 45 минут — ровно тех
// минут, ради которых ключ и отзывают.
//
// Ответ держим в памяти пару секунд: страница работника делает несколько
// запросов подряд, и превращать каждый в поход в базу незачем. Две секунды —
// это про пачку запросов одного действия, а не про «подождать с отзывом».
const KEY_CACHE_MS = 2000;
const keyCache = new Map();

// Что с ключом сейчас: жив ли, а у сотрудника ещё роль и права. Роль и
// права берём отсюда, а не из токена — вход живёт смену, и снятое право
// должно переставать действовать сразу.
async function keyState(role, id) {
  const cacheKey = role + ':' + id;
  const hit = keyCache.get(cacheKey);
  if (hit && Date.now() - hit.at < KEY_CACHE_MS) return hit.state;

  let state;
  if (role === 'seller') {
    const r = await withoutTenantContext((client) => client.query(
      'SELECT seller_key_is_active($1) AS active', [id],
    ));
    state = { active: r.rows[0]?.active === true };
  } else {
    const r = await withoutTenantContext((client) => client.query(
      'SELECT * FROM staff_key_state($1)', [id],
    ));
    const row = r.rows[0];
    state = row
      ? { active: row.active === true, kind: row.kind, permissions: row.permissions || [] }
      : { active: false };
  }
  keyCache.set(cacheKey, { state, at: Date.now() });
  if (keyCache.size > 500) {
    for (const [k, v] of keyCache) if (Date.now() - v.at >= KEY_CACHE_MS) keyCache.delete(k);
  }
  return state;
}

// Продление входа. Токен, у которого прошла половина срока, меняем на
// свежий в заголовке ответа — кабинеты подхватывают его сами. Работающего
// человека не выкидывает никогда; выйдет только тот, кто не открывал
// Аргус дольше срока (12 часов). Только для людей: у обмена с 1С свой срок.
const RENEWED_ROLES = new Set(['owner', 'manager', 'worker', 'seller']);
function renewIfOld(res, payload) {
  if (!RENEWED_ROLES.has(payload.role) || !payload.exp || !payload.iat) return;
  if (payload.exp - Date.now() / 1000 > (payload.exp - payload.iat) / 2) return;
  const { iat, exp, ...claims } = payload;
  // Позднее подключение: auth/service сам тянет базу и ошибки.
  res.set('X-Argus-Token', require('../auth/service').signToken(claims));
}

// Verifies the JWT and attaches req.auth = { role, warehouseId, ownerId, companyId, staffKeyId, sellerKeyId }.
// Does NOT set RLS vars itself — route handlers pass req.auth into withTenantContext()
// when they touch the DB, so the scoping decision always sits next to the query.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Отсутствует токен авторизации' });

  let payload;
  try {
    // Алгоритм закреплён: проверять «чем подписано» по самому токену нельзя.
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    return res.status(401).json({ error: 'Недействительный или истёкший токен' });
  }

  // Владелец входит по паролю, обмен с 1С — по своему ключу со своей проверкой.
  // Здесь речь о ролях, которые живут по выданному ключу: работник, менеджер
  // и продавец. Их ключ владелец может отозвать в любую секунду.
  //
  // Менеджер сюда попал не сразу: роль добавили позже, а список остался
  // старым — и отзыв его ключа не действовал бы до конца жизни токена. Ровно
  // этот же промах у продавца уже стоил нам сорока пяти минут, за которые
  // отозванный ключ продолжал работать.
  const keyId = payload.role === 'seller' ? payload.sellerKeyId
    : (payload.role === 'worker' || payload.role === 'manager') ? payload.staffKeyId : null;
  if (keyId) {
    let state;
    try {
      state = await keyState(payload.role, keyId);
    } catch (err) {
      // База недоступна — не превращаем это в «всех выгнать»: ошибка связи и
      // отзыв ключа для человека выглядят одинаково, а причины разные.
      return res.status(503).json({ error: 'Сервер временно недоступен, повторите' });
    }
    if (!state.active) {
      return res.status(401).json({ error: 'Ваш ключ отозван. Обратитесь к руководителю склада.' });
    }
    if (payload.role !== 'seller') {
      // Руководитель перевёл ключ из менеджеров в работники или обратно —
      // старый вход в чужой кабинет не годится, нужен новый.
      const role = state.kind === 'manager' ? 'manager' : 'worker';
      if (role !== payload.role) {
        return res.status(401).json({ error: 'Руководитель склада изменил вашу роль — войдите заново.' });
      }
      // Права менеджера — те, что открыты сейчас, а не при входе.
      if (role === 'manager') payload.grants = state.permissions;
    }
  }

  renewIfOld(res, payload);
  req.auth = payload;
  return next();
}

// Restricts a route to one or more roles: 'owner' | 'worker' | 'seller'
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({ error: 'Недостаточно прав' });
    }
    next();
  };
}

// Права, которые владелец может открыть конкретному менеджеру. Список
// закрытый: чего здесь нет, того не откроешь никому — и первым в этом
// списке НЕ значится выдача ключей менеджерам, иначе менеджер выпишет себе
// полный доступ, и всё урезание станет вежливой просьбой.
const GRANTS = {
  clients: 'заводить клиентов и выдавать им ключи',
  staff: 'выдавать ключи работникам',
  warehouse: 'менять структуру склада',
  integration: 'подключать 1С',
  marketplaces: 'подключать маркетплейсы',
  billing: 'тариф и деньги',
  shortages: 'получать отметки «нет товара» от грузчиков',
};

// Пускает владельца всегда, менеджера — если владелец открыл ему это право.
//
// Отдельная функция, а не флаг у requireRole: тогда каждый маршрут решал бы
// сам, «а менеджеру-то можно?», и один пропущенный маршрут означал бы дыру,
// которую никто не заметит. Здесь спрашивают право по имени, и список прав
// один на всё приложение.
function requireGrant(grant) {
  if (!Object.prototype.hasOwnProperty.call(GRANTS, grant)) {
    throw new Error(`Неизвестное право: ${grant}`);
  }
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'Нужен вход' });
    if (req.auth.role === 'owner') return next();
    if (req.auth.role === 'manager' && (req.auth.grants || []).includes(grant)) return next();
    return res.status(403).json({
      error: `Это может только руководитель склада — ${GRANTS[grant]}. `
        + 'Попросите открыть вам это право.',
    });
  };
}

// Смотреть склад: ячейки, зоны приёмки, пересчёт.
//
// Владелец и работник — всегда: одному это его склад, другому рабочее место.
// Менеджер — только если владелец открыл ему право «склад». Решение
// владельца от 17.09.2026: работа менеджера — заказы и поставки, а щёлкать
// остатки по ячейкам ему по умолчанию не нужно.
function allowWarehouseView(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: 'Нужен вход' });
  if (req.auth.role === 'owner' || req.auth.role === 'worker') return next();
  if (req.auth.role === 'manager' && (req.auth.grants || []).includes('warehouse')) return next();
  return res.status(403).json({
    error: 'Склад и ячейки открывает владелец склада — попросите открыть вам право «склад».',
  });
}

module.exports = {
  requireAuth, requireRole, requireGrant, allowWarehouseView, GRANTS,
};
