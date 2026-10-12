'use strict';
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const bwipjs = require('bwip-js');
const cfg = require('./config');
const db = require('./db');
const suz = require('./suz');
const trueapi = require('./trueapi');
const signer = require('./signer');
const jobs = require('./jobs');
const bridgeWorker = require('./bridge-worker');
const orderAutomation = require('./order-automation');
const bulkOrderWorker = require('./bulk-order-worker');
const catalogService = require('./catalog-service');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

db.load();
function settings() { const d = db.get(); if (!d.settings) { d.settings = { balanceKop: 0 }; db.save(); } return d.settings; }

// ---------- helpers ----------
function spentTotalKop() {
  return db.get().operations.filter(o => o.type === 'order').reduce((s, o) => s + (o.spendKop || 0), 0);
}
function kopToRub(k) { return (k / 100).toFixed(2); }

function localDateIso(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function identityPart(code) {
  const value = String(code || '');
  const gs = value.indexOf(String.fromCharCode(29));
  return gs >= 0 ? value.slice(0, gs) : value;
}

function collectCisStatuses(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectCisStatuses(item, out);
    return out;
  }
  const status = node.status || node.cisStatus || node.generalStatus || node.emissionStatus;
  if (status) out.push(String(status));
  for (const value of Object.values(node)) collectCisStatuses(value, out);
  return out;
}

function safeDocumentErrors(document) {
  const errors = document && (document.commonErrors || document.errors);
  if (!errors) return [];
  const text = JSON.stringify(errors)
    .replace(/01\d{14}21[^"\\\s,}]+/g, '[код скрыт]')
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, '[данные скрыты]');
  try { return JSON.parse(text); } catch (_) { return ['Документ отклонён. Подробности доступны в расширенном режиме.']; }
}

// кэш профиля организации и баланса (обновляются по запросу)
let companyCache = null;
let balanceCache = null; // { balances:[...], at }

// ---------- статус ----------
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    Promise.resolve(promise).catch(e => ({ online: false, error: String(e?.message || e) })),
    new Promise(resolve => setTimeout(() => resolve(fallback), ms))
  ]);
}

// Liveness does not invoke CryptoPro, SSH or external APIs.
app.get('/health', (_req, res) => res.json({ ok: true, service: 'chz-worker', bridge: bridgeWorker.status() }));
app.get('/api/status', async (req, res) => {
  const laptop = await withTimeout(
    signer.status(),
    5000,
    { online: false, timeout: true, error: 'ПК подписи не ответил за 5 секунд' }
  );
  res.json({
    env: cfg.env,
    omsId: cfg.omsId,
    orgInn: cfg.orgInn,
    productGroup: cfg.productGroup,
    laptop,
    company: companyCache,
    token: suz.tokenInfo(),
    tariff: cfg.tariff,
    balance: balanceCache,
    spentTotalKop: spentTotalKop(),
    bridge: bridgeWorker.status(),
    orderAutomation: orderAutomation.status(),
    bulkOrderWorker: bulkOrderWorker.status()
  });
});

// профиль организации из ЧЗ (participants)
app.get('/api/company', async (req, res) => {
  const r = await trueapi.participant(cfg.orgInn);
  if (r.ok) companyCache = r.participant;
  res.json(r);
});

// реальный денежный баланс лицевого счёта из ЧЗ
app.get('/api/balance/live', async (req, res) => {
  const r = await trueapi.getBalance();
  if (r.ok) balanceCache = { balances: r.balances, at: Date.now() };
  res.json(r);
});

app.post('/api/laptop/deploy', async (req, res) => {
  const r = await signer.deployScript();
  res.json(r);
});

app.get('/api/ping', async (req, res) => {
  const r = await suz.ping();
  res.json(r);
});

app.get('/api/business-places', async (req, res) => {
  const r = await suz.businessPlaces();
  res.json(r);
});

app.get('/api/products/:gtin/readiness', async (req, res) => {
  const r = await trueapi.productReadiness(req.params.gtin);
  res.status(r.ok ? 200 : 400).json(r);
});

// ---------- токен ----------
app.post('/api/token/refresh', (req, res) => {
  const job = jobs.create();
  res.json({ jobId: job.id });
  (async () => {
    const r = await suz.getToken({ force: true, onProgress: s => jobs.emit(job, 'progress', { stage: s }) });
    jobs.finish(job, r.ok ? { ok: true, cached: Boolean(r.cached) } : r);
  })();
});

// ---------- товары ----------
app.get('/api/products', (req, res) => res.json(db.get().products));

// Официальный каталог участника: GTIN, названия и флаги готовности приходят из API Честного ЗНАКа.
app.get('/api/catalog', async (req, res) => {
  const result = await catalogService.syncOfficialCatalog();
  res.json(result);
});

function applyInfo(p, info) {
  if (!info) return;
  p.name = info.name || info.productName || p.name;
  p.brand = info.brand || null;
  p.packageType = info.packageType || null;
  p.productGroup = info.productGroup || null;
  p.innerUnitCount = info.innerUnitCount != null ? info.innerUnitCount : null;
  p.enrichedAt = Date.now();
}

app.post('/api/products', async (req, res) => {
  const d = db.get();
  let { id, name, gtin, templateId, expirationDays } = req.body || {};
  if (!gtin) return res.status(400).json({ error: 'gtin обязателен' });
  gtin = String(gtin).trim();
  // если название не задано — попробуем получить из ЧЗ
  let info = null;
  if (!name) {
    const r = await trueapi.productInfo([gtin]);
    if (r.ok && r.results[0]) { info = r.results[0]; name = info.name || info.productName; }
  }
  if (!name) return res.status(400).json({ error: 'Не удалось получить название по GTIN — укажите вручную' });
  let p;
  if (id) { p = d.products.find(x => x.id === id); if (!p) return res.status(404).json({ error: 'not found' }); }
  else { p = { id: `p_${Date.now()}` }; d.products.push(p); }
  Object.assign(p, { name, gtin, templateId: Number(templateId) || 30, expirationDays: Number(expirationDays) || null });
  applyInfo(p, info);
  db.save();
  res.json(d.products);
});

