const test = require('node:test');
const assert = require('node:assert/strict');

test('configured CORS keeps approved websites and permits the exact packaged Android origin', async () => {
  const saved = process.env.CORS_ORIGIN;
  process.env.CORS_ORIGIN = 'https://approved.example.invalid';
  const { createApp } = require('../src/app');
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    for (const [origin, expected] of [
      ['https://approved.example.invalid', true], ['https://localhost', true],
      ['https://unapproved.example.invalid', false], ['http://localhost', false], ['https://localhost.evil.invalid', false],
    ]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/staff/login`, {
        method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,x-argus-operation-id,x-argus-offline' },
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), expected ? origin : null);
    }
  } finally {
    if (saved === undefined) delete process.env.CORS_ORIGIN; else process.env.CORS_ORIGIN = saved;
    await new Promise((resolve) => server.close(resolve));
  }
});
