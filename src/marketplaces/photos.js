const wb = require('./wb');
const credentials = require('./credentials');
const { setTimeout: delay } = require('node:timers/promises');

function photoUrl(card) {
  const photo = card.photos?.[0];
  for (const value of [photo?.c246x328, photo?.c516x688, photo?.big, photo?.square]) {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' && !url.username && !url.password &&
          ['wbbasket.ru', 'wbstatic.net', 'wildberries.ru'].some(d => url.hostname === d || url.hostname.endsWith('.' + d))) return url.href;
    } catch {}
  }
  return null;
}

// Persistent incremental cache, shared by all visitors. No WB calls on page views.
// The cursor survives process restarts; replacing a key restarts its catalog.
async function syncPhotos(client, warehouseId, companyId, { fetchPage = wb.productCards, wait = delay } = {}) {
  const credential = (await client.query(`SELECT id,updated_at::text AS updated_at,photo_cursor FROM marketplace_credentials
    WHERE warehouse_id=$1 AND company_id=$2 AND marketplace='wb'
      AND (photo_sync_after IS NULL OR photo_sync_after<=now()) FOR UPDATE SKIP LOCKED`, [warehouseId, companyId])).rows[0];
  if (!credential) return { skipped: true };
  const token = await credentials.tokenFor(client, warehouseId, companyId, 'wb');
  let cursor = credential.photo_cursor || {}, count = 0, complete = false;
  for (let page = 0; page < 5; page++) {
    let result;
    try { result = await fetchPage(token, cursor); }
    catch (err) {
      // Missing Content access must neither break order sync nor cause request storms.
      const minutes = [401, 403].includes(err.status) ? 360 : 5;
      await client.query(`UPDATE marketplace_credentials SET photo_sync_after=now()+($2 * interval '1 minute') WHERE id=$1`, [credential.id, minutes]);
      return { count, unavailable: true };
    }
    if (!Array.isArray(result?.cards) || !result.cursor) {
      // Площадка ответила не тем. Бросать нельзя: транзакция откатит уже
      // записанные страницы и курсор, и следующий проход начнёт всё заново —
      // так фотографии не наполнятся никогда. Отходим на полчаса.
      await client.query(`UPDATE marketplace_credentials SET photo_sync_after=now()+interval '30 minutes' WHERE id=$1`, [credential.id]);
      return { count, unavailable: true };
    }
    const rows = result.cards.filter(card => /^\d+$/.test(String(card.nmID))).map(card => ({ nm_id: String(card.nmID), photo_url: photoUrl(card) }));
    if (rows.length) await client.query(`INSERT INTO marketplace_product_media
      (credential_id,warehouse_id,company_id,nm_id,photo_url,credential_version)
      SELECT $1,$2,$3,r.nm_id,r.photo_url,$4 FROM jsonb_to_recordset($5::jsonb) AS r(nm_id text,photo_url text)
      ON CONFLICT (credential_id,nm_id) DO UPDATE SET photo_url=EXCLUDED.photo_url,
        credential_version=EXCLUDED.credential_version,updated_at=now()`,
      [credential.id, warehouseId, companyId, credential.updated_at, JSON.stringify(rows)]);
    count += rows.length;
    if (result.cards.length) {
      const next = { updatedAt: result.cursor.updatedAt, nmID: result.cursor.nmID };
      if (!next.updatedAt || next.nmID == null || JSON.stringify(next) === JSON.stringify(cursor)) {
        await client.query(`UPDATE marketplace_credentials SET photo_sync_after=now()+interval '30 minutes' WHERE id=$1`, [credential.id]);
        return { count, unavailable: true };
      }
      cursor = next;
    }
    complete = Number(result.cursor.total) < 100;
    // Store progress after each page, including before a later network error.
    await client.query(`UPDATE marketplace_credentials SET photo_cursor=$2::jsonb,
      photo_sync_after=now()+($3 * interval '1 minute') WHERE id=$1`, [credential.id, JSON.stringify(cursor), complete ? 30 : 5]);
    if (complete) break;
    if (page < 4) await wait(650);
  }
  return { count, complete };
}
// Фото из открытого хранилища картинок WB — без ключа и без категории
// «Контент» (так их берёт и «Складус»; владелец 26.09.2026). Картинка карточки
// лежит по адресу basket-NN.wbbasket.ru/vol<nm/1e5>/part<nm/1e3>/<nm>/images/…,
// где NN растёт вместе с номером карточки. Таблицу «номер → сервер» WB не
// публикует и расширяет, поэтому сервер не вычисляем, а находим: начинаем с
// ближайшего по номеру уже найденного и идём в обе стороны. 9 сентября
// перебрали только 23 сервера и решили, что фото так не взять, — у «Слим Тим»
// есть карточки и на 41-м.
// Сейчас их за сорок; запас на рост — чтобы не повторить ошибку 9 сентября.
const BASKETS = 99;
const knownBaskets = new Map(); // vol → номер сервера, общий на процесс