// Массовое добавление по списку GTIN (названия подтягиваются из ЧЗ одним запросом)
app.post('/api/products/bulk', async (req, res) => {
  const d = db.get();
  let gtins = [];
  if (Array.isArray(req.body && req.body.gtins)) gtins = req.body.gtins;
  else if (req.body && req.body.text) gtins = String(req.body.text).split(/[\s,;]+/);
  gtins = [...new Set(gtins.map(s => String(s).trim()).filter(g => /^\d{8,14}$/.test(g)).map(g => g.padStart(14, '0')))];
  if (!gtins.length) return res.status(400).json({ error: 'не найдено валидных GTIN (по одному в строке, 8–14 цифр)' });

  const info = await trueapi.productInfo(gtins);
  const byGtin = {};
  if (info.ok) info.results.forEach(x => { byGtin[x.gtin] = x; });

  let added = 0, skipped = 0, noInfo = 0;
  for (const gtin of gtins) {
    if (d.products.some(p => p.gtin === gtin)) { skipped++; continue; }
    const inf = byGtin[gtin];
    if (!inf) noInfo++;
    const p = { id: `p_${Date.now()}_${added}`, gtin, name: (inf && (inf.name || inf.productName)) || gtin, templateId: 30, expirationDays: null };
    applyInfo(p, inf);
    d.products.push(p);
    added++;
  }
  db.save();
  res.json({ ok: true, added, skipped, noInfo, total: d.products.length, products: d.products });
});

// Импорт всех карточек товаров из Национального каталога (нужен apikey НК в config.local.json)
app.post('/api/products/import-nk', async (req, res) => {
  if (!cfg.nkApiKey) return res.status(400).json({ error: 'Не задан apikey Национального каталога (config.local.json → "nkApiKey"). Возьми его в ЛК НК → Профиль → «Токен для доступа к API».' });
  const r = await trueapi.importNk(cfg.nkApiKey);
  if (!r.ok) return res.json({ ok: false, error: r.error, raw: r.raw });
  const d = db.get();
  let added = 0, skipped = 0;
  for (const it of r.items) {
    if (!it.gtin || d.products.some(p => p.gtin === it.gtin)) { skipped++; continue; }
    const p = { id: `p_nk_${added}_${Date.now()}`, gtin: it.gtin, name: it.name || it.gtin, templateId: 30, expirationDays: null };
    applyInfo(p, it);
    d.products.push(p); added++;
  }
  db.save();
  res.json({ ok: true, added, skipped, total: d.products.length, products: d.products });
});

// Загрузить ВСЕ товары участника из ЧЗ одним кликом (product/gtin по всем ТГ + названия product/info)
app.post('/api/products/load-all', async (req, res) => {
  let pgs = [cfg.productGroup];
  const pr = await trueapi.participant(cfg.orgInn);
  if (pr.ok && pr.participant && Array.isArray(pr.participant.productGroups) && pr.participant.productGroups.length) pgs = pr.participant.productGroups;
  const meta = {}; // gtin -> { pg, isKit, isSet }
  for (const pg of pgs) {
    const r = await trueapi.productGtins(pg);
    if (r.ok) (r.results || []).forEach(x => { if (!meta[x.gtin]) meta[x.gtin] = { pg, isKit: !!x.isKit, isSet: !!x.isSet, goodStatus: x.goodStatus }; });
  }
  const gtins = Object.keys(meta);
  if (!gtins.length) return res.json({ ok: false, error: 'ЧЗ вернул пустой список GTIN', groups: pgs });
  const info = await trueapi.productInfo(gtins);
  const byG = {}; if (info.ok) info.results.forEach(x => { byG[x.gtin] = x; });
  const d = db.get(); let added = 0, skipped = 0;
  for (const gtin of gtins) {
    const m = meta[gtin];
    const existing = d.products.find(p => p.gtin === gtin);
    if (existing) { existing.isKit = m.isKit; existing.isSet = m.isSet; if (!existing.productGroup) existing.productGroup = m.pg; skipped++; continue; }
    const inf = byG[gtin];
    const p = { id: `p_all_${added}_${Date.now()}`, gtin, name: (inf && (inf.name || inf.productName)) || gtin, templateId: 30, expirationDays: null, isKit: m.isKit, isSet: m.isSet };
    applyInfo(p, inf);
    if (!p.productGroup) p.productGroup = m.pg;
    d.products.push(p); added++;
  }
  db.save();
  res.json({ ok: true, added, skipped, foundGtins: gtins.length, groups: pgs, total: d.products.length });
});

// Обновить названия/атрибуты всех товаров из ЧЗ (product/info, одним запросом)
app.post('/api/products/refresh', async (req, res) => {
  const d = db.get();
  const gtins = d.products.map(p => p.gtin);
  if (!gtins.length) return res.json({ ok: true, products: d.products });
  const r = await trueapi.productInfo(gtins);
  if (!r.ok) return res.json({ ok: false, error: r.error, products: d.products });
  const byGtin = {}; r.results.forEach(x => { byGtin[x.gtin] = x; });
  d.products.forEach(p => applyInfo(p, byGtin[p.gtin]));
  db.save();
  res.json({ ok: true, products: d.products });
});
app.delete('/api/products/:id', (req, res) => {
  const d = db.get();
  d.products = d.products.filter(p => p.id !== req.params.id);
  db.save();
  res.json(d.products);
});

// ---------- баланс ----------
app.post('/api/balance', (req, res) => {
  const s = settings();
  if (req.body && req.body.balanceRub != null) s.balanceKop = Math.round(Number(req.body.balanceRub) * 100);
  db.save();
  res.json({ balanceKop: s.balanceKop, spentTotalKop: spentTotalKop() });
});

