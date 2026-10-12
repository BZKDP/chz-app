'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const PDFDocument = require('pdfkit');
const { authenticate, connectionHealth } = require('./worker-health');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'portal-db.json');
const CONFIG_FILE = process.env.CHZ_PORTAL_CONFIG || path.join(ROOT, 'config.json');
const PUBLIC_DIR = path.join(ROOT, 'public');
const ARTIFACT_DIR = path.join(DATA_DIR, 'artifacts');
const PORT = Number(process.env.PORT || 3040);
const HOST = process.env.HOST || '127.0.0.1';
const ACTIVE_STATES = new Set([
  'REQUESTED', 'CLAIMED', 'SIGNER_READY', 'ORDER_SUBMITTING', 'ORDER_CREATED',
  'BUFFER_ACTIVE', 'CODES_RECEIVED', 'UTILISATION_SUBMITTING', 'UTILISATION_PENDING',
  'APPLIED', 'INTRODUCTION_SUBMITTING', 'INTRODUCTION_SUBMITTED', 'INTRODUCTION_PENDING'
]);
const TERMINAL_STATES = new Set(['INTRODUCED', 'FAILED', 'ATTENTION', 'SUBMIT_UNKNOWN', 'UTILISATION_UNKNOWN', 'INTRODUCTION_UNKNOWN']);
const TRANSITION_ORDER = [
  'REQUESTED', 'CLAIMED', 'SIGNER_READY', 'ORDER_SUBMITTING', 'ORDER_CREATED', 'BUFFER_ACTIVE',
  'CODES_RECEIVED', 'UTILISATION_SUBMITTING', 'UTILISATION_PENDING', 'APPLIED',
  'INTRODUCTION_SUBMITTING', 'INTRODUCTION_SUBMITTED', 'INTRODUCTION_PENDING', 'INTRODUCED'
];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error('Portal storage cannot be read; refusing to reset existing data', { cause: error });
  }
}

const config = readJson(CONFIG_FILE, {});
if (!config.workerSecret || String(config.workerSecret).length < 32) throw new Error('workerSecret is missing');
if (!config.cookieSecret || String(config.cookieSecret).length < 32) throw new Error('cookieSecret is missing');
if (!config.authUser || !config.authPasswordHash) throw new Error('portal credentials are missing');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
let db = readJson(DB_FILE, { version: 1, nextJobId: 1, nextBatchId: 1, jobs: [], batches: [], catalog: [], audit: [], worker: {} });
for (const key of ['jobs', 'batches', 'catalog', 'audit']) if (!Array.isArray(db[key])) db[key] = [];
if (!db.worker || typeof db.worker !== 'object') db.worker = {};

