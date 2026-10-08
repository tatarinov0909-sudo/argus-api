// Factory only: no scheduler, marketplace synchronization, .env or external API.
// Provide explicit local test DATABASE_URL/ADMIN_DATABASE_URL and an output path
// outside this checkout for the synthetic login used by browser/emulator QA.
const fs = require('node:fs');
const path = require('node:path');
const { apiAt, fixture, must, requireTestDatabase } = require('../test/helpers/worker-fixture');
requireTestDatabase();
if (!process.env.JWT_SECRET) throw new Error('Provide a synthetic JWT_SECRET for this disposable stand');
const output = path.resolve(process.env.ARGUS_WORKER_FIXTURE_PATH || '');
const root = path.resolve(__dirname, '..');
if (!process.env.ARGUS_WORKER_FIXTURE_PATH || output === root || output.startsWith(root + path.sep)) {
  throw new Error('ARGUS_WORKER_FIXTURE_PATH must be outside the checkout');
}
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');
const port = Number(process.env.ARGUS_WORKER_PORT || 3110);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
const server = createApp().listen(port, '127.0.0.1', async () => {
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const api = apiAt(baseUrl);
    if (process.env.ARGUS_WORKER_REUSE_FIXTURE === '1' && fs.existsSync(output)) {
      const saved = JSON.parse(fs.readFileSync(output, 'utf8'));
      if (saved.synthetic !== true) throw new Error('Only a synthetic fixture can be reused');
      must(await api('POST', '/api/auth/staff/login', null, { keyCode: saved.keyCode }));
      console.log(`Worker API test stand ready at ${baseUrl}; reusing the existing synthetic fixture`);
      return;
    }
    const f = await fixture(api, 'ТЕСТ — приложение грузчика');
    const cells = [];
    for (const cell of f.cells) cells.push(must(await api('GET', `/api/worker/cells/${cell.id}/qr`, f.worker)));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ baseUrl, synthetic: true, keyCode: f.keyCode, warehouseId: f.warehouseId, companyId: f.companyId, invoice: f.invoice, cells }, null, 2));
    console.log(`Worker API test stand ready at ${baseUrl}; synthetic fixture saved outside checkout`);
  } catch (err) { console.error(err.message); server.close(); await pool.end(); process.exitCode = 1; }
});
async function stop() { await new Promise((resolve) => server.close(resolve)); await pool.end(); }
process.once('SIGINT', () => stop().then(() => process.exit(0)));
process.once('SIGTERM', () => stop().then(() => process.exit(0)));