// ---------- заказ КМ ----------
app.post('/api/order', async (req, res) => {
  const { gtin, quantity, name, templateId, releaseMethodType, paymentType, allowSet, cisType, productionDate, expirationDate } = req.body || {};
  if (!gtin || !quantity) return res.status(400).json({ error: 'gtin и quantity обязательны' });
  const normalizedGtin = String(gtin).trim();
  const q = Number(quantity);
  if (!/^\d{14}$/.test(normalizedGtin)) return res.status(400).json({ error: 'gtin должен состоять из 14 цифр' });
  if (!Number.isInteger(q) || q < 1 || q > 5000) return res.status(400).json({ error: 'quantity должен быть целым числом от 1 до 5000' });
  const prod = db.get().products.find(p => p.gtin === normalizedGtin);
  const normalizedCisType = String(cisType || 'UNIT').toUpperCase();
  if (prod && (prod.isSet || prod.isKit)) {
    const testSetAllowlist = new Set(['04627174095029', '04627174095036']);
    if (allowSet !== true || q !== 1 || !testSetAllowlist.has(normalizedGtin) || prod.isKit) {
      return res.status(400).json({ error: 'Это набор (комплект). Для контрольного выпуска разрешены только заранее подтверждённые наборы и строго по одному КМ.' });
    }
    if (normalizedCisType !== 'SET') return res.status(400).json({ error: 'Для карточки набора обязателен cisType=SET' });
  } else if (normalizedCisType !== 'UNIT') {
    return res.status(400).json({ error: 'Для единицы товара обязателен cisType=UNIT' });
  }
  if (prod && prod.productGroup && prod.productGroup !== cfg.productGroup) return res.status(400).json({ error: `Товар в группе «${prod.productGroup}», а станция заказов настроена на «${cfg.productGroup}». Заказ такого товара недоступен через это подключение.` });
  const readiness = await trueapi.productReadiness(normalizedGtin);
  if (!readiness.ok) return res.status(503).json({ error: `Не удалось проверить карточку НК: ${readiness.error}` });
  if (!readiness.signed || !readiness.markReady || !readiness.turnReady) {
    return res.status(409).json({
      error: 'Карточка товара в НК не имеет статуса «Готов к вводу в оборот». Платный заказ заблокирован до исправления карточки.',
      readiness
    });
  }
  const releaseMethod = releaseMethodType || 'PRODUCTION';
  const payment = paymentType == null ? 1 : Number(paymentType);
  if (releaseMethod !== 'PRODUCTION' || payment !== 1 || Number(templateId || 30) !== 30) {
    return res.status(400).json({ error: 'Для выпуска новой продукции БАД разрешены только PRODUCTION, paymentType 1 и templateId 30' });
  }
  const hasEitherDate = Boolean(productionDate || expirationDate);
  if (hasEitherDate && (!validIsoDate(productionDate) || !validIsoDate(expirationDate))) {
    return res.status(400).json({ error: 'Укажите обе даты в формате YYYY-MM-DD' });
  }
  if (hasEitherDate && productionDate > localDateIso()) {
    return res.status(400).json({ error: 'Дата производства не может быть позже сегодняшней даты' });
  }
  if (hasEitherDate && expirationDate < productionDate) {
    return res.status(400).json({ error: 'Срок годности не может быть раньше даты производства' });
  }
  const clientRequestId = String(req.body?.clientRequestId || `manual:${crypto.randomUUID()}`).trim();
  if (clientRequestId.length < 8 || clientRequestId.length > 240) return res.status(400).json({ error: 'Некорректный clientRequestId' });
  const existingIntent = db.findAutomationIntent(clientRequestId);
  if (existingIntent) {
    return res.status(409).json({
      error: 'Запрос с таким clientRequestId уже существует; повторный платный заказ заблокирован',
      state: existingIntent.state,
      orderId: existingIntent.orderId || null
    });
  }
  const prepared = {
    clientRequestId,
    gtin: normalizedGtin,
    quantity: q,
    templateId: 30,
    releaseMethodType: 'PRODUCTION',
    paymentType: 1,
    cisType: normalizedCisType,
    automationMode: req.body?.automationMode === 'FULL' && normalizedCisType === 'UNIT' ? 'FULL' : 'MANUAL',
    createdBy: String(req.body?.createdBy || 'Рабочее место офиса').trim().slice(0, 80),
    productionDate: hasEitherDate ? productionDate : null,
    expirationDate: hasEitherDate ? expirationDate : null,
    productionOrderId: crypto.randomUUID(),
    serials: suz.genSerials(q),
    state: 'INTENT_READY'
  };
  db.upsertAutomationIntent(prepared);
  const job = jobs.create();
  res.json({ jobId: job.id, clientRequestId });
  (async () => {
    db.upsertAutomationIntent({ clientRequestId, state: 'ORDER_SUBMITTING' });
    const r = await suz.createOrder({
      gtin: normalizedGtin, quantity: q, templateId: 30,
      cisType: normalizedCisType,
      releaseMethodType: 'PRODUCTION', paymentType: 1,
      productionOrderId: prepared.productionOrderId,
      serials: prepared.serials,
      onProgress: s => jobs.emit(job, 'progress', { stage: s })
    });
    if (r.ok) {
      const spendKop = q * cfg.tariff.grossKop;
      db.upsertOrder({
        id: r.orderId, gtin: normalizedGtin, name: name || normalizedGtin, quantity: q,
        clientRequestId,
        productionOrderId: r.productionOrderId, serials: r.serials,
         status: 'CREATED', createdAt: Date.now(), expectedMs: r.expectedCompleteTimestamp,
         spendKop, codes: [], utilisedAt: null, releaseMethodType: 'PRODUCTION', cisType: normalizedCisType,
         productionDate: prepared.productionDate, expirationDate: prepared.expirationDate,
         automationMode: prepared.automationMode,
         automationState: prepared.automationMode === 'FULL' ? 'QUEUED' : 'MANUAL',
         automationNextAt: prepared.automationMode === 'FULL' ? Date.now() : null,
         automationRetryCount: 0,
         automationLastError: null,
         createdBy: prepared.createdBy,
         activity: [{ key: 'order-created', label: 'Заказ создан и передан в обработку', tone: 'success', at: Date.now() }]
       });
      db.upsertAutomationIntent({ clientRequestId, state: 'ORDER_CREATED', orderId: r.orderId });
      db.addOperation({ type: 'order', orderId: r.orderId, gtin: normalizedGtin, quantity: q, spendKop, note: 'Заказ КМ' });
       const s = settings(); s.balanceKop -= spendKop; db.save();
       if (prepared.automationMode === 'FULL') orderAutomation.kick(r.orderId);
    } else {
      db.upsertAutomationIntent({
        clientRequestId,
        state: r.stage === 'submit' ? 'SUBMIT_UNKNOWN' : 'FAILED_BEFORE_SUBMIT',
        lastError: r.error || 'Неизвестная ошибка'
      });
    }
    jobs.finish(job, r.ok
      ? { ok: true, orderId: r.orderId, expectedCompleteTimestamp: r.expectedCompleteTimestamp }
      : { ok: false, stage: r.stage || null, error: r.error || 'Заказ не создан' });
  })();
});

app.get('/api/orders', (req, res) => res.json(db.get().orders));

// Безопасный список для простого интерфейса: сами КМ и серийные номера в браузер не отправляются.
app.get('/api/orders/summary', (req, res) => res.json(db.get().orders.map(o => ({
  id: o.id,
  gtin: o.gtin,
  name: o.name,
  quantity: o.quantity,
  status: o.status,
  createdAt: o.createdAt,
  productionDate: o.productionDate || null,
  expirationDate: o.expirationDate || null,
  releaseMethodType: o.releaseMethodType || null,
  cisType: o.cisType || 'UNIT',
  availableCodes: o.availableCodes || 0,
  totalCodes: o.totalCodes || o.quantity,
  codeCount: Array.isArray(o.codes) ? o.codes.length : 0,
  utilisationReportStatus: o.utilisationReportStatus || null,
  introductionDocumentStatus: o.introductionDocumentStatus || null,
  introductionErrors: o.introductionErrors || [],
  introducedAt: o.introducedAt || null,
  automationMode: o.automationMode || 'LEGACY',
  automationState: o.automationState || null,
  automationUpdatedAt: o.automationUpdatedAt || null,
  automationLastError: o.automationLastError || null,
  automationRetryCount: Number(o.automationRetryCount || 0),
  createdBy: o.createdBy || null,
  activity: Array.isArray(o.activity) ? o.activity.slice(0, 20) : [],
  publicStatus: orderAutomation.publicStatus(o),
  printAllowed: o.status === 'INTRODUCED' && o.introductionDocumentStatus === 'CHECKED_OK'
}))));

