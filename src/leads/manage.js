const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const { HttpError } = require('../middleware/errorHandler');
const { requireLeadAdmin, withLeadAdmin } = require('./access');
const { encrypt, decrypt } = require('../marketplaces/crypto');
const telegram = require('./telegram');

const router = express.Router();
router.use(requireAuth, requireLeadAdmin);
router.get('/access', (_req, res) => res.json({ allowed: true }));
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safe = fn => async (req,res,next) => { try { await fn(req,res); } catch(e) { next(e); } };

router.get('/', safe(async (req,res) => {
  const status = req.query.status || 'all';
  if (!['all','new','contacted','closed'].includes(status)) throw new HttpError(400,'Неизвестный статус');
  const limit = 30;
  const offset = Number(req.query.offset || 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw new HttpError(400,'Неверная страница');
  const data = await withLeadAdmin(req.auth.ownerId, async c => {
    const rows = await c.query(`SELECT id,name,contact,message,payload,source,created_at,status,
      notified_at,notify_attempts,notify_next_at,notify_error FROM leads
      WHERE ($1='all' OR status=$1) ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,[status,limit+1,offset]);
    const counts = (await c.query(`SELECT count(*)::int total,
      count(*) FILTER(WHERE status='new')::int new FROM leads`)).rows[0];
    return { items:rows.rows.slice(0,limit),hasMore:rows.rows.length>limit,offset,counts };
  });
  res.json(data);
}));

router.patch('/:id/status', safe(async(req,res) => {
  if (!uuid.test(req.params.id) || !['new','contacted','closed'].includes(req.body?.status)) throw new HttpError(400,'Неверная заявка или статус');
  const result=await withLeadAdmin(req.auth.ownerId,c=>c.query(
    'UPDATE leads SET status=$2,updated_at=now() WHERE id=$1 RETURNING id,status',[req.params.id,req.body.status]));
  if (!result.rowCount) throw new HttpError(404,'Заявка не найдена');
  res.json(result.rows[0]);
}));

router.post('/:id/notify', safe(async(req,res) => {
  if (!uuid.test(req.params.id)) throw new HttpError(400,'Неверная заявка');
  await withLeadAdmin(req.auth.ownerId,async c=>{
    const settings=(await c.query('SELECT enabled_since FROM lead_notification_settings WHERE id=true FOR UPDATE')).rows[0];
    if (!settings?.enabled_since) throw new HttpError(409,'Сначала подключите Telegram');
    const result=await c.query(`UPDATE leads SET notify_requested_at=now(),notify_next_at=now(),notify_error=null
      WHERE id=$1 AND notified_at IS NULL AND status<>'closed' RETURNING id`,[req.params.id]);
    if (!result.rowCount) throw new HttpError(409,'Заявка закрыта, уже доставлена или не найдена');
  });
  res.json({ queued:true });
}));

router.get('/telegram', safe(async(req,res) => {
  const row=await withLeadAdmin(req.auth.ownerId,async c=>(await c.query(`SELECT bot_username,
    (enabled_since IS NOT NULL) connected, enabled_since,last_checked_at,last_delivered_at,last_error,
    (pending_expires_at>now() AND pending_owner_id=$1) pending FROM lead_notification_settings WHERE id=true`,[req.auth.ownerId])).rows[0]);
  res.json(row || {connected:false});
}));

router.post('/telegram/connect', safe(async(req,res) => {
  const token=typeof req.body?.token==='string' ? req.body.token.trim() : '';
  if (!/^\d{5,20}:[A-Za-z0-9_-]{25,100}$/.test(token)) throw new HttpError(400,'Введите полный токен бота из BotFather');
  let me,webhook;
  try { me=await telegram.call(token,'getMe'); webhook=await telegram.call(token,'getWebhookInfo'); }
  catch(e) { throw new HttpError(502,'Telegram не подтвердил токен. Проверьте его или повторите позже.'); }
  if (!me?.is_bot || !/^[A-Za-z0-9_]+$/.test(me.username)) throw new HttpError(400,'Не удалось определить бота');
  if (webhook?.url) throw new HttpError(409,'У бота уже подключён другой сервис. Создайте отдельного бота для заявок Аргуса.');
  const nonce=crypto.randomBytes(24).toString('base64url');
  await withLeadAdmin(req.auth.ownerId,c=>c.query(`UPDATE lead_notification_settings SET
    pending_token_ciphertext=$1,pending_bot_username=$2,pending_hash=$3,
    pending_expires_at=now()+interval '15 minutes',pending_owner_id=$4,update_offset=0,updated_at=now()
    WHERE id=true`,[encrypt(token),me.username,hash(nonce),req.auth.ownerId]));
  res.json({ url:`https://t.me/${me.username}?start=argus_${nonce}`, expiresIn:900 });
}));

router.post('/telegram/confirm', safe(async(req,res) => {
  const connected=await withLeadAdmin(req.auth.ownerId,async c=>{
    const s=(await c.query('SELECT * FROM lead_notification_settings WHERE id=true FOR UPDATE')).rows[0];
    if (!s?.pending_hash || new Date(s.pending_expires_at)<=new Date() || s.pending_owner_id!==req.auth.ownerId)
      throw new HttpError(409,'Начните подключение заново: ссылка действует 15 минут');
    const token=decrypt(s.pending_token_ciphertext);
    let updates;
    try { updates=await telegram.call(token,'getUpdates',{offset:Number(s.update_offset),limit:100,timeout:0,allowed_updates:['message']}); }
    catch { throw new HttpError(502,'Telegram временно недоступен или бот используется другим сервисом'); }
    if (!Array.isArray(updates)) throw new HttpError(502,'Telegram вернул неполный ответ');
    let chat=null;
    for (const update of updates) {
      const m=update.message;
      const nonce=/^\/start(?:@[A-Za-z0-9_]+)? argus_([A-Za-z0-9_-]+)$/.exec(m?.text||'')?.[1];
      if (m?.chat?.type==='private' && !m.from?.is_bot && nonce && hash(nonce)===s.pending_hash) chat=String(m.chat.id);
    }
    const offset=updates.length ? Math.max(...updates.map(u=>u.update_id))+1 : Number(s.update_offset);
    if (!chat) { await c.query('UPDATE lead_notification_settings SET update_offset=$1 WHERE id=true',[offset]); return false; }
    // This confirmation also proves that the bot may send to this private chat.
    try { await telegram.call(token,'sendMessage',{chat_id:chat,text:'Аргус подключён. Новые заявки с лендинга будут приходить сюда.',protect_content:true}); }
    catch { throw new HttpError(502,'Не удалось отправить подтверждение. Разрешите сообщения от бота и повторите.'); }
    await c.query(`UPDATE lead_notification_settings SET token_ciphertext=pending_token_ciphertext,
      bot_username=pending_bot_username,chat_id=$1,enabled_since=COALESCE(enabled_since,now()),
      pending_token_ciphertext=null,pending_bot_username=null,pending_hash=null,pending_expires_at=null,
      pending_owner_id=null,last_error=null,updated_by=$2,updated_at=now() WHERE id=true`,[chat,req.auth.ownerId]);
    return true;
  });
  res.json({connected});
}));

router.delete('/telegram', safe(async(req,res) => {
  await withLeadAdmin(req.auth.ownerId,c=>c.query(`UPDATE lead_notification_settings SET
    token_ciphertext=null,bot_username=null,chat_id=null,enabled_since=null,pending_token_ciphertext=null,
    pending_bot_username=null,pending_hash=null,pending_expires_at=null,pending_owner_id=null,
    last_error=null,updated_by=$1,updated_at=now() WHERE id=true`,[req.auth.ownerId]));
  res.json({connected:false});
}));

module.exports=router;