const publicUrl = (nm, basket) => `https://basket-${String(basket).padStart(2, '0')}.wbbasket.ru`
  + `/vol${Math.floor(nm / 1e5)}/part${Math.floor(nm / 1e3)}/${nm}/images/c246x328/1.webp`;

async function headOk(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch { return false; }
}

// Сервер-кандидат по ближайшему известному тому (том — номер карточки / 1e5).
function guessBasket(vol) {
  let best = null;
  for (const [v, b] of knownBaskets) if (!best || Math.abs(v - vol) < Math.abs(best[0] - vol)) best = [v, b];
  return best ? best[1] : 1;
}

async function findPublicPhoto(nmId, { probe = headOk } = {}) {
  const nm = Number(nmId);
  if (!Number.isSafeInteger(nm) || nm <= 0) return null;
  const vol = Math.floor(nm / 1e5);
  const start = guessBasket(vol);
  for (let step = 0; step <= BASKETS; step += 1) {
    for (const b of step ? [start + step, start - step] : [start]) {
      if (b < 1 || b > BASKETS) continue;
      const url = publicUrl(nm, b);
      if (await probe(url)) { knownBaskets.set(vol, b); return url; }
    }
  }
  return null;
}

// Карточки продавца без фото — из заказов и связок артикулов. Ищем порциями,
// а «не нашлось» запоминаем на неделю, чтобы не стучаться каждые пять минут.
// Поиск ходит в сеть — поэтому вне транзакции базы: сначала короткое чтение
// «что искать», потом запросы к хранилищу WB, потом короткая запись. Иначе
// медленное хранилище держало бы соединения с базой (проверка 26.09.2026).
// run(fn) — выполнить fn(client) в контексте склада (withTenantContext).
async function syncPublicPhotos(run, warehouseId, companyId, { probe, limit = 20 } = {}) {
  const todo = await run(async (client) => {
    const credential = (await client.query(`SELECT id, updated_at::text AS updated_at FROM marketplace_credentials
      WHERE warehouse_id=$1 AND company_id=$2 AND marketplace='wb'`, [warehouseId, companyId])).rows[0];
    if (!credential) return null;
    const ids = (await client.query(
      `WITH ids AS (
         SELECT mp_nm_id AS nm_id FROM invoice_items WHERE company_id=$1 AND mp_nm_id ~ '^[0-9]+$'
         UNION SELECT mp_sku FROM product_marketplace_skus WHERE company_id=$1 AND marketplace='wb' AND mp_sku ~ '^[0-9]+$')
       SELECT ids.nm_id FROM ids
        WHERE NOT EXISTS (SELECT 1 FROM marketplace_product_media m
                           WHERE m.company_id=$1 AND m.nm_id=ids.nm_id
                             AND (m.photo_url IS NOT NULL OR m.updated_at > now() - interval '7 days'))
        LIMIT $2`, [companyId, limit])).rows.map((r) => r.nm_id);
    return { credential, ids };
  });
  if (!todo) return { skipped: true };
  const found = [];
  for (const nmId of todo.ids) found.push({ nmId, url: await findPublicPhoto(nmId, { probe }) });
  if (found.length) {
    await run((client) => client.query(`INSERT INTO marketplace_product_media
        (credential_id, warehouse_id, company_id, nm_id, photo_url, credential_version)
      SELECT $1, $2, $3, r.nm_id, r.url, $4 FROM jsonb_to_recordset($5::jsonb) AS r(nm_id text, url text)
      ON CONFLICT (credential_id, nm_id) DO UPDATE SET photo_url = COALESCE(EXCLUDED.photo_url, marketplace_product_media.photo_url),
        updated_at = now()`,
    [todo.credential.id, warehouseId, companyId, todo.credential.updated_at,
      JSON.stringify(found.map((f) => ({ nm_id: f.nmId, url: f.url })))]));
  }
  return { checked: found.length, found: found.filter((f) => f.url).length };
}

module.exports = { syncPhotos, syncPublicPhotos, findPublicPhoto, photoUrl };
