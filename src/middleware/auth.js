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

async function keyStillActive(role, id) {
  const cacheKey = role + ':' + id;
  const hit = keyCache.get(cacheKey);
  if (hit && Date.now() - hit.at < KEY_CACHE_MS) return hit.active;

  const fn = role === 'seller' ? 'seller_key_is_active' : 'staff_key_is_active';
  const r = await withoutTenantContext((client) => client.query(
    `SELECT ${fn}($1) AS active`, [id],
  ));
  const active = r.rows[0]?.active === true;
  keyCache.set(cacheKey, { active, at: Date.now() });
  if (keyCache.size > 500) {
    for (const [k, v] of keyCache) if (Date.now() - v.at >= KEY_CACHE_MS) keyCache.delete(k);
  }
  return active;
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
    payload = jwt.verify(token, process.env.JWT_SECRET);
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
    try {
      if (!await keyStillActive(payload.role, keyId)) {
        return res.status(401).json({ error: 'Ваш ключ отозван. Обратитесь к руководителю склада.' });
      }
    } catch (err) {
      // База недоступна — не превращаем это в «всех выгнать»: ошибка связи и
      // отзыв ключа для человека выглядят одинаково, а причины разные.
      return res.status(503).json({ error: 'Сервер временно недоступен, повторите' });
    }
  }

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

module.exports = { requireAuth, requireRole, requireGrant, GRANTS };
