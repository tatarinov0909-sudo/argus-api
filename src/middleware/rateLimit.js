// Ограничение частоты для дверей, в которые стучат снаружи.
//
// Вход по паролю и вход по ключу — единственные места, где можно перебирать:
// у одного пароль, у другого короткий код вида `7721-01`. Без счётчика ключ из
// четырёх цифр и двух подбирается за минуты, и никто об этом не узнает.
//
// В памяти процесса, а не в базе. Перезапуск сбрасывает счётчик — это
// приемлемо: задача не остановить упорного злоумышленника (для этого нужен
// внешний заслон), а сделать перебор бессмысленно медленным и оставить след
// в логах.
const buckets = new Map();

function rateLimit({ windowMs, max, key, message }) {
  return (req, res, next) => {
    const id = key(req);
    // Некого считать (нет ни адреса, ни поля) — пропускаем: лучше пустить,
    // чем заблокировать всех под одним пустым ключом.
    if (!id) return next();

    const now = Date.now();
    const hits = (buckets.get(id) || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      const waitSec = Math.ceil((windowMs - (now - hits[0])) / 1000);
      res.set('Retry-After', String(waitSec));
      return res.status(429).json({ error: message || `Слишком много попыток. Подождите ${waitSec} с.` });
    }
    hits.push(now);
    buckets.set(id, hits);

    // Карта не должна расти бесконечно: изредка выметаем остывшее.
    if (buckets.size > 1000) {
      for (const [k, times] of buckets) {
        if (times.every((t) => now - t >= windowMs)) buckets.delete(k);
      }
    }
    return next();
  };
}

const ipOf = (req) => req.ip || req.socket?.remoteAddress || null;

// Вход по паролю: считаем и по адресу, и по самой почте. Только по адресу —
// и перебор с сотни адресов проходит мимо; только по почте — и один сломанный
// клиент блокирует чужой аккаунт.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  key: (req) => {
    const ip = ipOf(req);
    const login = String(req.body?.email || req.body?.keyCode || '').trim().toLowerCase();
    return ip ? `${ip}|${login}` : null;
  },
  message: 'Слишком много попыток входа. Подождите несколько минут.',
});

// Вход по ключу — то же самое, но ключи короткие, поэтому окно жёстче.
const keyLoginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  key: ipOf,
  message: 'Слишком много попыток входа по ключу. Подождите несколько минут.',
});

module.exports = { rateLimit, loginLimiter, keyLoginLimiter };
