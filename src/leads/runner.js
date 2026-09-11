const { withoutTenantContext } = require('../db/pool');
const { withLeadAdmin } = require('./access');
const { decrypt } = require('../marketplaces/crypto');
const telegram = require('./telegram');
let running=false;

async function runOnce(sender=telegram.call) {
  if (running) return;
  running=true;
  try {
    const owner=await withoutTenantContext(async c=>(await c.query(
      'SELECT owner_id FROM platform_administrators WHERE active ORDER BY created_at LIMIT 1')).rows[0]);
    if (!owner) return;
    for (let i=0;i<10;i++) {
      const more=await withLeadAdmin(owner.owner_id,async c=>{
        if (!(await c.query('SELECT pg_try_advisory_xact_lock(7713401) locked')).rows[0].locked) return false;
        const s=(await c.query('SELECT * FROM lead_notification_settings WHERE id=true FOR UPDATE')).rows[0];
        if (!s?.enabled_since || !s.chat_id || !s.token_ciphertext) return false;
        await c.query('UPDATE lead_notification_settings SET last_checked_at=now() WHERE id=true');
        const lead=(await c.query(`SELECT * FROM leads WHERE notified_at IS NULL
          AND status<>'closed' AND notify_next_at<=now()
          AND (created_at >= $1 OR notify_requested_at IS NOT NULL)
          ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[s.enabled_since])).rows[0];
        if (!lead) return false;
        let result;
        try {
          result=await sender(decrypt(s.token_ciphertext),'sendMessage',{
            chat_id:s.chat_id,text:telegram.messageFor(lead),protect_content:true,
            link_preview_options:{is_disabled:true},
          });
          if (!Number.isSafeInteger(result?.message_id)) throw new telegram.TelegramError('provider_error');
        } catch(e) {
          const code=e instanceof telegram.TelegramError ? e.code : 'delivery_error';
          const delay=telegram.retryDelay(lead.notify_attempts,e.retryAfter);
          await c.query(`UPDATE leads SET notify_attempts=notify_attempts+1,notify_error=$2,
            notify_next_at=now()+($3::int * interval '1 second') WHERE id=$1`,[lead.id,code,delay]);
          await c.query('UPDATE lead_notification_settings SET last_error=$1 WHERE id=true',[code]);
          return false;
        }
        await c.query(`UPDATE leads SET notified_at=now(),notification_message_id=$2,
          notify_attempts=notify_attempts+1,notify_error=null WHERE id=$1`,[lead.id,result.message_id]);
        await c.query('UPDATE lead_notification_settings SET last_delivered_at=now(),last_error=null WHERE id=true');
        return true;
      });
      if (!more) break;
    }
  } finally { running=false; }
}

function start() {
  const tick=()=>runOnce().catch(()=>console.error('leads: notification worker unavailable'));
  const timer=setInterval(tick,30000); timer.unref(); tick(); return timer;
}
module.exports={start,runOnce};