function save() {
  const tmp = `${DB_FILE}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(db, null, 2)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, DB_FILE);
}

function safeText(value, max = 500) {
  return String(value || '')
    .replace(/01\d{14}21[^\s,}"']+/g, '[код скрыт]')
    .replace(/[A-Za-z0-9+/=_-]{64,}/g, '[данные скрыты]')
    .slice(0, max);
}

function mm(value) { return value * 72 / 25.4; }

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function readLabelArtifact(job) {
  const artifact = path.join(ARTIFACT_DIR, `job-${job.id}.html.gz`);
  if (!fs.existsSync(artifact)) return null;
  const html = zlib.gunzipSync(fs.readFileSync(artifact)).toString('utf8');
  const labels = [];
  const re = /<figure[^>]*--dm:url\(data:image\/png;base64,([A-Za-z0-9+/=]+)\)[^>]*>[\s\S]*?<b>([\s\S]*?)<\/b>[\s\S]*?<span>([\s\S]*?)<\/span>[\s\S]*?<\/figure>/g;
  let match;
  while ((match = re.exec(html))) {
    labels.push({
      png: Buffer.from(match[1], 'base64'),
      name: decodeHtml(match[2].replace(/<[^>]+>/g, '')),
      index: decodeHtml(match[3].replace(/<[^>]+>/g, '')),
    });
  }
  return labels;
}

function sendLabelsPdf(res, job) {
  const labels = readLabelArtifact(job);
  if (!labels || !labels.length) {
    res.status(409).type('text').send('Офисный компьютер ещё готовит PDF. Обновите страницу через несколько секунд.');
    return;
  }

  const doc = new PDFDocument({
    autoFirstPage: false,
    info: {
      Title: `CHZ labels ${job.id}`,
      Creator: 'GrafLab CHZ Portal',
    },
  });
  const fontPath = fs.existsSync('C:\\Windows\\Fonts\\arial.ttf') ? 'C:\\Windows\\Fonts\\arial.ttf' : null;
  if (fontPath) doc.registerFont('label', fontPath);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `attachment; filename="labels-${job.id}.pdf"`);
  doc.pipe(res);

  const pageW = mm(58);
  const pageH = mm(40);
  const qr = mm(23);
  const leftX = mm(3);
  const rightX = mm(32);
  const qrY = mm(3.4);
  const textY = mm(28.2);
  const textH = mm(8);
  for (const label of labels) {
    const title = safeText(label.name || job.name || job.gtin, 90);
    doc.addPage({ size: [pageW, pageH], margin: 0 });
    doc.save().lineWidth(0.35).strokeColor('#B7B7B7').dash(1.5, { space: 1.5 }).moveTo(mm(29), mm(1)).lineTo(mm(29), pageH - mm(1)).stroke().undash().restore();
    doc.image(label.png, leftX, qrY, { width: qr, height: qr });
    doc.image(label.png, rightX, qrY, { width: qr, height: qr });
    doc.font(fontPath ? 'label' : 'Helvetica').fontSize(5.8).fillColor('#111111');
    doc.text(title, mm(1.2), textY, { width: mm(26.6), height: textH, align: 'center', lineGap: -1 });
    doc.text(title, mm(30.2), textY, { width: mm(26.6), height: textH, align: 'center', lineGap: -1 });
    doc.fontSize(4.7).fillColor('#8A8A8A').text(String(label.index || ''), pageW - mm(8), mm(0.9), { width: mm(7), align: 'right' });
  }
  doc.end();
}

function audit(type, details = {}) {
  db.audit.unshift({ at: Date.now(), type, ...details });
  db.audit = db.audit.slice(0, 2000);
  save();
}

function b64url(value) { return Buffer.from(value).toString('base64url'); }
function sign(value, secret = config.cookieSecret) { return crypto.createHmac('sha256', secret).update(value).digest('base64url'); }

function makeSession(user) {
  const payload = b64url(JSON.stringify({ user, exp: Date.now() + 12 * 60 * 60 * 1000, nonce: crypto.randomUUID() }));
  return `${payload}.${sign(payload)}`;
}

function parseCookies(header) {
  return Object.fromEntries(String(header || '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return index < 0 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function verifySession(req) {
  const token = parseCookies(req.headers.cookie).chz_session;
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = sign(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed.exp > Date.now() && parsed.user === config.authUser ? parsed : null;
  } catch (_) { return null; }
}

function verifyPassword(password) {
  const [salt, expected] = String(config.authPasswordHash).split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
  return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function loginPage(message = '') {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Вход · Честный ЗНАК</title><style>
  :root{font-family:Inter,Segoe UI,Arial,sans-serif;color:#171817;background:#f2f3ef}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(420px,100%);background:#fff;border:1px solid #d8dad4;padding:34px;box-shadow:0 18px 60px #18251b14}.mark{width:42px;height:42px;display:grid;place-items:center;background:#f2c94c;font-weight:900;margin-bottom:28px}h1{font-size:25px;margin:0 0 8px}p{color:#666a63;margin:0 0 25px}label{display:block;font-size:12px;font-weight:700;margin:15px 0 6px}input{width:100%;min-height:46px;border:1px solid #b9bcb4;padding:10px 12px;font:inherit;border-radius:5px}input:focus{outline:3px solid #4384ff44;border-color:#4384ff}button{width:100%;min-height:46px;margin-top:22px;border:0;border-radius:5px;background:#171817;color:#fff;font:700 15px inherit;cursor:pointer}.error{color:#8f1f27;background:#fff1f2;border-left:3px solid #c83d49;padding:10px;margin:0 0 18px;font-size:13px}.hint{font-size:11px;margin:18px 0 0;text-align:center}</style></head><body><main class="card"><div class="mark">ЧЗ</div><h1>Кабинет маркировки</h1><p>Войдите под учётной записью сотрудника.</p>${message ? `<div class="error" role="alert">${safeText(message, 160)}</div>` : ''}<form method="post" action="/login"><label for="user">Логин</label><input id="user" name="user" autocomplete="username" required autofocus><label for="password">Пароль</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Войти</button></form><p class="hint">Коды и электронная подпись хранятся только на офисном компьютере.</p></main></body></html>`;
}

function requireUser(req, res, next) {
  const session = verifySession(req);
  if (!session) {
    if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Сессия истекла. Войдите снова.' });
    return res.redirect('/login');
  }
  req.user = session.user;
  next();
}

