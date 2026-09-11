const ALLOWED_METHODS = new Set(['getMe', 'getWebhookInfo', 'getUpdates', 'sendMessage']);

class TelegramError extends Error {
  constructor(code, retryAfter = 0) { super('Telegram: ' + code); this.code = code; this.retryAfter = retryAfter; }
}

async function call(token, method, body = {}, fetcher = fetch) {
  if (!ALLOWED_METHODS.has(method)) throw new TelegramError('method_forbidden');
  let response, data;
  try {
    response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10000), redirect: 'error',
    });
    data = await response.json();
  } catch { throw new TelegramError('network'); } // Never retain URL/token or raw provider response.
  if (!response.ok || data.ok !== true) {
    const code = data.error_code || response.status;
    throw new TelegramError(code === 429 ? 'rate_limit' : code === 401 ? 'invalid_token'
      : code === 403 ? 'blocked' : code === 409 ? 'another_connection' : 'provider_error',
    Math.max(0, Math.min(Number(data.parameters?.retry_after) || 0, 86400)));
  }
  return data.result;
}

function messageFor(lead) {
  // Plain text: applicant content can never become Telegram formatting or a command.
  const short = value => String(value || '').slice(0, 1600);
  return ['Новая заявка в Аргус', '№ ' + lead.id,
    'Имя: ' + short(lead.name || 'Не указано'), 'Контакт: ' + short(lead.contact),
    lead.message ? '\n' + short(lead.message) : '',
    '\nОткрыть: https://argus-ai.online/leads.html'].filter(Boolean).join('\n');
}

function retryDelay(attempt, retryAfter = 0) {
  return Math.max(retryAfter, Math.min(21600, 30 * 2 ** Math.min(attempt, 10)));
}

module.exports = { call, messageFor, retryDelay, TelegramError };
