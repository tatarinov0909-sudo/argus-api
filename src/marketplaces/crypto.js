const crypto = require('crypto');

// Шифрование ключей доступа к площадкам.
//
// Ключ продавца — это доступ к его заказам и его остаткам. В базе он лежит
// только шифртекстом: у базы своя жизнь (бэкапы, дампы, чужие глаза при
// разборе инцидента), и открытый токен в дампе означает, что дамп по факту
// равен доступу к чужому магазину.
//
// AES-256-GCM, а не CBC: GCM даёт не только шифрование, но и проверку
// целостности — подменённый или обрезанный шифртекст не расшифруется вместо
// того, чтобы тихо превратиться в мусор, который мы потом отправим в API.
//
// Ключ шифрования берётся ТОЛЬКО из окружения и никогда не хранится рядом с
// данными: иначе шифрование — театр.
const ALGO = 'aes-256-gcm';
const VERSION = 'v1';

function keyFromEnv() {
  const raw = process.env.MARKETPLACE_KEY_SECRET;
  if (!raw) {
    throw new Error(
      'MARKETPLACE_KEY_SECRET не задан — без него ключи площадок хранить нельзя',
    );
  }
  // 64 hex-символа — обычная форма. Всё остальное считаем парольной фразой и
  // растягиваем: лучше принять слабый ключ и работать, чем упасть на проде.
  const key = /^[0-9a-f]{64}$/i.test(raw)
    ? Buffer.from(raw, 'hex')
    : crypto.createHash('sha256').update(raw).digest();
  return key;
}

// Возвращает одну строку: версия, вектор, тег и шифртекст. Всё в одном поле,
// потому что таблица хранит непрозрачный payload и разбирать его не должна.
function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext) {
    throw new Error('Нечего шифровать');
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, keyFromEnv(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

function decrypt(payload) {
  if (typeof payload !== 'string') throw new Error('Пустой шифртекст');
  const [version, ivB64, tagB64, ctB64] = payload.split(':');
  if (version !== VERSION || !ivB64 || !tagB64 || !ctB64) {
    throw new Error('Шифртекст в неизвестном формате');
  }
  const decipher = crypto.createDecipheriv(ALGO, keyFromEnv(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

// Для показа в интерфейсе: владелец должен узнать свой ключ, но не прочитать.
function mask(token) {
  if (!token || token.length < 12) return '…';
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

module.exports = { encrypt, decrypt, mask };
