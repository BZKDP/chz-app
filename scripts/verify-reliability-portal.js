'use strict';
// Run on the authorized portal host. Credentials are used in memory, never logged.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const root = 'C:\\ProgramData\\CHZPortal\\app';
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const payload = Buffer.from(JSON.stringify({ user: config.authUser, exp: Date.now() + 60000, nonce: crypto.randomUUID() })).toString('base64url');
const signature = crypto.createHmac('sha256', config.cookieSecret).update(payload).digest('base64url');
const headers = { cookie: `chz_session=${payload}.${signature}` };
async function read(route) {
  const response = await fetch('http://127.0.0.1:3040' + route, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
  return response;
}
(async () => {
  const status = await (await read('/api/status')).json();
  const orders = await (await read('/api/orders/summary')).json();
  const downloads = [];
  for (const order of orders.filter(item => item.printAllowed).slice(0, 2)) {
    const response = await read(`/api/order/${encodeURIComponent(order.id)}/labels-pdf`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Invalid PDF');
    downloads.push({ orderId: order.id, quantity: order.quantity, bytes: bytes.length, contentType: response.headers.get('content-type'), validPdf: true });
  }
  const app = await (await read('/app.js')).text();
  if (!app.includes('chzSingleIntent') || !app.includes('systemConnection')) throw new Error('Frontend update missing');
  console.log(JSON.stringify({ connection: status.connection, orderCount: orders.length, active: orders.filter(x => !['INTRODUCED','FAILED','ATTENTION'].includes(x.status)).map(x => ({ id: x.id, state: x.status })), downloads, frontendUpdated: true }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
