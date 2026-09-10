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
    if (!Array.isArray(result?.cards) || !result.cursor) throw new Error('Invalid WB catalog response');
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
      if (!next.updatedAt || next.nmID == null || JSON.stringify(next) === JSON.stringify(cursor)) throw new Error('WB catalog cursor did not advance');
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
module.exports = { syncPhotos, photoUrl };