app.get('/api/automation/status', (req, res) => res.json(orderAutomation.status()));

// ---------- массовый выпуск ----------
app.get('/api/bulk-batches/summary', (req, res) => {
  res.json(db.get().bulkBatches.map(bulkOrderWorker.batchSummary));
});

app.post('/api/bulk-batches', async (req, res) => {
  try {
    if (cfg.env !== 'PROD') return res.status(409).json({ error: 'Массовый выпуск доступен только в промышленном контуре PROD.' });
    const submitted = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!submitted.length || submitted.length > 100) return res.status(400).json({ error: 'Выберите от 1 до 100 карточек товара.' });
    const clientRequestId = String(req.body?.clientRequestId || '').trim();
    if (clientRequestId.length < 12 || clientRequestId.length > 240) return res.status(400).json({ error: 'Некорректный идентификатор массового выпуска.' });
    const requestFingerprint = crypto.createHash('sha256').update(JSON.stringify(submitted.map(item => ({
      gtin: String(item?.gtin || '').trim(), quantity: Number(item?.quantity),
      productionDate: String(item?.productionDate || ''), expirationDate: String(item?.expirationDate || '')
    })))).digest('hex');
    const existingBatch = db.get().bulkBatches.find(batch => batch.clientRequestId === clientRequestId);
    if (existingBatch) {
      if (existingBatch.requestFingerprint !== requestFingerprint) return res.status(409).json({ error: 'Этот идентификатор уже использован для другого состава массового выпуска.' });
      return res.json({ ok: true, reused: true, batch: bulkOrderWorker.batchSummary(existingBatch) });
    }
    const uniqueGtins = new Set(submitted.map(item => String(item?.gtin || '').trim()));
    if (uniqueGtins.size !== submitted.length) return res.status(400).json({ error: 'Одна карточка товара выбрана несколько раз.' });

    const catalog = await catalogService.syncOfficialCatalog();
    if (!catalog.ok) return res.status(503).json({ error: `Не удалось обновить каталог Честного ЗНАКа: ${catalog.error}` });
    const byGtin = new Map(catalog.products.map(product => [product.gtin, product]));
    const today = localDateIso();
    let totalQuantity = 0;
    const items = [];
    for (const [index, submittedItem] of submitted.entries()) {
      const gtin = String(submittedItem?.gtin || '').trim();
      const quantity = Number(submittedItem?.quantity);
      const productionDate = String(submittedItem?.productionDate || '');
      const expirationDate = String(submittedItem?.expirationDate || '');
      const product = byGtin.get(gtin);
      if (!product) return res.status(400).json({ error: `GTIN ${gtin} отсутствует в актуальном каталоге БАД участника.` });
      if (product.bulkExcluded) return res.status(409).json({ error: `Карточка «${product.registeredName}» исключена из рабочего каталога после контрольной проверки.` });
      if (product.isSet || product.isKit) return res.status(400).json({ error: `«${product.registeredName}» является набором или комплектом и исключён из обычного массового выпуска.` });
      if (!product.signed || !product.markReady || !product.turnReady) return res.status(409).json({ error: `Карточка «${product.registeredName}» не готова к заказу и вводу в оборот.` });
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 5000) return res.status(400).json({ error: `Некорректное количество для «${product.registeredName}».` });
      if (!validIsoDate(productionDate) || !validIsoDate(expirationDate)) return res.status(400).json({ error: `Укажите обе даты для «${product.registeredName}».` });
      if (productionDate > today) return res.status(400).json({ error: `Дата производства «${product.registeredName}» находится в будущем.` });
      if (expirationDate < productionDate) return res.status(400).json({ error: `Срок годности «${product.registeredName}» раньше даты производства.` });
      totalQuantity += quantity;
      items.push({
        id: `item_${index + 1}`,
        gtin,
        name: product.registeredName,
        quantity,
        productionDate,
        expirationDate,
        state: 'QUEUED',
        retryCount: 0,
        nextAt: null
      });
    }
    if (totalQuantity > 5000) return res.status(400).json({ error: 'Общее количество кодов в массовом выпуске не должно превышать 5000.' });

    // Последняя безопасная проверка до создания долговечной платной очереди.
    const laptop = await signer.status();
    if (!laptop.online || !laptop.csptest || !laptop.cert) {
      return res.status(503).json({ error: 'Компьютер электронной подписи не готов. Включите его, подключите носитель и повторите проверку.' });
    }
    const ping = await suz.ping();
    if (!ping.ok) return res.status(503).json({ error: `СУЗ не готова принять заказы: ${ping.error || 'проверка подключения не пройдена'}` });

    // Повторно сверяем каждую карточку непосредственно перед постановкой в очередь.
    const readinessRows = await Promise.all(items.map(item => trueapi.productReadiness(item.gtin)));
    const blockedIndex = readinessRows.findIndex(row => !row.ok || !row.signed || !row.markReady || !row.turnReady || row.vetControlled);
    if (blockedIndex >= 0) {
      const item = items[blockedIndex];
      return res.status(409).json({ error: `Карточка «${item.name}» не прошла финальную проверку готовности. Массовый выпуск не создан.` });
    }

    const batchId = `bulk_${crypto.randomUUID()}`;
    items.forEach((item, index) => { item.clientRequestId = `bulk:${batchId}:${index + 1}:${item.gtin}`; });
    const batch = db.upsertBulkBatch({
      id: batchId,
      clientRequestId,
      requestFingerprint,
      createdBy: String(req.body?.createdBy || 'Рабочее место офиса').trim().slice(0, 80),
      state: 'QUEUED',
      totalQuantity,
      totalCostKop: totalQuantity * cfg.tariff.grossKop,
      items,
      nextAt: Date.now(),
      lastError: null,
      activity: [{ label: `Подтверждён массовый выпуск: ${items.length} товаров, ${totalQuantity} кодов`, tone: 'success', at: Date.now() }]
    });
    bulkOrderWorker.kick(batch.id);
    res.json({ ok: true, batch: bulkOrderWorker.batchSummary(batch) });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.get('/api/order/:id/status', async (req, res) => {
  const o = db.findOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'order not found' });
  const r = await suz.orderStatus({ orderId: o.id, gtin: o.gtin });
  if (r.ok && r.buffers && r.buffers[0]) {
    const b = r.buffers[0];
    // не затираем статусы после получения кодов
    if (!['CODES_RECEIVED', 'UTILISATION_PENDING', 'APPLIED', 'INTRODUCTION_PENDING', 'INTRODUCTION_FAILED', 'INTRODUCED', 'WITHDRAWN'].includes(o.status)) o.status = b.bufferStatus;
    o.availableCodes = b.availableCodes;
    o.totalCodes = b.totalCodes;
    o.rejectionReason = b.rejectionReason || null;
    db.save();
  }
  res.json(r);
});