function sameOrigin(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && origin !== config.publicOrigin) return res.status(403).json({ error: 'Недопустимый источник запроса' });
  next();
}

const nonces = new Map();
function verifyWorker(req, res, next) {
  const result = authenticate({ method: req.method, path: req.originalUrl, headers: req.headers, body: req.body, secret: config.workerSecret, nonces });
  if (result.status) {
    // Only record clock diagnostics after verifying the HMAC.
    if (result.code === 'CLOCK_SKEW' && Date.now() - Number(db.worker.lastAuthFailure?.at || 0) > 30000) {
      db.worker.lastAuthFailure = { at: Date.now(), code: result.code, skewMs: result.skewMs };
      save();
    }
    return res.status(result.status).json({ code: result.code, error: result.error, serverTime: Date.now() });
  }
  req.workerId = result.workerId;
  next();
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function cleanCatalog(items) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  return items.filter(item => /^\d{14}$/.test(String(item?.gtin || ''))).filter(item => !seen.has(String(item.gtin)) && seen.add(String(item.gtin))).slice(0, 5000).map(item => ({
    gtin: String(item.gtin),
    name: safeText(item.name || item.registeredName || item.gtin, 500),
    registeredName: safeText(item.registeredName || item.name || item.gtin, 500),
    brand: safeText(item.brand, 160) || null,
    stateRegistrationCertificate: safeText(item.stateRegistrationCertificate, 160) || null,
    packageType: safeText(item.packageType, 160) || null,
    productGroup: safeText(item.productGroup || 'bio', 30),
    signed: item.signed === true,
    markReady: item.markReady === true,
    turnReady: item.turnReady === true,
    isSet: item.isSet === true,
    isKit: item.isKit === true,
    bulkExcluded: item.bulkExcluded === true,
    bulkExcludedReason: safeText(item.bulkExcludedReason, 240) || null
  }));
}

function publicStatus(job) {
  const code = job.state;
  if (code === 'INTRODUCED') return { code: 'READY', label: 'Готово', tone: 'success', progress: 100, step: 5 };
  if (TERMINAL_STATES.has(code)) return { code: 'ATTENTION', label: 'Требуется проверка', tone: 'danger', progress: Math.min(95, Math.max(10, (TRANSITION_ORDER.indexOf(code) + 1) * 7)), step: 1 };
  if (/INTRODUCTION|APPLIED/.test(code)) return { code: 'INTRODUCTION', label: 'Вводим в оборот', tone: 'progress', progress: 80, step: 4 };
  if (/UTILISATION|CODES_RECEIVED/.test(code)) return { code: 'UTILISATION', label: 'Подтверждаем нанесение', tone: 'progress', progress: 60, step: 3 };
  if (/ORDER_CREATED|BUFFER_ACTIVE/.test(code)) return { code: 'CODES', label: 'Получаем коды', tone: 'progress', progress: 40, step: 2 };
  if (code === 'REQUESTED') return { code: 'QUEUED', label: 'В очереди', tone: 'neutral', progress: 5, step: 1 };
  return { code: 'ORDER', label: 'Формируем заказ', tone: 'progress', progress: 20, step: 1 };
}

function publicJob(job) {
  const artifactReady = job.state === 'INTRODUCED' && fs.existsSync(path.join(ARTIFACT_DIR, `job-${job.id}.html.gz`));
  const signaturePaused = ACTIVE_STATES.has(job.state) && db.worker.status?.signature?.blocked === true;
  return {
    id: `web-${job.id}`,
    remoteJobId: job.id,
    clientRequestId: job.clientRequestId,
    gtin: job.gtin,
    name: job.name,
    quantity: job.quantity,
    productionDate: job.productionDate,
    expirationDate: job.expirationDate,
    status: job.state,
    releaseMethodType: 'PRODUCTION',
    cisType: 'UNIT',
    automationMode: 'FULL',
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    publicStatus: signaturePaused ? { ...publicStatus(job), label: 'Ожидаем подключения ЭЦП', tone: 'warning' } : publicStatus(job),
    printAllowed: artifactReady,
    activity: Array.isArray(job.activity) ? job.activity.slice(0, 20) : [],
    automationLastError: job.error || null,
    connectionPaused: ACTIVE_STATES.has(job.state) && !connectionHealth(db.worker).online,
    waitingNote: ACTIVE_STATES.has(job.state) && !connectionHealth(db.worker).online ? 'Ожидаем ПК ЧЗ. Этап сохранён; повторно создавать партию не нужно.' : signaturePaused ? 'Подключите флешку ЭЦП к офисному ПК и нажмите кнопку проверки выше. Эта партия продолжится с сохранённого этапа.' : job.pollError ? 'Временная ошибка проверки. Повторим автоматически: ' + job.pollError : null
  };
}

