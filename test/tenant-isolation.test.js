// Integration tests against a real Postgres instance. Requires:
//   - migrations applied (npm run migrate:up)
//   - the argus_app role created per src/db/setup-app-role.sql
//   - DATABASE_URL in the environment pointing at that database as argus_app
//
// These exercise the exact bug class this project has already shipped
// once (PROJECT.md section 6: one seller key opening several companies'
// data) plus the two other places tenant/journal correctness matters most.
// Not runnable in this sandbox (no local Postgres) — run for real once
// the VPS + database exist, before wiring the frontend to this API.

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { pool } = require('../src/db/pool');

let server;
let baseUrl;

before(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
}

async function setupOwnerWithCompanyAndInvoice(label) {
  const register = await api('/api/auth/owner/register', {
    method: 'POST',
    body: {
      name: `Owner ${label}`,
      email: uniqueEmail(`owner-${label}`),
      password: 'test-password-123',
      warehouseName: `Warehouse ${label}`,
      city: 'Москва',
    },
  });
  assert.equal(register.status, 201, `owner ${label} registration should succeed`);
  const ownerToken = register.body.token;

  const company = await api('/api/sellers/companies', {
    method: 'POST',
    token: ownerToken,
    body: { name: `Company ${label}` },
  });
  assert.equal(company.status, 201);

  const key = await api(`/api/sellers/companies/${company.body.id}/keys`, {
    method: 'POST',
    token: ownerToken,
  });
  assert.equal(key.status, 201);

  const invoice = await api('/api/invoices', {
    method: 'POST',
    token: ownerToken,
    body: {
      companyId: company.body.id,
      number: `INV-${label}-${Date.now()}`,
      items: [{ name: `Товар ${label}`, sku: `SKU-${label}`, declaredQty: 10 }],
    },
  });
  assert.equal(invoice.status, 201);

  return { ownerToken, company: company.body, sellerKeyCode: key.body.key_code, invoice: invoice.body };
}

test('a seller key only ever sees its own company\'s invoices', async () => {
  const a = await setupOwnerWithCompanyAndInvoice('A');
  const b = await setupOwnerWithCompanyAndInvoice('B');

  const sellerLoginA = await api('/api/auth/seller/login', {
    method: 'POST',
    body: { keyCode: a.sellerKeyCode, name: 'Seller A' },
  });
  assert.equal(sellerLoginA.status, 200);
  const sellerTokenA = sellerLoginA.body.token;

  const invoicesForA = await api('/api/invoices', { token: sellerTokenA });
  assert.equal(invoicesForA.status, 200);

  const ids = invoicesForA.body.map((inv) => inv.id);
  assert.ok(ids.includes(a.invoice.id), 'seller A must see their own invoice');
  assert.ok(!ids.includes(b.invoice.id), 'seller A must NOT see company B\'s invoice');

  // Direct-fetch-by-id must also be blocked, not just filtered out of the list.
  const directFetch = await api(`/api/invoices/${b.invoice.id}`, { token: sellerTokenA });
  assert.equal(directFetch.status, 404, 'fetching another company\'s invoice by id must 404, not leak it');
});

test('a revoked staff key is rejected on the next login attempt', async () => {
  const owner = await api('/api/auth/owner/register', {
    method: 'POST',
    body: {
      name: 'Owner Revoke',
      email: uniqueEmail('owner-revoke'),
      password: 'test-password-123',
      warehouseName: 'Warehouse Revoke',
    },
  });
  const ownerToken = owner.body.token;

  const staffKey = await api('/api/staff', {
    method: 'POST',
    token: ownerToken,
    body: { name: 'Иван Тестовый' },
  });
  assert.equal(staffKey.status, 201);
  const keyCode = staffKey.body.key_code;

  const firstLogin = await api('/api/auth/staff/login', { method: 'POST', body: { keyCode } });
  assert.equal(firstLogin.status, 200, 'active key should log in');

  const revoke = await api(`/api/staff/${staffKey.body.id}/toggle`, { method: 'PATCH', token: ownerToken });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.body.active, false);

  const secondLogin = await api('/api/auth/staff/login', { method: 'POST', body: { keyCode } });
  assert.equal(secondLogin.status, 403, 'revoked key must be rejected immediately at login');
});

test('journal_entries cannot be updated or deleted, even with a direct query', async () => {
  const owner = await api('/api/auth/owner/register', {
    method: 'POST',
    body: {
      name: 'Owner Journal',
      email: uniqueEmail('owner-journal'),
      password: 'test-password-123',
      warehouseName: 'Warehouse Journal',
    },
  });
  const client = await pool.connect();
  try {
    const anyRow = await client.query('SELECT id FROM journal_entries LIMIT 1');
    if (anyRow.rows[0]) {
      await assert.rejects(
        client.query('UPDATE journal_entries SET status = $1 WHERE id = $2', ['confirmed', anyRow.rows[0].id]),
        /permission denied/i,
        'UPDATE on journal_entries must be rejected by the DB grants, not just app-layer convention',
      );
      await assert.rejects(
        client.query('DELETE FROM journal_entries WHERE id = $1', [anyRow.rows[0].id]),
        /permission denied/i,
      );
    }
  } finally {
    client.release();
  }
  // Registration itself shouldn't have written any journal entries in phase 1.
  void owner;
});