app.post('/api/order/:id/fetch-codes', async (req, res) => {
  const o = db.findOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'order not found' });
  const r = await suz.getCodes({ orderId: o.id, gtin: o.gtin, quantity: o.quantity });
  if (r.ok) { o.codes = r.codes; o.blockId = r.blockId; o.status = 'CODES_RECEIVED'; db.save(); }
  res.json(r);
});

// ---------- отчёт о нанесении (utilisation -> APPLIED) ----------
app.post('/api/order/:id/utilisation', async (req, res) => {
  const o = db.findOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'order not found' });
  if (!o.codes || !o.codes.length) return res.status(400).json({ error: 'нет кодов; сначала получите КМ' });
  const productionDate = req.body?.productionDate || o.productionDate;
  const expirationDate = req.body?.expirationDate || o.expirationDate;
  const { vetisGuid, verifyTimeoutMs } = req.body || {};
  if (!validIsoDate(productionDate) || !validIsoDate(expirationDate)) {
    return res.status(400).json({ error: 'для БАД обязательны productionDate и expirationDate в формате YYYY-MM-DD' });
  }
  if (productionDate > localDateIso()) return res.status(400).json({ error: 'Дата производства не может быть позже сегодняшней даты' });
  if (expirationDate < productionDate) return res.status(400).json({ error: 'Срок годности не может быть раньше даты производства' });
  const readiness = await trueapi.productReadiness(o.gtin);
  if (!readiness.ok) return res.status(503).json({ error: `Не удалось проверить карточку НК: ${readiness.error}` });
  if (!readiness.signed || !readiness.markReady || !readiness.turnReady) return res.status(409).json({ error: 'Карточка товара в НК ещё не подписана или не готова к маркировке и вводу в оборот', readiness });
  const normalizedVetisGuid = String(vetisGuid || '').trim();
  if (normalizedVetisGuid && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizedVetisGuid)) {
    return res.status(400).json({ error: 'vetisGuid должен быть действительным GUID площадки ВетИС; идентификатор ФИАС сюда подставлять нельзя' });
  }
  if (readiness.vetControlled && !normalizedVetisGuid) {
    return res.status(400).json({ error: 'В карточке указано подконтрольное ВетИС сырьё: для отчёта обязателен vetisGuid производственной площадки' });
  }
  if (normalizedVetisGuid) {
    const places = await suz.businessPlaces();
    if (!places.ok) return res.status(503).json({ error: `Не удалось проверить МОД: ${places.error}` });
    if (!places.places.some(place => String(place.vetisGuid || '').toLowerCase() === normalizedVetisGuid.toLowerCase())) {
      return res.status(400).json({ error: 'Указанный vetisGuid отсутствует среди зарегистрированных МОД участника' });
    }
  }
  const job = jobs.create();
  res.json({ jobId: job.id });
  (async () => {
    const verifyMs = Math.max(10000, Math.min(180000, Number(verifyTimeoutMs) || 180000));
    const r = await suz.utilisation({
      sntins: o.codes, productionDate, expirationDate, vetisGuid: normalizedVetisGuid || null, verifyTimeoutMs: verifyMs,
      onProgress: s => jobs.emit(job, 'progress', { stage: s })
    });
    if (r.reportId) {
      o.utilisationReportId = r.reportId;
      o.utilisationReportStatus = r.reportStatus || (r.pending ? 'PENDING' : null);
      o.productionDate = productionDate;
      o.expirationDate = expirationDate;
    }
    if (r.ok) {
      o.appliedAt = Date.now(); o.utilisedAt = o.appliedAt; o.status = 'APPLIED';
      if (!db.get().operations.some(x => x.type === 'utilisation' && x.orderId === o.id)) {
        db.addOperation({ type: 'utilisation', orderId: o.id, gtin: o.gtin, quantity: o.quantity, spendKop: 0, note: 'Отчёт о нанесении подтверждён СУЗ (SUCCESS), ожидается ввод в оборот' });
      } else db.save();
    } else {
      const terminalFailure = ['REJECTED', 'FAILED', 'PARTIALLY'].includes(r.reportStatus);
      o.status = terminalFailure ? 'UTILISATION_FAILED' : 'UTILISATION_PENDING';
      o.utilisationError = r.error || null;
      db.save();
    }
    jobs.finish(job, r.ok
      ? { ok: true, reportId: r.reportId, reportStatus: r.reportStatus }
      : { ok: false, reportId: r.reportId || null, reportStatus: r.reportStatus || null, pending: Boolean(r.pending), stage: r.stage || null, error: r.error || 'Отчёт не подтверждён' });
  })();
});

// Повторная проверка ранее отправленного отчёта, например после тайм-аута UI.
app.get('/api/order/:id/utilisation-status', async (req, res) => {
  const o = db.findOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'order not found' });
  if (!o.utilisationReportId) return res.status(400).json({ error: 'у заказа нет utilisationReportId' });
  const r = await suz.reportInfo({ reportId: o.utilisationReportId });
  if (r.ok) {
    o.utilisationReportStatus = r.reportStatus;
    if (r.reportStatus === 'SUCCESS') {
      o.status = 'APPLIED';
      o.appliedAt = o.appliedAt || Date.now();
      o.utilisedAt = o.utilisedAt || o.appliedAt;
      if (!db.get().operations.some(x => x.type === 'utilisation' && x.orderId === o.id)) {
        db.addOperation({ type: 'utilisation', orderId: o.id, gtin: o.gtin, quantity: o.quantity, spendKop: 0, note: 'Отчёт о нанесении подтверждён СУЗ (SUCCESS), ожидается ввод в оборот' });
      } else db.save();
    } else {
      o.status = ['REJECTED', 'FAILED', 'PARTIALLY'].includes(r.reportStatus) ? 'UTILISATION_FAILED' : 'UTILISATION_PENDING';
      db.save();
    }
  }
  res.json(r);
});

