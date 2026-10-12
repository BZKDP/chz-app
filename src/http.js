'use strict';
// HTTP на core-модуле https (надёжнее undici fetch, который периодически даёт connect-timeout к ЧЗ).
const https = require('https');

function request(method, url, { headers = {}, body, timeoutMs = 25000, retries = 4 } = {}) {
  return new Promise(resolve => {
    const u = new URL(url);
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    let attempt = 0;
    const tryOnce = () => {
      attempt++;
      const h = Object.assign({}, headers);
      if (data != null) h['Content-Length'] = Buffer.byteLength(data);
      const req = https.request({ host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers: h }, res => {
        let b = '';
        res.on('data', d => b += d);
        res.on('end', () => {
          let json = null; try { json = b ? JSON.parse(b) : null; } catch (_) {}
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, json, text: b });
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
      req.on('error', e => {
        if (attempt < retries) setTimeout(tryOnce, 700 * attempt);
        else resolve({ status: 0, ok: false, json: null, text: 'NETWORK: ' + (e.code || e.message) });
      });
      if (data != null) req.write(data);
      req.end();
    };
    tryOnce();
  });
}

module.exports = { request };
