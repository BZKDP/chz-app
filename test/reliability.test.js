'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createTransport } = require('../src/bridge-transport');
const { authenticate, connectionHealth } = require('../remote-site/worker-health');
const secret = 'test-only-secret-not-a-production-key';

async function serverFor(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/heartbeat`;
}

test('four-day clock error recovers once with a new signed nonce; later wall-clock jumps do not break auth', async t => {
  let clock = Date.now() - 4 * 86400000, attempts = 0, accepted = 0;
  const nonces = new Map();
  const url = await serverFor(t, (req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      attempts++;
      const auth = authenticate({ method: req.method, path: req.url, headers: req.headers, body: JSON.parse(body), secret, nonces });
      if (!auth.status) accepted++;
      res.writeHead(auth.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(auth.status ? auth : { ok: true }));
    });
  });
  const client = createTransport({ workerId: 'test', secret, wallNow: () => clock, allowHttpClock: true });
  assert.equal((await client.request('POST', url, {})).ok, true);
  assert.equal(attempts, 2);
  assert.equal(accepted, 1);
  clock += 12 * 86400000;
  assert.equal((await client.request('POST', url, {})).ok, true);
  assert.equal(attempts, 3);
  assert.equal(accepted, 2);
});

test('lost response is not retried automatically', async t => {
  let attempts = 0;
  const url = await serverFor(t, (req, res) => { attempts++; res.writeHead(200); res.write('{'); setImmediate(() => res.destroy()); });
  const client = createTransport({ workerId: 'test', secret, timeoutMs: 300 });
  await assert.rejects(client.request('POST', url), /interrupted|hang up|reset/i);
  assert.equal(attempts, 1);
});

test('hung request times out and a later request recovers', async t => {
  let attempts = 0;
  const url = await serverFor(t, (_req, res) => { if (++attempts > 1) res.end('{"ok":true}'); });
  const client = createTransport({ workerId: 'test', secret, timeoutMs: 80 });
  await assert.rejects(client.request('POST', url), /timeout/);
  assert.equal((await client.request('POST', url)).ok, true);
});

test('authentication rejects forged signatures and nonce replay', () => {
  const now = Date.now(), timestamp = String(Math.floor(now / 1000)), nonce = 'test-nonce';
  const signed = ['POST', '/heartbeat', timestamp, nonce, crypto.createHash('sha256').update('{}').digest('hex')].join('\n');
  const headers = { 'x-chz-worker-id': 'test', 'x-chz-timestamp': timestamp, 'x-chz-nonce': nonce, 'x-chz-signature': crypto.createHmac('sha256', secret).update(signed).digest('hex') };
  const input = { method: 'POST', path: '/heartbeat', headers, body: {}, secret, nonces: new Map(), now };
  assert.equal(authenticate(input).workerId, 'test');
  assert.equal(authenticate(input).code, 'NONCE_REPLAY');
  assert.equal(authenticate({ ...input, secret: 'wrong' }).code, 'SIGNATURE_INVALID');
});

test('heartbeat alone is not proof of certificate readiness; expired and stale signer checks are reported', () => {
  const now = Date.now(), worker = { lastSeenAt: now, status: {} };
  assert.equal(connectionHealth(worker, now).code, 'CHECKING');
  worker.status.signer = { checkedAt: now, online: true, cert: true, csptest: true, certUntil: '2099-01-01' };
  assert.equal(connectionHealth(worker, now).code, 'ONLINE');
  worker.status.signer.certUntil = '2020-01-01';
  assert.equal(connectionHealth(worker, now).code, 'SIGNER_UNAVAILABLE');
  assert.equal(connectionHealth(worker, now + 50000).code, 'OFFLINE');
  worker.lastSeenAt = now + 180000;
  assert.equal(connectionHealth(worker, now + 180000).code, 'CHECKING');
});

test('atomic DB writes preserve history; corrupt existing DB never becomes an empty DB', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chz-db-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = { dataDir: root, dbFile: path.join(root, 'db.json') };
  function loadModule() {
    const sandbox = { module: { exports: {} }, require: name => name === './config' ? cfg : require(name) };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/db.js'), 'utf8'), sandbox);
    return sandbox.module.exports;
  }
  const db = loadModule();
  db.get();
  db.upsertOrder({ id: 'fixture', quantity: 2 });
  assert.equal(loadModule().get().orders[0].id, 'fixture');
  assert.equal(fs.existsSync(cfg.dbFile + '.tmp'), false);
  fs.writeFileSync(cfg.dbFile, '{bad');
  assert.throws(() => loadModule().get(), /processing stopped/);
  assert.equal(fs.readFileSync(cfg.dbFile, 'utf8'), '{bad');
});

test('resuming introduction after reboot does not submit utilisation again', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/bridge-worker.js'), 'utf8');
  const intent = { state: 'INTRODUCTION_PENDING', orderId: 'fixture', codes: ['fixture'], introductionDocumentId: 'fixture' };
  let introduced = 0;
  const sandbox = { module: { exports: {} }, console, setTimeout, clearTimeout, setInterval,
    require: name => {
      if (name === './config') return { bridge: { secret, workerId: 'test' } };
      if (name === './db') return { findAutomationIntent: () => intent };
      if (name === './bridge-transport') return require('../src/bridge-transport');
      if (name.startsWith('./')) return {};
      return require(name);
    }, intent, onIntroduction: () => { introduced++; } };
  vm.runInNewContext(source + '\nensureJobIsAllowed=()=>({}); prepareIntent=()=>intent; finishIntroduction=async()=>onIntroduction(); module.exports.resume=processJob;', sandbox);
  await sandbox.module.exports.resume({ state: 'INTRODUCTION_PENDING', clientRequestId: 'fixture' });
  assert.equal(introduced, 1);
});