// ---------- ввод в оборот (True API LP_INTRODUCE_GOODS -> INTRODUCED) ----------
app.post('/api/order/:id/introduction', async (req, res) => {
  const o = db.findOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Заказ не найден' });
  if (o.cisType === 'SET') return res.status(409).json({ error: 'Набору сначала нужно назначить вложения. Используйте расширенный режим.' });
  if (o.status !== 'APPLIED' || o.utilisationReportStatus !== 'SUCCESS') {
    return res.status(409).json({ error: 'Сначала дождитесь успешного отчёта о нанесении (APPLIED)' });
  }
  if (!validIsoDate(o.productionDate) || !validIsoDate(o.expirationDate)) {
    return res.status(400).json({ error: 'В заказе отсутствуют корректные даты производства и срока годности' });
  }
  if (o.introductionDocumentId) {
    return res.status(409).json({ error: 'Документ ввода уже создан. Проверьте его статус, повторно отправлять нельзя.', documentId: o.introductionDocumentId });
  }
  if (['SUBMITTING', 'SUBMIT_UNKNOWN'].includes(o.introductionAttemptState)) {
    return res.status(409).json({ error: 'Предыдущая отправка могла дойти до Честного ЗНАКа. Повтор заблокирован до ручной проверки в расширенном режиме.' });
  }
  if (!Array.isArray(o.codes) || o.codes.length !== o.quantity) {
    return res.status(409).json({ error: 'Количество полученных кодов не совпадает с заказом' });
  }
  const job = jobs.create();
  res.json({ jobId: job.id });
  (async () => {
    let submissionStarted = false;
    try {
      jobs.emit(job, 'progress', { stage: 'Проверяем карточку товара' });
      const readiness = await trueapi.productReadiness(o.gtin);
      if (!readiness.ok || !readiness.signed || !readiness.markReady || !readiness.turnReady) {
        throw new Error(readiness.error || 'Карточка товара не готова к вводу в оборот');
      }
      const product = await trueapi.productInfo([o.gtin]);
      const card = product.ok && product.results && product.results[0];
      const tnved = card && String(card.tnVedCode10 || '');
      if (!/^\d{10}$/.test(tnved)) throw new Error('В карточке товара отсутствует корректный десятизначный код ТН ВЭД');
      const identities = o.codes.map(identityPart);
      if (new Set(identities).size !== identities.length) throw new Error('Обнаружены повторяющиеся коды; отправка остановлена');
      jobs.emit(job, 'progress', { stage: 'Проверяем состояние кодов' });
      const cisInfo = await trueapi.cisesInfo(identities);
      if (!cisInfo.ok) throw new Error(cisInfo.error || 'Не удалось проверить коды');
      const statuses = collectCisStatuses(cisInfo.results);
      if (statuses.length !== identities.length || statuses.some(value => value !== 'APPLIED')) {
        throw new Error('Не все коды имеют статус «Нанесён». Ввод в оборот остановлен.');
      }
      jobs.emit(job, 'progress', { stage: 'Подписываем ввод в оборот' });
      submissionStarted = true;
      o.introductionAttemptState = 'SUBMITTING';
      o.introductionAttemptAt = Date.now();
      db.save();
      const result = await trueapi.createDocument({
        type: 'LP_INTRODUCE_GOODS',
        pg: cfg.productGroup,
        bodyObj: {
          participant_inn: cfg.orgInn,
          producer_inn: cfg.orgInn,
          owner_inn: cfg.orgInn,
          production_date: o.productionDate,
          production_type: 'OWN_PRODUCTION',
          products: identities.map(uit_code => ({ uit_code, tnved_code: tnved }))
        },
        onProgress: stage => jobs.emit(job, 'progress', { stage })
      });
      if (!result.ok || !result.docId) {
        o.introductionAttemptState = result.stage === 'submit' ? 'SUBMIT_UNKNOWN' : 'FAILED_BEFORE_SUBMIT';
        db.save();
        jobs.finish(job, { ok: false, error: result.error || 'Честный знак не вернул номер документа' });
        return;
      }
      o.introductionDocumentId = result.docId;
      o.introductionDocumentStatus = 'SUBMITTED';
      o.introductionAttemptState = 'SUBMITTED';
      o.status = 'INTRODUCTION_PENDING';
      o.introductionSubmittedAt = Date.now();
      db.save();
      jobs.finish(job, { ok: true, documentId: result.docId, status: 'INTRODUCTION_PENDING' });
    } catch (error) {
      if (submissionStarted && o.introductionAttemptState === 'SUBMITTING') {
        o.introductionAttemptState = 'SUBMIT_UNKNOWN';
        db.save();
      }
      jobs.finish(job, { ok: false, error: String(error?.message || error) });
    }
  })();
});

app.get('/api/order/:id/introduction-status', async (req, res) => {
  const o = db.findOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Заказ не найден' });
  if (!o.introductionDocumentId) return res.status(400).json({ error: 'Документ ввода ещё не создан' });
  const result = await trueapi.documentInfo(o.introductionDocumentId);
  if (!result.ok) return res.status(503).json({ error: result.error || 'Не удалось проверить документ' });
  const documentStatus = result.document && result.document.status;
  o.introductionDocumentStatus = documentStatus || o.introductionDocumentStatus;
  if (documentStatus === 'CHECKED_NOT_OK') {
    o.status = 'INTRODUCTION_FAILED';
    o.introductionErrors = safeDocumentErrors(result.document);
    db.save();
    return res.json({ ok: false, status: o.status, documentStatus, errors: o.introductionErrors });
  }
  if (documentStatus === 'CHECKED_OK') {
    const identities = (o.codes || []).map(identityPart);
    const info = await trueapi.cisesInfo(identities);
    if (!info.ok) return res.status(503).json({ error: info.error || 'Документ принят, но не удалось проверить коды' });
    const statuses = collectCisStatuses(info.results);
    if (statuses.length === identities.length && statuses.every(value => value === 'INTRODUCED')) {
      o.status = 'INTRODUCED';
      o.introducedAt = o.introducedAt || Date.now();
      if (!db.get().operations.some(x => x.type === 'introduction' && x.orderId === o.id)) {
        db.addOperation({ type: 'introduction', orderId: o.id, gtin: o.gtin, quantity: o.quantity, spendKop: 0, note: 'Документ ввода CHECKED_OK, все КИ INTRODUCED' });
      } else db.save();
      return res.json({ ok: true, status: o.status, documentStatus, introducedCount: statuses.length });
    }
  }
  o.status = 'INTRODUCTION_PENDING';
  db.save();
  res.json({ ok: true, status: o.status, documentStatus: documentStatus || 'PROCESSING' });
});

// ---------- вывод из оборота (СУЗ dropout — списание) ----------
app.post('/api/dropout', (req, res) => {
  const { sntins, dropoutReason } = req.body || {};
  if (!Array.isArray(sntins) || !sntins.length || !dropoutReason) return res.status(400).json({ error: 'sntins[] и dropoutReason обязательны' });
  const job = jobs.create();
  res.json({ jobId: job.id });
  (async () => {
    const r = await suz.dropout({ sntins, dropoutReason, onProgress: s => jobs.emit(job, 'progress', { stage: s }) });
    if (r.ok) db.addOperation({ type: 'dropout', gtin: '-', quantity: sntins.length, spendKop: 0, note: `Вывод (${dropoutReason})` });
    jobs.finish(job, r);
  })();
});

