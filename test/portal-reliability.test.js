'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createTransport } = require('../src/bridge-transport');

test('isolated portal reports offline, unverified certificate and verified signer distinctly', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chz-portal-test-'));
  const config = { workerSecret: crypto.randomBytes(32).toString('hex'), cookieSecret: crypto.randomBytes(32).toString('hex'), authUser: 'fixture', authPasswordHash: 'unused:unused' };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data/portal-db.json'), JSON.stringify({
    nextJobId: 1, nextBatchId: 1, jobs: [], batches: [], audit: [], worker: {},
    catalog: ['00000000000001', '00000000000002'].map(gtin => ({ gtin, name: 'Fixture', signed: true, markReady: true, turnReady: true }))
  }));
  for (const file of ['server.js', 'worker-health.js']) fs.copyFileSync(path.join(__dirname, '../remote-site', file), path.join(root, file));
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: '0', NODE_PATH: path.join(__dirname, '../node_modules') }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { const closed = new Promise(resolve => child.once('exit', resolve)); child.kill(); await closed; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  // The production entry point reports the bound port, including an ephemeral test port.
  const url = await new Promise((resolve, reject) => {
    let out = '', err = '';
    const timer = setTimeout(() => reject(new Error('Portal fixture startup timeout: ' + err)), 10000);
    child.stderr.on('data', chunk => { err += chunk; });
    child.stdout.on('data', chunk => { out += chunk; const match = out.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Fixture exited: ' + code + ' ' + err)); });
  });
  const payload = Buffer.from(JSON.stringify({ user: 'fixture', exp: Date.now() + 60000 })).toString('base64url');
  const cookie = payload + '.' + crypto.createHmac('sha256', config.cookieSecret).update(payload).digest('base64url');
  async function status() {
    const response = await fetch(url + '/api/status', { headers: { cookie: 'chz_session=' + cookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    return response.json();
  }
  assert.equal((await status()).connection.code, 'OFFLINE');
  const transport = createTransport({ secret: config.workerSecret, workerId: 'fixture' });
  await transport.request('POST', url + '/api/chz-worker/heartbeat', { status: { version: 'fixture' } });
  let result = await status();
  assert.equal(result.connection.code, 'CHECKING');
  assert.equal(result.laptop.cert, false);
  await transport.request('POST', url + '/api/chz-worker/heartbeat', { status: { version: 'fixture', signer: { online: true, cert: true, csptest: true, certUntil: '2099-01-01', checkedAt: Date.now() } } });
  assert.equal((await status()).connection.code, 'ONLINE');
  // An old client's partial claim payload must not erase the signer telemetry.
  await transport.request('POST', url + '/api/chz-worker/jobs/claim', { status: { env: 'PROD' } });
  assert.equal((await status()).connection.code, 'ONLINE');
  await transport.request('POST', url + '/api/chz-worker/heartbeat', { status: { clockOffsetMs: 86400000 } });
  assert.equal((await status()).connection.code, 'CLOCK_SKEW');
  assert.equal((await fetch(url + '/health').then(r => r.json())).workerOnline, true);
  const headers = { cookie: 'chz_session=' + cookie, 'content-type': 'application/json' };
  const post = (route, body) => fetch(url + route, { method: 'POST', headers, body: JSON.stringify(body) });
  const list = () => fetch(url + '/api/orders/summary', { headers }).then(r => r.json());
  const rows = ['00000000000001', '00000000000002'].map(gtin => ({ gtin, quantity: 1, productionDate: '2025-01-01', expirationDate: '2099-01-01' }));
  const invalid = await post('/api/bulk-batches', { clientRequestId: 'bulk-fixture', items: [rows[0], { ...rows[1], quantity: 0 }] });
  assert.equal(invalid.status, 400);
  assert.equal((await list()).length, 0, 'an invalid row must not leave a partially queued batch');
  const created = await post('/api/bulk-batches', { clientRequestId: 'bulk-fixture', items: rows });
  assert.equal(created.status, 200);
  const repeated = await post('/api/bulk-batches', { clientRequestId: 'bulk-fixture', items: rows });
  assert.equal((await repeated.json()).batch.itemCount, 2);
  assert.equal((await list()).length, 2);
  const changed = await post('/api/bulk-batches', { clientRequestId: 'bulk-fixture', items: [{ ...rows[0], quantity: 2 }, rows[1]] });
  assert.equal(changed.status, 400);
  for (let i = 0; i < 2; i++) assert.equal((await post('/api/order', { ...rows[0], clientRequestId: 'single-fixture' })).status, 200);
  assert.equal((await list()).length, 3);
  assert.equal((await post('/api/order', { ...rows[0], quantity: 2, clientRequestId: 'single-fixture' })).status, 400);
  const claim = () => transport.request('POST', url + '/api/chz-worker/jobs/claim', { scheduler: 'steps-v1' });
  await transport.request('POST', url + '/api/chz-worker/maintenance', { pause: true });
  assert.equal((await claim()).job, null, 'installer drain prevents new claims');
  await transport.request('POST', url + '/api/chz-worker/maintenance', { pause: false });
  const first = (await claim()).job;
  const second = (await claim()).job;
  const third = (await claim()).job;
  assert.equal(new Set([first.id, second.id, third.id]).size, 3, 'pending first party must not hold later parties');
  assert.equal((await claim()).job, null, 'do not busy-poll during cooldown');
  const other = createTransport({ secret: config.workerSecret, workerId: 'other-office' });
  assert.equal((await other.request('POST', url + '/api/chz-worker/jobs/claim', { scheduler: 'steps-v1' })).job, null, 'do not migrate active jobs to a different local DB');
  await assert.rejects(transport.request('POST', url + '/api/chz-worker/jobs/' + first.id + '/defer', { leaseToken: 'wrong' }), /lease/i);
  for (let i = 0; i < 6; i++) await post('/api/order', { ...rows[0], clientRequestId: 'extra-' + i });
  for (let i = 0; i < 5; i++) assert.ok((await claim()).job);
  assert.equal((await claim()).job, null, 'at most eight active parties per worker');
  // Legacy clients remain sequential and resume the original party.
  const resumed = (await transport.request('POST', url + '/api/chz-worker/jobs/claim', {})).job;
  assert.equal(resumed.id, first.id);
  await assert.rejects(transport.request('POST', url + '/api/chz-worker/jobs/' + first.id + '/progress', { leaseToken: first.leaseToken, state: 'ORDER_CREATED' }), /lease/i);
  await transport.request('POST', url + '/api/chz-worker/jobs/' + resumed.id + '/progress', { leaseToken: resumed.leaseToken, state:'SUBMIT_UNKNOWN' });
  await transport.request('POST', url + '/api/chz-worker/heartbeat', { status: { clockOffsetMs:0, signatureRecoveryAvailable:true, signature:{blocked:true,checking:false,checkedAt:Date.now()} } });
  assert.equal((await status()).connection.code,'SIGNATURE_REQUIRED', 'cached certificate must not mask inaccessible private key');
  assert.equal((await claim()).job,null);
  const check = await (await post('/api/signature/recheck',{})).json();
  assert.equal(check.recovery.request.state,'QUEUED');
  const again = await (await post('/api/signature/recheck',{})).json();
  assert.equal(check.recovery.request.id,again.recovery.request.id,'double click is one diagnostic, not two');
  assert.equal((await claim()).signatureCheck.id,check.recovery.request.id);
  await transport.request('POST', url + '/api/chz-worker/heartbeat', {status:{signature:{blocked:false,checking:false,lastRequest:{id:check.recovery.request.id,ok:true,finishedAt:Date.now()}}}});
  assert.equal((await status()).signatureRecovery.request.state,'SUCCEEDED');
  assert.equal((await list()).find(x=>x.remoteJobId===first.id).status,'SUBMIT_UNKNOWN','button never resets ambiguous paid operations');
  assert.equal((await fetch(url+'/api/signature/recheck',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
});