function createJob(input, actor, batchId = null, persist = true, validateOnly = false) {
  const gtin = String(input.gtin || '');
  const quantity = Number(input.quantity);
  const productionDate = String(input.productionDate || '').slice(0, 10);
  const expirationDate = String(input.expirationDate || '').slice(0, 10);
  const clientRequestId = String(input.clientRequestId || crypto.randomUUID()).slice(0, 200);
  const duplicate = db.jobs.find(item => item.clientRequestId === clientRequestId);
  if (duplicate) {
    if (duplicate.gtin !== gtin || duplicate.quantity !== quantity || duplicate.productionDate !== productionDate || duplicate.expirationDate !== expirationDate) {
      throw new Error('Этот запрос уже создан с другими параметрами. Проверьте существующую партию.');
    }
    return duplicate;
  }
  const product = db.catalog.find(item => item.gtin === gtin);
  if (!product || product.isSet || product.isKit || product.bulkExcluded) throw new Error('Товар отсутствует в разрешённом каталоге');
  if (!product.signed || !product.markReady || !product.turnReady) throw new Error('Карточка товара не готова к выпуску и вводу в оборот');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > Number(config.maxQuantity || 5000)) throw new Error('Количество должно быть от 1 до 5000');
  if (!validDate(productionDate) || !validDate(expirationDate) || expirationDate <= productionDate) throw new Error('Проверьте даты партии');
  if (productionDate > new Date().toISOString().slice(0, 10)) throw new Error('Дата производства не может быть в будущем');
  if (validateOnly) return null;
  const before = persist ? structuredClone(db) : null;
  const id = Number(db.nextJobId || 1);
  db.nextJobId = id + 1;
  const job = {
    id, batchId, clientRequestId, gtin, quantity, productionDate, expirationDate,
    name: product.registeredName || product.name || gtin,
    templateId: 30, releaseMethodType: 'PRODUCTION', paymentType: 1,
    marketplace: 'CHZ_PORTAL', entityId: `web-${id}`, basisKey: gtin,
    allocations: Array.from({ length: quantity }, (_, index) => ({ orderId: `web-${id}`, unitIndex: index + 1, codeIndex: index })),
    state: 'REQUESTED', createdAt: Date.now(), updatedAt: Date.now(), createdBy: actor,
    activity: [{ key: 'requested', label: 'Задание поставлено в очередь', tone: 'progress', at: Date.now() }]
  };
  db.jobs.push(job);
  db.audit.unshift({ at: Date.now(), type: 'job.created', jobId: id, actor, gtin, quantity });
  db.audit = db.audit.slice(0, 2000);
  if (persist) {
    try { save(); } catch (error) { db = before; throw error; }
  }
  return job;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use('/api/chz-worker', express.json({ limit: '32mb' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
});

app.get('/health', (_req, res) => res.set('Cache-Control', 'no-store').json({ ok: true, workerOnline: connectionHealth(db.worker).online, serverTime: Date.now(), version: '2026.10.05.2' }));

app.get('/login', (req, res) => verifySession(req) ? res.redirect('/') : res.type('html').send(loginPage()));
app.post('/login', (req, res) => {
  const ip = String(req.ip || 'unknown');
  const attempts = db.audit.filter(item => item.type === 'login.failed' && item.ip === ip && Date.now() - item.at < 15 * 60 * 1000).length;
  if (attempts >= 10) return res.status(429).type('html').send(loginPage('Слишком много попыток. Подождите 15 минут.'));
  if (String(req.body.user || '') !== config.authUser || !verifyPassword(req.body.password)) {
    audit('login.failed', { ip });
    return res.status(401).type('html').send(loginPage('Неверный логин или пароль.'));
  }
  audit('login.success', { ip, actor: config.authUser });
  res.setHeader('Set-Cookie', `chz_session=${encodeURIComponent(makeSession(config.authUser))}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`);
  res.redirect('/');
});
app.post('/logout', requireUser, (_req, res) => {
  res.setHeader('Set-Cookie', 'chz_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  res.redirect('/login');
});

app.post('/api/chz-worker/heartbeat', verifyWorker, (req, res) => {
  db.worker = {
    ...db.worker,
    id: req.workerId,
    lastSeenAt: Date.now(),
    status: { ...db.worker.status, ...req.body.status },
  };
  save();
  res.json({ ok: true, serverTime: Date.now() });
});

app.post('/api/chz-worker/jobs/claim', verifyWorker, (req, res) => {
  if (req.body.catalog) {
    const catalog = cleanCatalog(req.body.catalog);
    if (catalog.length) db.catalog = catalog;
  }
  db.worker = { ...db.worker, id: req.workerId, lastSeenAt: Date.now(), status: { ...db.worker.status, ...req.body.status } };
  const now = Date.now();
  if (Number(db.worker.pauseClaimsUntil || 0) > now) {
    save(); return res.json({ ok: true, job: null, artifactRequests: [] });
  }
  const signatureCheck = db.signatureCheck && db.signatureCheck.id !== db.worker.status?.signature?.lastRequest?.id
    ? { id: db.signatureCheck.id } : null;
  const artifactRequests = db.jobs
    .filter(item => item.state === 'INTRODUCED' && !fs.existsSync(path.join(ARTIFACT_DIR, `job-${item.id}.html.gz`)))
    .slice(0, 3)
    .map(item => ({ id: item.id, clientRequestId: item.clientRequestId }));
  if (signatureCheck || db.worker.status?.signature?.blocked || db.worker.status?.signature?.checking) {
    save(); return res.json({ ok: true, job: null, artifactRequests, signatureCheck });
  }
  // Resume this worker's durable job before taking a new one. Never hand a
  // partially submitted paid order to another computer with a different DB.
  const stepped = req.body.scheduler === 'steps-v1';
  const ownActive = db.jobs.filter(item => ACTIVE_STATES.has(item.state) && item.workerId === req.workerId);
  // Only new workers opt in. Legacy workers keep their full-lifecycle claim.
  // Keep the signer serial, but let up to eight parties wait in CHZ concurrently.
  const job = stepped
    ? db.jobs.filter(item => (ownActive.includes(item) || (ownActive.length < 8 && item.state === 'REQUESTED'))
        && Number(item.nextPollAt || 0) <= now)
        .sort((a, b) => Number(a.lastScheduledAt || 0) - Number(b.lastScheduledAt || 0) || a.id - b.id)[0]
    : ownActive[0] || db.jobs.find(item => item.state === 'REQUESTED');
  if (!job) { save(); return res.json({ ok: true, job: null, artifactRequests }); }
  if (job.state === 'REQUESTED') {
    job.state = 'CLAIMED';
    job.activity.unshift({ key: 'claimed', label: 'Офисный компьютер принял задание', tone: 'progress', at: now });
  }
  job.leaseToken = crypto.randomUUID();
  job.leaseUntil = now + 60 * 60 * 1000;
  job.workerId = req.workerId;
  if (stepped) { job.lastScheduledAt = now; job.nextPollAt = now + 10000; }
  job.updatedAt = now;
  save();
  res.json({ ok: true, job: { ...job }, artifactRequests });
});

// Bounded drain for the workstation installer: no new claims during replacement.
// Existing job progress/heartbeats remain accepted. Automatically expires.
app.post('/api/chz-worker/maintenance', verifyWorker, (req, res) => {
  if (db.worker.id && db.worker.id !== req.workerId) return res.status(409).json({ error: 'Worker does not own this connection' });
  db.worker.pauseClaimsUntil = req.body.pause === true ? Date.now() + 180000 : 0;
  save();
  res.json({ ok: true, pauseClaimsUntil: db.worker.pauseClaimsUntil });
});

app.post('/api/chz-worker/jobs/:id/defer', verifyWorker, (req, res) => {
  const job = db.jobs.find(item => item.id === Number(req.params.id));
  if (!job || !req.body.leaseToken || job.leaseToken !== req.body.leaseToken || job.workerId !== req.workerId) {
    return res.status(409).json({ error: 'Worker lease is not valid' });
  }
  job.pollFailures = Math.min(6, Number(job.pollFailures || 0) + 1);
  job.nextPollAt = Date.now() + Math.min(60000, 2000 * (2 ** job.pollFailures));
  job.pollError = safeText(req.body.error || 'Повторная проверка запланирована', 800);
  save();
  res.json({ ok: true });
});

app.post('/api/chz-worker/jobs/:id/artifact', verifyWorker, (req, res) => {
  const job = db.jobs.find(item => item.id === Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.state !== 'INTRODUCED') return res.status(409).json({ error: 'Labels are available only after INTRODUCED' });
  if (job.workerId && job.workerId !== req.workerId) return res.status(409).json({ error: 'Worker does not own this job' });
  if (req.body.mimeType !== 'text/html; charset=utf-8' || req.body.encoding !== 'gzip') return res.status(400).json({ error: 'Unsupported artifact format' });
  const content = Buffer.from(String(req.body.contentBase64 || ''), 'base64');
  if (!content.length || content.length > 24 * 1024 * 1024) return res.status(413).json({ error: 'Artifact size is invalid' });
  const digest = crypto.createHash('sha256').update(content).digest('hex');
  if (digest !== String(req.body.sha256 || '')) return res.status(400).json({ error: 'Artifact checksum mismatch' });
  const target = path.join(ARTIFACT_DIR, `job-${job.id}.html.gz`);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, target);
  job.artifact = { readyAt: Date.now(), sha256: digest, size: content.length, labelCount: Number(req.body.labelCount || job.quantity) };
  job.updatedAt = Date.now();
  save();
  audit('job.artifact.ready', { jobId: job.id, workerId: req.workerId, labelCount: job.artifact.labelCount });
  res.json({ ok: true, ready: true });
});

app.post('/api/chz-worker/jobs/:id/progress', verifyWorker, (req, res) => {
  const job = db.jobs.find(item => item.id === Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!req.body.leaseToken || req.body.leaseToken !== job.leaseToken || req.workerId !== job.workerId) return res.status(409).json({ error: 'Worker lease is not valid' });
  const state = String(req.body.state || '');
  const allowed = new Set([...TRANSITION_ORDER, ...TERMINAL_STATES]);
  if (!allowed.has(state)) return res.status(400).json({ error: 'Unknown job state' });
  const oldIndex = TRANSITION_ORDER.indexOf(job.state);
  const newIndex = TRANSITION_ORDER.indexOf(state);
  if (newIndex >= 0 && oldIndex >= 0 && newIndex < oldIndex) return res.status(409).json({ error: 'State rollback is forbidden' });
  if (state !== job.state) job.activity.unshift({ key: state.toLowerCase(), label: publicStatus({ state }).label, tone: state === 'INTRODUCED' ? 'success' : TERMINAL_STATES.has(state) ? 'error' : 'progress', at: Date.now() });
  job.state = state;
  job.pollFailures = 0;
  job.pollError = null;
  job.updatedAt = Date.now();
  job.leaseUntil = TERMINAL_STATES.has(state) ? null : Date.now() + 60 * 60 * 1000;
  if (req.body.externalOrderId) job.externalOrderId = safeText(req.body.externalOrderId, 160);
  if (req.body.externalReportId) job.externalReportId = safeText(req.body.externalReportId, 160);
  if (req.body.error) job.error = safeText(req.body.error, 800);
  save();
  res.json({ ok: true, job: { id: job.id, state: job.state, leaseToken: job.leaseToken } });
});

app.post('/api/chz-worker/jobs/:id/print', verifyWorker, (req, res) => {
  const job = db.jobs.find(item => item.id === Number(req.params.id));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  job.print = { at: Date.now(), ok: req.body.ok !== false, attemptId: safeText(req.body.attemptId, 160), workstation: safeText(req.body.workstation, 160) };
  save();
  res.json({ ok: true });
});

app.use('/api', requireUser, sameOrigin);
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

function signatureRecoveryStatus() {
  const signature = db.worker.status?.signature || {};
  const request = db.signatureCheck;
  const completed = request && signature.lastRequest?.id === request.id;
  return { supported: db.worker.status?.signatureRecoveryAvailable === true,
    blocked: signature.blocked === true, checking: signature.checking === true,
    checkedAt: signature.checkedAt || null, lastSuccessAt: signature.lastSuccessAt || null,
    request: request ? { id: request.id, requestedAt: request.requestedAt,
      state: completed ? (signature.lastRequest.ok ? 'SUCCEEDED' : 'FAILED') : signature.checking ? 'CHECKING' : 'QUEUED',
      finishedAt: completed ? signature.lastRequest.finishedAt : null } : null };
}

app.post('/api/signature/recheck', (req, res) => {
  const status = signatureRecoveryStatus();
  if (!status.supported) return res.status(409).json({ error: 'Для проверки требуется обновление программы на ПК ЧЗ. Обратитесь к администратору.' });
  if (status.request && ['QUEUED', 'CHECKING'].includes(status.request.state)) return res.json({ ok: true, recovery: status });
  if (status.request && Date.now() - status.request.requestedAt < 15000) return res.status(429).json({ error: 'Подождите несколько секунд перед повторной проверкой.' });
  db.signatureCheck = { id: crypto.randomUUID(), requestedAt: Date.now(), requestedBy: req.user };
  save();
  audit('signature.recheck.requested', { requestId: db.signatureCheck.id });
  res.json({ ok: true, recovery: signatureRecoveryStatus() });
});

app.get('/api/status', (_req, res) => {
  const connection = connectionHealth(db.worker);
  const online = connection.online;
  const signer = db.worker.status?.signer;
  const freshSigner = online && !['CHECKING', 'CLOCK_SKEW'].includes(connection.code);
  const activeCount = db.jobs.filter(job => ACTIVE_STATES.has(job.state)).length;
  res.json({
    env: 'PROD', productGroup: 'bio', tariff: { netKop: 50, vatPercent: 22, grossKop: 61 },
    connection,
    signatureRecovery: signatureRecoveryStatus(),
    laptop: { online, csptest: freshSigner && signer?.csptest === true, cert: freshSigner && signer?.cert === true, certUntil: signer?.certUntil || null, error: connection.code === 'ONLINE' ? null : connection.note },
    token: { valid: online && db.worker.status?.token?.valid === true },
    orderAutomation: { enabled: online, activeCount, attentionCount: db.jobs.filter(job => TERMINAL_STATES.has(job.state) && job.state !== 'INTRODUCED').length },
    bulkOrderWorker: { enabled: online, activeCount: db.batches.filter(batch => batchSummary(batch).state !== 'DONE').length },
    bridge: { enabled: true, workerId: db.worker.id || null, lastPollAt: db.worker.lastSeenAt || null, version: db.worker.status?.version || null }
  });
});

app.get('/api/catalog', (_req, res) => res.json({ ok: db.catalog.length > 0, source: 'Офисный компьютер · Честный ЗНАК', syncedAt: db.worker.lastSeenAt || null, products: db.catalog, error: db.catalog.length ? null : 'Ожидаем первую синхронизацию с офисным компьютером' }));
app.get('/api/products/:gtin/readiness', (req, res) => {
  const product = db.catalog.find(item => item.gtin === String(req.params.gtin));
  if (!product) return res.status(404).json({ error: 'Товар не найден' });
  res.json({ ok: true, signed: product.signed, markReady: product.markReady, turnReady: product.turnReady, vetControlled: false });
});

const uiJobs = new Map();
app.post('/api/order', (req, res) => {
  try {
    const job = createJob(req.body || {}, req.user);
    const uiId = crypto.randomUUID();
    uiJobs.set(uiId, { at: Date.now(), result: { ok: true, orderId: `web-${job.id}`, queued: true } });
    res.json({ jobId: uiId });
  } catch (error) { res.status(400).json({ error: safeText(error.message, 500) }); }
});

app.get('/api/jobs/:id/events', (req, res) => {
  const ui = uiJobs.get(req.params.id);
  if (!ui) return res.status(404).end();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write(`event: progress\ndata: ${JSON.stringify({ stage: 'Задание добавлено в защищённую очередь' })}\n\n`);
  res.write(`event: result\ndata: ${JSON.stringify(ui.result)}\n\n`);
  res.end();
  uiJobs.delete(req.params.id);
});

app.get('/api/orders/summary', (_req, res) => res.json(db.jobs.slice().sort((a, b) => b.createdAt - a.createdAt).map(publicJob)));

app.post('/api/bulk-batches', (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length || items.length > 500) throw new Error('Выберите хотя бы один товар');
    const clientRequestId = String(req.body.clientRequestId || crypto.randomUUID()).slice(0, 180);
    if (new Set(items.map(item => String(item.gtin))).size !== items.length) throw new Error('Один товар указан несколько раз. Объедините его в одну строку.');
    const fingerprint = rows => JSON.stringify(rows.map(item => [String(item.gtin), Number(item.quantity), String(item.productionDate).slice(0, 10), String(item.expirationDate).slice(0, 10)]).sort((a, b) => a[0].localeCompare(b[0])));
    const duplicate = db.batches.find(item => item.clientRequestId === clientRequestId);
    if (duplicate) {
      const existing = duplicate.jobIds.map(id => db.jobs.find(job => job.id === id)).filter(Boolean);
      if (fingerprint(existing) !== fingerprint(items)) throw new Error('Этот массовый запрос уже создан с другим составом. Проверьте список партий.');
      return res.json({ ok: true, batch: batchSummary(duplicate) });
    }
    // Validate every row before creating anything; commit the entire batch once.
    for (const item of items) createJob({ ...item, clientRequestId: `${clientRequestId}:${String(item.gtin)}` }, req.user, null, false, true);
    const before = structuredClone(db);
    try {
    const id = Number(db.nextBatchId || 1);
    db.nextBatchId = id + 1;
    const batch = { id, clientRequestId, createdAt: Date.now(), createdBy: req.user, state: 'QUEUED', jobIds: [] };
    for (const item of items) {
      const job = createJob({ ...item, clientRequestId: `${clientRequestId}:${String(item.gtin)}` }, req.user, id, false);
      batch.jobIds.push(job.id);
    }
    db.batches.push(batch);
    save();
    res.json({ ok: true, batch: batchSummary(batch) });
    } catch (error) { db = before; throw error; }
  } catch (error) { res.status(400).json({ error: safeText(error.message, 500) }); }
});