// ---------- вывод из оборота: розничная продажа (True API LK_RECEIPT) ----------
app.post('/api/withdraw', (req, res) => {
  const { cises, documentNumber, documentDate, actionDate, documentType } = req.body || {};
  if (!Array.isArray(cises) || !cises.length) return res.status(400).json({ error: 'нет кодов (cises[])' });
  if (!documentNumber || !documentDate) return res.status(400).json({ error: 'нужны номер и дата документа (чека)' });
  // защита от повторного вывода: если эти коды уже выведены в рамках заказа
  const already = db.get().orders.find(o => o.status === 'WITHDRAWN' && o.codes && o.codes.some(c => cises.includes(c)));
  if (already) return res.status(400).json({ error: 'Эти коды уже выведены из оборота ранее (повторный вывод недоступен).' });
  const job = jobs.create();
  res.json({ jobId: job.id });
  (async () => {
    const r = await trueapi.withdrawRetail({
      cises,
      actionDate: actionDate || documentDate,
      documentType: documentType || 'RECEIPT',
      documentNumber, documentDate,
      pg: cfg.productGroup,
      onProgress: s => jobs.emit(job, 'progress', { stage: s })
    });
    if (r.ok) {
      db.addOperation({ type: 'withdraw', gtin: '-', quantity: cises.length, spendKop: 0, note: `Вывод из оборота (розница), чек ${documentNumber}` });
      // отметить заказы, чьи коды выведены
      const set = new Set(cises);
      db.get().orders.forEach(o => { if (o.codes && o.codes.some(c => set.has(c))) { o.status = 'WITHDRAWN'; o.withdrawnAt = Date.now(); } });
      db.save();
    }
    jobs.finish(job, r);
  })();
});

// ---------- операции / расходы ----------
app.get('/api/operations', (req, res) => res.json(db.get().operations));

// ---------- DataMatrix ----------
async function dmPng(text, scale) {
  // Настоящий GS1 DataMatrix: ведущий FNC1 (режим GS1) + FNC1 как разделитель AI
  // (в исходном КМ разделители приходят как байт GS 0x1D). Так код читается приложением ЧЗ.
  const parsed = '^FNC1' + String(text).replace(new RegExp(String.fromCharCode(29), 'g'), '^FNC1');
  return bwipjs.toBuffer({ bcid: 'datamatrix', text: parsed, parse: true, parsefnc: true, scale: scale || 4, padding: 4, backgroundcolor: 'FFFFFF' });
}
app.get('/api/dm.png', async (req, res) => {
  const text = req.query.text;
  if (!text) return res.status(400).send('text required');
  try {
    const png = await dmPng(text, Number(req.query.scale) || 4);
    if (req.query.download) res.set('Content-Disposition', `attachment; filename="${req.query.download}"`);
    res.set('Content-Type', 'image/png').send(png);
  } catch (e) {
    res.status(500).send('DM error: ' + e.message);
  }
});

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function codeVisible(c) { return String(c).replace(new RegExp(String.fromCharCode(29), 'g'), '␣'); } // GS -> ␣ visible marker

// Скачать коды заказа текстом (по одному в строке, с GS-разделителями как в оригинале)
app.get('/api/order/:id/codes.txt', (req, res) => {
  const o = db.findOrder(req.params.id);
  if (!o || !o.codes || !o.codes.length) return res.status(404).send('нет кодов');
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="codes_${o.gtin}.txt"`);
  res.send(o.codes.join('\n'));
});

// Печатная страница: одна физическая этикетка 58×40 мм содержит два одинаковых DataMatrix.
app.get('/api/order/:id/labels', (req, res) => {
  const o = db.findOrder(req.params.id);
  if (!o || !o.codes || !o.codes.length) return res.status(404).send('нет кодов');
  if (o.status !== 'INTRODUCED' || o.introductionDocumentStatus !== 'CHECKED_OK') {
    return res.status(409).send('Печать заблокирована: дождитесь ввода всех кодов в оборот (INTRODUCED / CHECKED_OK).');
  }
  const items = o.codes.map((c, i) => `
    <figure class="label">
      <div class="half"><img src="/api/dm.png?scale=6&text=${encodeURIComponent(c)}" alt="DataMatrix"><b>${esc(o.name || o.gtin)}</b></div>
      <div class="half"><img src="/api/dm.png?scale=6&text=${encodeURIComponent(c)}" alt="DataMatrix"><b>${esc(o.name || o.gtin)}</b></div>
      <span class="number">${i + 1}/${o.codes.length}</span>
    </figure>`).join('');
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Этикетки — ${esc(o.name || o.gtin)}</title>
<style>
  *{box-sizing:border-box} body{font-family:Arial,sans-serif;margin:18px;color:#111;background:#eef2f5}
  h1{font-size:18px;margin:0 0 5px}.help{font-size:13px;color:#52606d;margin-bottom:14px}.bar{margin-bottom:16px}
  button{padding:11px 18px;font-size:15px;border:0;border-radius:9px;background:#146c43;color:#fff;font-weight:700;cursor:pointer}
  .grid{display:flex;flex-wrap:wrap;gap:12px}.label{position:relative;display:flex;margin:0;width:58mm;height:40mm;background:#fff;border:1px solid #bdc7ce;page-break-inside:avoid;overflow:hidden}
  .half{position:relative;width:29mm;height:40mm;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1.4mm 1mm 1.1mm;text-align:center}
  .half:first-child{border-right:.25mm dashed #aab3b9}.half img{width:23mm;height:23mm;image-rendering:pixelated;object-fit:contain}.half b{display:block;width:100%;margin-top:1mm;font-size:6.5pt;line-height:1.05;overflow:hidden;max-height:7.2mm}
  .number{position:absolute;right:.7mm;top:.4mm;font-size:5pt;color:#999}
  @page{size:58mm 40mm;margin:0}
  @media print{body{margin:0;background:#fff}.bar,h1,.help{display:none}.grid{display:block}.label{border:0;page-break-after:always}.label:last-child{page-break-after:auto}}
</style></head><body>
<h1>${esc(o.name || o.gtin)} — ${o.codes.length} этикеток</h1>
<div class="help">На каждой этикетке два одинаковых кода: разрежьте её по пунктирной линии.</div>
<div class="bar"><button onclick="window.print()">Печатать этикетки</button></div>
<div class="grid">${items}</div>
</body></html>`);
});

// ---------- SSE ----------
app.get('/api/jobs/:id/events', (req, res) => jobs.subscribe(req.params.id, res));

app.listen(cfg.port, '127.0.0.1', () => {
  console.log(`chz-app на http://127.0.0.1:${cfg.port}  (env=${cfg.env}, omsId=${cfg.omsId})`);
  try { orderAutomation.start(); } catch (error) { console.error('[order-automation]', error?.message || error); }
  try { bulkOrderWorker.start(); } catch (error) { console.error('[bulk-order-worker]', error?.message || error); }
  try { bridgeWorker.start(); } catch (error) { console.error('[chz-worker]', error?.message || error); }
});

