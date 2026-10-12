const crypto = require('crypto');
const http = require('http');
const https = require('https');

const cfg = require('../src/config');
const db = require('../src/db');
const bridgeWorker = require('../src/bridge-worker');

const jobId = process.argv[2];
const clientRequestId = process.argv[3];
const leaseToken = process.argv[4];

if (!jobId || !clientRequestId || !leaseToken) {
  throw new Error('Usage: node replay-worker-job.js <jobId> <clientRequestId> <leaseToken>');
}

function requestJson(method, url, body = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const bodyText = JSON.stringify(body || {});
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID();
    const bodyHash = crypto.createHash('sha256').update(bodyText).digest('hex');
    const signed = [method.toUpperCase(), target.pathname + target.search, timestamp, nonce, bodyHash].join('\n');
    const signature = crypto.createHmac('sha256', cfg.bridge.secret).update(signed).digest('hex');
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyText),
        'X-CHZ-Worker-Id': cfg.bridge.workerId,
        'X-CHZ-Timestamp': timestamp,
        'X-CHZ-Nonce': nonce,
        'X-CHZ-Signature': signature,
      },
      timeout: 25000,
    }, response => {
      let raw = '';
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (_) {}
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(parsed?.error || `HTTP ${response.statusCode}: ${raw.slice(0, 500)}`));
          return;
        }
        resolve(parsed || {});
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(bodyText);
    req.end();
  });
}

async function main() {
  const intent = db.findAutomationIntent(clientRequestId);
  if (!intent) throw new Error(`Intent not found: ${clientRequestId}`);
  if (intent.state !== 'INTRODUCED') throw new Error(`Intent is not INTRODUCED: ${intent.state}`);
  if (!Array.isArray(intent.codes) || intent.codes.length !== Number(intent.quantity)) {
    throw new Error(`Codes are incomplete: ${intent.codes?.length || 0}/${intent.quantity}`);
  }

  const progress = await requestJson('POST', `${cfg.bridge.url}/jobs/${encodeURIComponent(jobId)}/progress`, {
    leaseToken,
    state: 'INTRODUCED',
    externalOrderId: intent.orderId,
    externalReportId: intent.introductionDocumentId,
  });

  const artifact = await bridgeWorker.renderLabelsArtifact(intent);
  const uploaded = await requestJson('POST', `${cfg.bridge.url}/jobs/${encodeURIComponent(jobId)}/artifact`, artifact);
  db.upsertAutomationIntent({ clientRequestId, artifactUploadedAt: Date.now(), artifactSha256: artifact.sha256 });

  console.log(JSON.stringify({
    ok: true,
    progressState: progress.job?.state,
    artifactReady: uploaded.ready === true,
    labelCount: artifact.labelCount,
    sha256: artifact.sha256,
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