function batchSummary(batch) {
  const jobs = batch.jobIds.map(id => db.jobs.find(job => job.id === id)).filter(Boolean);
  const readyCount = jobs.filter(job => job.state === 'INTRODUCED').length;
  const attentionCount = jobs.filter(job => TERMINAL_STATES.has(job.state) && job.state !== 'INTRODUCED').length;
  const state = attentionCount ? 'ATTENTION' : readyCount === jobs.length && jobs.length ? 'DONE' : 'RUNNING';
  return {
    id: batch.id, createdAt: batch.createdAt, state, itemCount: jobs.length,
    totalQuantity: jobs.reduce((sum, job) => sum + job.quantity, 0),
    totalCostKop: jobs.reduce((sum, job) => sum + job.quantity * 61, 0),
    readyCount, issuedCount: jobs.filter(job => job.state !== 'REQUESTED').length,
    publicStatus: state === 'DONE' ? { label: 'Готово', tone: 'success' } : state === 'ATTENTION' ? { label: 'Нужна проверка', tone: 'danger' } : { label: 'В работе', tone: 'progress' }
  };
}

app.get('/api/bulk-batches/summary', (_req, res) => res.json(db.batches.slice().sort((a, b) => b.createdAt - a.createdAt).map(batchSummary)));

app.get('/api/order/:id/labels', (req, res) => {
  const id = Number(String(req.params.id || '').replace(/^web-/, ''));
  const job = db.jobs.find(item => item.id === id);
  if (!job) return res.status(404).type('text').send('Партия не найдена.');
  if (job.state !== 'INTRODUCED') return res.status(409).type('text').send('Этикетки появятся после ввода кодов в оборот.');
  const artifact = path.join(ARTIFACT_DIR, `job-${job.id}.html.gz`);
  if (!fs.existsSync(artifact)) return res.status(409).type('text').send('Офисный компьютер ещё готовит предпросмотр. Обновите страницу через несколько секунд.');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Encoding', 'gzip');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', `inline; filename="labels-${job.id}.html"`);
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  fs.createReadStream(artifact).pipe(res);
});