function normalizedPrintKey(input) {
  const marketplace = String(input?.marketplace || '').trim().toLowerCase();
  const entityId = String(input?.entityId || '').trim();
  const orderId = String(input?.orderId || '').trim();
  const expectedCount = Number(input?.expectedCount);
  if (!['ozon', 'wb'].includes(marketplace) || !entityId || !orderId) {
    throw new Error('Некорректный контекст заказа для печати ЧЗ');
  }
  if (!Number.isInteger(expectedCount) || expectedCount < 0 || expectedCount > cfg.bridge.maxQuantity) {
    throw new Error('Некорректное ожидаемое количество этикеток ЧЗ');
  }
  return { marketplace, entityId, orderId, expectedCount };
}

function resolveOrderChzCodes(key) {
  const rows = [];
  let pending = false;
  for (const intent of db.get().automationIntents) {
    if (String(intent.marketplace || '').toLowerCase() !== key.marketplace ||
        String(intent.entityId || '') !== key.entityId) continue;
    const allocations = Array.isArray(intent.allocations)
      ? intent.allocations.filter((item) => String(item?.orderId || '') === key.orderId)
      : [];
    if (!allocations.length) continue;
    if (intent.state !== 'INTRODUCED' || !Array.isArray(intent.codes) || intent.codes.length !== Number(intent.quantity)) {
      pending = true;
      continue;
    }
    for (const allocation of allocations) {
      const codeIndex = Number(allocation.codeIndex);
      const code = intent.codes[codeIndex];
      if (!code) throw new Error(`Локально отсутствует код ЧЗ с индексом ${codeIndex}`);
      rows.push({
        remoteJobId: Number(intent.remoteJobId),
        clientRequestId: intent.clientRequestId,
        basisKey: intent.basisKey,
        gtin: intent.gtin,
        productName: intent.productName,
        sourceArticle: allocation.sourceArticle || null,
        componentProductId: allocation.componentProductId ?? null,
        unitIndex: Number(allocation.unitIndex),
        codeIndex,
        code,
      });
    }
  }
  if (pending) throw new Error('Коды ЧЗ для этого заказа ещё не получили подтверждённый статус INTRODUCED');
  rows.sort((a, b) => String(a.gtin).localeCompare(String(b.gtin)) || a.codeIndex - b.codeIndex);
  if (rows.length !== key.expectedCount) {
    throw new Error(`Готово кодов ЧЗ: ${rows.length}, требуется: ${key.expectedCount}`);
  }
  return rows;
}

function previousPhysicalPrintFor(key) {
  return db.get().chzPrintAttempts.find((item) =>
    ['PREPARED', 'PRINTED', 'PRINT_FAILED'].includes(item.state) && item.marketplace === key.marketplace &&
    item.entityId === key.entityId && item.orderId === key.orderId
  );
}

// Локальный loopback API для desktop-приложения. Сырые КМ остаются только на этом ПК:
// наружу возвращаются уже отрисованные PNG.
app.post('/api/automation/print-order/prepare', async (req, res) => {
  try {
    const key = normalizedPrintKey(req.body);
    if (key.expectedCount === 0) return res.json({ ok: true, required: false, labels: [] });
    const reprintReason = String(req.body?.reprintReason || '').trim().slice(0, 500);
    const previous = previousPhysicalPrintFor(key);
    if (previous?.state === 'PRINTED' && previous.primaryPrinted === false) {
      return res.json({
        ok: true,
        required: false,
        primaryOnly: true,
        chzAlreadyPrinted: true,
        token: previous.token,
        labels: [],
      });
    }
    if (previous && !reprintReason) {
      return res.status(409).json({ error: 'Печать ЧЗ для этого заказа уже запускалась. Для безопасной повторной печати укажите причину.' });
    }
    const codes = resolveOrderChzCodes(key);
    const token = crypto.randomUUID();
    const attempt = db.addChzPrintAttempt({
      token,
      ...key,
      reprintReason: reprintReason || null,
      codeRefs: codes.map(({ code, ...row }) => row),
    });
    const labels = await Promise.all(codes.map(async (row, index) => ({
      index,
      gtin: row.gtin,
      productName: row.productName,
      sourceArticle: row.sourceArticle,
      imageBase64: (await dmPng(row.code, 6)).toString('base64'),
    })));
    res.json({
      ok: true,
      required: true,
      token: attempt.token,
      skipPrimary: previous?.state === 'PRINT_FAILED' && previous.primaryPrinted === true,
      labels,
    });
  } catch (error) {
    res.status(409).json({ error: String(error?.message || error) });
  }
});

app.post('/api/automation/print-order/complete', async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    const attempt = db.findChzPrintAttempt(token);
    if (!attempt) return res.status(404).json({ error: 'Попытка печати ЧЗ не найдена' });
    const success = req.body?.success === true;
    const primaryPrinted = req.body?.primaryPrinted === true;
    if (attempt.state === 'PRINTED' && success) {
      if (primaryPrinted && attempt.primaryPrinted !== true) {
        db.updateChzPrintAttempt(token, { primaryPrinted: true });
      }
      return res.json({ ok: true, attempt: db.findChzPrintAttempt(token) });
    }
    const updated = db.updateChzPrintAttempt(token, {
      state: success ? 'PRINTED' : 'PRINT_FAILED',
      completedAt: Date.now(),
      primaryPrinted,
      printerName: String(req.body?.printerName || '').trim().slice(0, 250) || null,
      error: success ? null : String(req.body?.error || 'Ошибка печати').trim().slice(0, 2000),
    });
    const grouped = new Map();
    for (const ref of attempt.codeRefs || []) {
      const id = Number(ref.remoteJobId);
      if (!Number.isInteger(id) || id <= 0) continue;
      grouped.set(id, (grouped.get(id) || 0) + 1);
    }
    const remoteReports = [];
    for (const [jobId, expectedForJob] of grouped) {
      try {
        const report = await bridgeWorker.reportPrintAttempt(jobId, {
          sourceOrderId: attempt.orderId,
          workstation: cfg.bridge.workerId,
          printerName: updated.printerName,
          printedCount: success ? expectedForJob : 0,
          result: success ? 'PRINTED' : 'PRINT_FAILED',
          reprintReason: attempt.reprintReason,
          error: updated.error,
        });
        remoteReports.push({ jobId, ok: report?.ok !== false, skipped: report?.skipped === true });
      } catch (reportError) {
        remoteReports.push({ jobId, ok: false, error: String(reportError?.message || reportError) });
      }
    }
    res.json({ ok: true, attempt: updated, remoteReports });
  } catch (error) {
    res.status(400).json({ error: String(error?.message || error) });
  }
});
