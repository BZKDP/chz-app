'use strict';
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { performance } = require('perf_hooks');

// Only the timestamp used for bridge authentication is corrected. Product dates
// and the Windows clock are never changed here. TLS validation stays enabled.
function createTransport({ secret, workerId, timeoutMs = 30000, wallNow = Date.now, monoNow = () => performance.now(), allowHttpClock = false }) {
  let anchor = null;
  let lastClockSyncAt = null;
  const now = () => anchor ? anchor.server + monoNow() - anchor.mono : wallNow();
  function clockStatus() {
    return { clockOffsetMs: anchor ? Math.round(now() - wallNow()) : 0, lastClockSyncAt };
  }
  async function request(method, url, body = {}, retried = false) {
    const target = new URL(url);
    const result = await new Promise((resolve, reject) => {
      const bodyText = JSON.stringify(body);
      const timestamp = String(Math.floor(now() / 1000));
      const nonce = crypto.randomUUID();
      const signed = [method.toUpperCase(), target.pathname + target.search, timestamp, nonce,
        crypto.createHash('sha256').update(bodyText).digest('hex')].join('\n');
      let settled = false;
      let timer;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      const req = (target.protocol === 'https:' ? https : http).request(target, {
        method, agent: false, headers: {
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyText),
          'X-CHZ-Worker-Id': workerId, 'X-CHZ-Timestamp': timestamp, 'X-CHZ-Nonce': nonce,
          'X-CHZ-Signature': crypto.createHmac('sha256', secret).update(signed).digest('hex')
        }
      }, res => {
        const serverTime = Date.parse(res.headers.date || '');
        if ((target.protocol === 'https:' || allowHttpClock) && Number.isFinite(serverTime)) {
          anchor = { server: serverTime, mono: monoNow() };
          lastClockSyncAt = serverTime;
        }
        let raw = '';
        res.on('data', chunk => {
          raw += chunk;
          if (Buffer.byteLength(raw) > 8 * 1024 * 1024) req.destroy(new Error('Bridge response too large'));
        });
        res.on('aborted', () => finish(new Error('Bridge response interrupted')));
        res.on('error', error => finish(error));
        res.on('end', () => {
          let data;
          try { data = raw ? JSON.parse(raw) : {}; }
          catch (_) { finish(new Error('Bridge returned invalid JSON')); return; }
          finish(null, { status: res.statusCode, data });
        });
      });
      timer = setTimeout(() => {
        const error = new Error('Bridge request timeout');
        finish(error);
        req.destroy(error);
      }, timeoutMs);
      req.on('error', error => finish(error));
      req.end(bodyText);
    });
    // This rejection occurs before the server invokes any job handler. No other
    // POST is replayed automatically (a lost reply may hide a committed action).
    if (result.status === 401 && result.data.code === 'CLOCK_SKEW' && anchor && !retried) {
      return request(method, url, body, true);
    }
    if (result.status < 200 || result.status >= 300) {
      const error = new Error(result.data.error || `Bridge HTTP ${result.status}`);
      error.code = result.data.code || `HTTP_${result.status}`;
      throw error;
    }
    return result.data;
  }
  return { request, clockStatus };
}
module.exports = { createTransport };
