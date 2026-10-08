// No .env or database: exercise the real signer and auth middleware with a key-state stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.JWT_EXPIRES_IN = '12h';
let keyState = { active: true, kind: 'worker', permissions: [] };
const poolPath = require.resolve('../src/db/pool');
require.cache[poolPath] = { id: poolPath, filename: poolPath, loaded: true, exports: {
  withoutTenantContext: async fn => fn({ query: async sql => {
    assert.match(sql, /staff_key_state/);
    return { rows: [keyState] };
  } }),
  withTenantContext: () => { throw new Error('Unexpected tenant query'); },
} };
const { signToken, WORKER_TOKEN_TTL_SECONDS } = require('../src/auth/service');
const { requireAuth, forgetKey } = require('../src/middleware/auth');
const now = () => Math.floor(Date.now() / 1000);
const worker = { role: 'worker', staffKeyId: 'synthetic-worker', warehouseId: 'synthetic-warehouse' };
const signed = (claims, age, duration) => jwt.sign({ ...claims, iat: now() - age }, process.env.JWT_SECRET, { expiresIn: duration });
async function authorize(token, state = { active: true, kind: 'worker', permissions: [] }) {
  keyState = state;
  forgetKey('worker', worker.staffKeyId);
  const req = { headers: { authorization: 'Bearer ' + token } };
  const result = { status: 200, headers: {}, authorized: false };
  const res = {
    set(name, value) { result.headers[name] = value; return this; },
    status(code) { result.status = code; return this; },
    json() { return this; },
  };
  await requireAuth(req, res, () => { result.authorized = true; result.auth = req.auth; });
  return result;
}

test('only the worker session lasts thirty days; other roles keep the configured duration', () => {
  const decoded = jwt.verify(signToken(worker), process.env.JWT_SECRET);
  assert.equal(decoded.exp - decoded.iat, 30 * 86400);
  for (const role of ['owner', 'manager', 'seller', 'integration']) {
    const claims = jwt.decode(signToken({ role }));
    assert.equal(claims.exp - claims.iat, 12 * 3600, role);
  }
});

test('returning worker stays signed in after a day and after a week without renewal loops', async () => {
  for (const age of [86400, 7 * 86400]) {
    const result = await authorize(signed(worker, age, WORKER_TOKEN_TTL_SECONDS));
    assert.equal(result.authorized, true);
    assert.equal(result.auth.warehouseId, worker.warehouseId);
    assert.equal(result.headers['X-Argus-Token'], undefined);
  }
});

test('legacy twelve-hour worker token upgrades immediately with identical identity', async () => {
  const result = await authorize(signed(worker, 60, 12 * 3600));
  assert.equal(result.authorized, true);
  const next = jwt.verify(result.headers['X-Argus-Token'], process.env.JWT_SECRET);
  assert.equal(next.exp - next.iat, WORKER_TOKEN_TTL_SECONDS);
  assert.equal(next.staffKeyId, worker.staffKeyId);
  assert.equal(next.warehouseId, worker.warehouseId);
  assert.equal(next.role, 'worker');
});

test('worker token past half its lifetime renews, an expired token cannot renew', async () => {
  const active = await authorize(signed(worker, 16 * 86400, WORKER_TOKEN_TTL_SECONDS));
  assert.equal(active.authorized, true);
  assert.equal(jwt.verify(active.headers['X-Argus-Token'], process.env.JWT_SECRET).exp - now(), WORKER_TOKEN_TTL_SECONDS);
  for (const [age, ttl] of [[31 * 86400, WORKER_TOKEN_TTL_SECONDS], [13 * 3600, 12 * 3600]]) {
    const expired = await authorize(signed(worker, age, ttl));
    assert.equal(expired.status, 401);
    assert.equal(expired.authorized, false);
    assert.equal(expired.headers['X-Argus-Token'], undefined);
  }
});

test('revoked and reassigned worker keys are rejected before extending any session', async () => {
  for (const state of [{ active: false, kind: 'worker' }, { active: true, kind: 'manager', permissions: ['staff'] }]) {
    for (const token of [signToken(worker), signed(worker, 60, 12 * 3600)]) {
      const result = await authorize(token, state);
      assert.equal(result.status, 401);
      assert.equal(result.authorized, false);
      assert.equal(result.headers['X-Argus-Token'], undefined);
    }
  }
});

test('forged worker claims never gain a long-lived renewal', async () => {
  const token = signToken(worker).split('.');
  token[1] = Buffer.from(JSON.stringify({ ...jwt.decode(token.join('.')), warehouseId: 'other-warehouse' })).toString('base64url');
  const result = await authorize(token.join('.'));
  assert.equal(result.status, 401);
  assert.equal(result.authorized, false);
  assert.equal(result.headers['X-Argus-Token'], undefined);
});