app.get('/api/order/:id/labels.pdf', (req, res) => {
  const id = Number(String(req.params.id || '').replace(/^web-/, ''));
  const job = db.jobs.find(item => item.id === id);
  if (!job) return res.status(404).type('text').send('Партия не найдена.');
  if (job.state !== 'INTRODUCED') return res.status(409).type('text').send('PDF появится после ввода кодов в оборот.');
  sendLabelsPdf(res, job);
});

app.get('/api/order/:id/labels-pdf', (req, res) => {
  const id = Number(String(req.params.id || '').replace(/^web-/, ''));
  const job = db.jobs.find(item => item.id === id);
  if (!job) return res.status(404).type('text').send('Партия не найдена.');
  if (job.state !== 'INTRODUCED') return res.status(409).type('text').send('PDF появится после ввода кодов в оборот.');
  sendLabelsPdf(res, job);
});
app.use('/assets', express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));
app.get('/app.js', requireUser, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'app.js')));
app.get('/styles.css', requireUser, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'styles.css')));
app.get('/', requireUser, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('*', requireUser, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of uiJobs) if (now - job.at > 10 * 60 * 1000) uiJobs.delete(id);
}, 60000).unref();

const listener = app.listen(PORT, HOST, () => console.log(`CHZ employee portal listening on http://${HOST}:${listener.address().port}`));
