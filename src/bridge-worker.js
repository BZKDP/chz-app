'use strict';

const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { createTransport } = require('./bridge-transport');
const zlib = require('zlib');
const bwipjs = require('bwip-js');
const cfg = require('./config');
const db = require('./db');
const suz = require('./suz');
const trueapi = require('./trueapi');
const signer = require('./signer');
const transport = createTransport({ secret: cfg.bridge.secret, workerId: cfg.bridge.workerId });
const VERSION = '2026.10.05.2';
let signatureChecking = false;
const SIGNATURE_HELP = 'ЭЦП недоступна: подключите носитель к ПК ЧЗ и проверьте окно CryptoPro. Если запрошен PIN, введите его только на том компьютере.';
const PRE_SUBMIT_STAGES = new Set(['authKey', 'signIn', 'upload', 'sign']);

function signatureState() {
  return { ...(db.get().settings?.bridgeSignature || {}), checking: signatureChecking };
}

function saveSignature(update) {
  const data = db.get();
  data.settings ||= {};
  data.settings.bridgeSignature = { ...data.settings.bridgeSignature, ...update };
  db.save();
}

function blockSignature() {
  saveSignature({ blocked: true, error: SIGNATURE_HELP, checkedAt: Date.now() });
}

async function checkSignature(requestId = null) {
  if (signatureChecking) return false;
  signatureChecking = true;
  await heartbeat();
  let ok = false;
  try {
    // Local diagnostic only: this signature is never submitted as a document.
    // A certificate in Windows is NOT proof that its USB private key is usable.
    const result = await signer.sign('auth', `CHZ local key availability check ${crypto.randomUUID()}`);
    ok = result.ok === true;
  } catch (_) { ok = false; }
  finally {
    signatureChecking = false;
    const at = Date.now();
    saveSignature({ blocked: !ok, error: ok ? null : SIGNATURE_HELP, checkedAt: at,
      ...(ok ? { lastSuccessAt: at } : {}),
      ...(requestId ? { lastRequest: { id: requestId, ok, finishedAt: at } } : {}) });
  }
  await heartbeat();
  return ok;
}

async function ensureSigningAvailable() {
  const state = signatureState();
  if (state.blocked) return false;
  if (state.lastSuccessAt && Math.abs(Date.now() - state.lastSuccessAt) < 60000) return true;
  return checkSignature();
}

function retryBeforeSubmit(intent, result, resumeState) {
  if (!PRE_SUBMIT_STAGES.has(result.stage)) return false;
  const message = result.stage === 'sign' ? SIGNATURE_HELP : safeMessage(result.error);
  db.upsertAutomationIntent({ clientRequestId: intent.clientRequestId, state: resumeState,
    lastError: message, lastPreSubmitFailureStage: result.stage });
  if (result.stage === 'sign') blockSignature();
  throw new Error(message);
}
let signerSnapshot = null;
let signerChecking = false;
let retryAfter = 0;
let failures = 0;

const TERMINAL_REPORT_STATES = new Set(['REJECTED', 'FAILED', 'PARTIALLY']);
let running = false;
let timer = null;
let current = null;
let lastError = null;
let lastPollAt = null;
let heartbeatTimer = null;
let heartbeatRunning = false;
let lastHeartbeatAt = null;
let lastHeartbeatError = null;

function safeMessage(value) {
  return String(value || 'Неизвестная ошибка')
    .replace(/01\d{14}21[^\s,}"']+/g, '[код скрыт]')
    .replace(/[A-Za-z0-9+/=_-]{48,}/g, '[данные скрыты]')
    .slice(0, 1000);
}

function identityPart(code) {
  const value = String(code || '');
  const gs = value.indexOf(String.fromCharCode(29));
  return gs >= 0 ? value.slice(0, gs) : value;
}

function collectStatuses(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectStatuses(item, out);
    return out;
  }
  const status = node.status || node.cisStatus || node.generalStatus || node.emissionStatus;
  if (status) out.push(String(status));
  for (const value of Object.values(node)) collectStatuses(value, out);
  return out;
}

function catalogSnapshot() {
  return db.get().products.map(product => ({
    gtin: String(product.gtin || ''),
    name: product.name || product.registeredName || product.gtin,
    registeredName: product.registeredName || product.name || product.gtin,
    brand: product.brand || null,
    stateRegistrationCertificate: product.stateRegistrationCertificate || null,
    packageType: product.packageType || null,
    productGroup: product.productGroup || cfg.productGroup,
    signed: product.signed === true,
    markReady: product.markReady === true,
    turnReady: product.turnReady === true,
    isSet: product.isSet === true,
    isKit: product.isKit === true,
    bulkExcluded: product.bulkExcluded === true,
    bulkExcludedReason: product.bulkExcludedReason || null,
  }));
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

async function renderLabelsArtifact(intent) {
  if (!intent || intent.state !== 'INTRODUCED' || !Array.isArray(intent.codes) || intent.codes.length !== Number(intent.quantity)) {
    throw new Error('Локальная партия ещё не готова к формированию этикеток');
  }
  const name = escapeHtml(intent.productName || intent.gtin);
  const labels = [];
  for (let index = 0; index < intent.codes.length; index += 1) {
    const parsed = '^FNC1' + String(intent.codes[index]).replace(new RegExp(String.fromCharCode(29), 'g'), '^FNC1');
    const png = await bwipjs.toBuffer({ bcid: 'datamatrix', text: parsed, parse: true, parsefnc: true, scale: 6, padding: 4, backgroundcolor: 'FFFFFF' });
    const data = png.toString('base64');
    labels.push(`<figure class="label" style="--dm:url(data:image/png;base64,${data})"><div class="half"><i></i><b>${name}</b></div><div class="half"><i></i><b>${name}</b></div><span>${index + 1}/${intent.codes.length}</span></figure>`);
  }
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Этикетки — ${name}</title><style>*{box-sizing:border-box}body{font-family:Arial,sans-serif;margin:18px;color:#111;background:#eef2f5}h1{font-size:18px;margin:0 0 5px}.help{font-size:13px;color:#52606d;margin-bottom:14px}button{padding:11px 18px;margin-bottom:16px;font-size:15px;border:0;border-radius:7px;background:#171817;color:#fff;font-weight:700;cursor:pointer}.grid{display:flex;flex-wrap:wrap;gap:12px}.label{position:relative;display:flex;margin:0;width:58mm;height:40mm;background:#fff;border:1px solid #bdc7ce;page-break-inside:avoid;overflow:hidden}.half{width:29mm;height:40mm;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1.4mm 1mm 1.1mm;text-align:center}.half:first-child{border-right:.25mm dashed #aab3b9}.half i{display:block;width:23mm;height:23mm;background:var(--dm) center/contain no-repeat;image-rendering:pixelated}.half b{display:block;width:100%;margin-top:1mm;font-size:6.5pt;line-height:1.05;overflow:hidden;max-height:7.2mm}.label>span{position:absolute;right:.7mm;top:.4mm;font-size:5pt;color:#999}@page{size:58mm 40mm;margin:0}@media print{body{margin:0;background:#fff}button,h1,.help{display:none}.grid{display:block}.label{border:0;page-break-after:always}.label:last-child{page-break-after:auto}}</style></head><body><h1>${name} — ${intent.codes.length} этикеток</h1><p class="help">На каждой этикетке два одинаковых DataMatrix. Для печати используйте кнопку ниже.</p><button type="button" onclick="window.print()">Печатать этикетки</button><main class="grid">${labels.join('')}</main></body></html>`;
  const compressed = zlib.gzipSync(Buffer.from(html, 'utf8'), { level: 9 });
  return {
    mimeType: 'text/html; charset=utf-8',
    encoding: 'gzip',
    contentBase64: compressed.toString('base64'),
    sha256: crypto.createHash('sha256').update(compressed).digest('hex'),
    labelCount: intent.codes.length,
  };
}

async function uploadRequestedArtifacts(requests) {
  for (const request of Array.isArray(requests) ? requests : []) {
    const intent = db.findAutomationIntent(request.clientRequestId)
      || db.get().automationIntents.find(item => Number(item.remoteJobId) === Number(request.id));
    if (!intent || intent.state !== 'INTRODUCED') continue;
    const artifact = await renderLabelsArtifact(intent);
    await requestJson('POST', `${cfg.bridge.url}/jobs/${encodeURIComponent(request.id)}/artifact`, artifact);
    db.upsertAutomationIntent({ clientRequestId: intent.clientRequestId, artifactUploadedAt: Date.now(), artifactSha256: artifact.sha256 });
  }
}

function requestJson(method, url, body = {}) {
  return transport.request(method, url, body);
}

async function refreshSigner() {
  if (signerChecking) return;
  signerChecking = true;
  try {
    const value = await signer.status();
    signerSnapshot = { online: value.online === true, csptest: value.csptest === true,
      cert: value.cert === true, certUntil: value.certUntil || null, checkedAt: Date.now(),
      error: value.error ? safeMessage(value.error) : null };
  } catch (error) {
    signerSnapshot = { online: false, csptest: false, cert: false, checkedAt: Date.now(), error: safeMessage(error.message) };
  } finally { signerChecking = false; }
}

function telemetry() {
  return { version: VERSION, scheduler: 'steps-v1', env: cfg.env, productGroup: cfg.productGroup,
    signatureRecoveryAvailable: true, signature: signatureState(),
    processing: running, currentJobId: current?.id || null, currentState: current?.state || null,
    lastPollAt, lastError, signer: signerSnapshot, token: { valid: suz.tokenInfo()?.valid === true },
    ...transport.clockStatus() };
}

async function heartbeat() {
  if (!cfg.bridge.enabled || cfg.bridge.secret.length < 32 || heartbeatRunning) return;
  heartbeatRunning = true;
  try {
    await requestJson('POST', `${cfg.bridge.url}/heartbeat`, {
      status: telemetry()
    });
    lastHeartbeatAt = Date.now();
    lastHeartbeatError = null;
  } catch (error) {
    lastHeartbeatError = safeMessage(error?.message || error);
  } finally {
    heartbeatRunning = false;
  }
}

function ensureJobIsAllowed(job) {
  if (!job || !Number.isInteger(Number(job.id)) || !job.clientRequestId) throw new Error('Сервер вернул некорректное задание');
  if (!/^\d{14}$/.test(String(job.gtin || ''))) throw new Error('Некорректный GTIN в задании');
  if (!Number.isInteger(Number(job.quantity)) || Number(job.quantity) < 1 || Number(job.quantity) > cfg.bridge.maxQuantity) {
    throw new Error(`Количество вне разрешённого диапазона 1..${cfg.bridge.maxQuantity}`);
  }
  if (Number(job.templateId) !== 30 || job.releaseMethodType !== 'PRODUCTION' || Number(job.paymentType) !== 1) {
    throw new Error('Задание не соответствует рабочим параметрам БАД: template 30, PRODUCTION, paymentType 1');
  }
  const productionDate = String(job.productionDate || '').slice(0, 10);
  const expirationDate = String(job.expirationDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(productionDate) || !/^\d{4}-\d{2}-\d{2}$/.test(expirationDate) || expirationDate <= productionDate) {
    throw new Error('Некорректные даты производственной партии');
  }
  const product = db.get().products.find(item => String(item.gtin) === String(job.gtin));
  if (!product || product.isSet || product.isKit || (product.productGroup && product.productGroup !== cfg.productGroup)) {
    throw new Error('GTIN отсутствует в разрешённом локальном каталоге обычных товаров БАД');
  }
  const allocations = normalizeAllocations(job.allocations, Number(job.quantity));
  return { product, productionDate, expirationDate, allocations };
}

function normalizeAllocations(input, quantity) {
  if (!Array.isArray(input) || input.length !== quantity) {
    throw new Error('Сервер не передал полное распределение кодов ЧЗ по заказам');
  }
  const normalized = input.map((item) => ({
    orderId: String(item?.orderId || '').trim(),
    sourceArticle: String(item?.sourceArticle || '').trim() || null,
    componentProductId: item?.componentProductId == null ? null : Number(item.componentProductId),
    unitIndex: Number(item?.unitIndex),
    codeIndex: Number(item?.codeIndex),
  }));
  if (normalized.some((item) => !item.orderId || !Number.isInteger(item.unitIndex) || item.unitIndex < 1 || !Number.isInteger(item.codeIndex))) {
    throw new Error('Сервер передал некорректное распределение кодов ЧЗ');
  }
  const indexes = normalized.map((item) => item.codeIndex).sort((a, b) => a - b);
  if (new Set(indexes).size !== quantity || indexes.some((value, index) => value !== index)) {
    throw new Error('Индексы кодов ЧЗ должны быть уникальными и непрерывными');
  }
  return normalized.sort((a, b) => a.codeIndex - b.codeIndex);
}

function payloadFingerprint(job) {
  return crypto.createHash('sha256').update(JSON.stringify({
    gtin: String(job.gtin),
    quantity: Number(job.quantity),
    productionDate: String(job.productionDate).slice(0, 10),
    expirationDate: String(job.expirationDate).slice(0, 10),
    templateId: Number(job.templateId),
    releaseMethodType: job.releaseMethodType,
    paymentType: Number(job.paymentType),
    allocations: normalizeAllocations(job.allocations, Number(job.quantity)),
  })).digest('hex');
}

async function progress(job, state, extra = {}) {
  const response = await requestJson('POST', `${cfg.bridge.url}/jobs/${encodeURIComponent(job.id)}/progress`, {
    leaseToken: job.leaseToken,
    state,
    externalOrderId: extra.externalOrderId || null,
    externalReportId: extra.externalReportId || null,
    error: extra.error || null,
  });
  Object.assign(job, response.job || {}, { state });
}

function prepareIntent(job, validated) {
  const fingerprint = payloadFingerprint(job);
  let intent = db.findAutomationIntent(job.clientRequestId);
  if (intent && intent.payloadFingerprint !== fingerprint) throw new Error('Повторный clientRequestId содержит другие параметры');
  if (!intent) {
    intent = db.upsertAutomationIntent({
      clientRequestId: job.clientRequestId,
      remoteJobId: Number(job.id),
      marketplace: job.marketplace,
      entityId: job.entityId,
      basisKey: job.basisKey,
      gtin: String(job.gtin),
      quantity: Number(job.quantity),
      productionDate: validated.productionDate,
      expirationDate: validated.expirationDate,
      templateId: 30,
      releaseMethodType: 'PRODUCTION',
      paymentType: 1,
      productName: validated.product.name || job.basisKey || job.gtin,
      productionOrderId: crypto.randomUUID(),
      serials: suz.genSerials(Number(job.quantity)),
      allocations: validated.allocations,
      payloadFingerprint: fingerprint,
      state: 'CLAIMED',
    });
  }
  return intent;
}

function validateCodes(codes, job) {
  if (!Array.isArray(codes) || codes.length !== Number(job.quantity)) throw new Error('СУЗ вернул неверное количество кодов');
  if (new Set(codes).size !== codes.length) throw new Error('СУЗ вернул повторяющиеся коды');
  const expectedPrefix = `01${job.gtin}`;
  if (codes.some(code => !String(code).startsWith(expectedPrefix))) throw new Error('Получен код с чужим GTIN');
}

async function waitForBuffer(intent, job) {
    const status = await suz.orderStatus({ orderId: intent.orderId, gtin: intent.gtin });
    if (!status.ok) throw new Error(status.error || 'Не удалось проверить буфер СУЗ');
    const buffer = Array.isArray(status.buffers) ? status.buffers[0] : null;
    if (buffer?.rejectionReason) throw Object.assign(new Error(`СУЗ отклонил заказ: ${buffer.rejectionReason}`), { permanent: true });
    if (String(buffer?.bufferStatus || '').toUpperCase() === 'ACTIVE' && Number(buffer?.availableCodes || 0) >= intent.quantity) {
      db.upsertAutomationIntent({ clientRequestId: intent.clientRequestId, state: 'BUFFER_ACTIVE' });
      if (job.state !== 'BUFFER_ACTIVE') await progress(job, 'BUFFER_ACTIVE', { externalOrderId: intent.orderId });
      return true;
    }
  return false;
}

function markLocalApplied(intent, reportId) {
  const finalIntent = db.upsertAutomationIntent({
    clientRequestId: intent.clientRequestId,
    state: 'APPLIED',
    reportId,
    reportStatus: 'SUCCESS'
  });
  const order = db.findOrder(finalIntent.orderId);
  if (order) {
    order.status = 'APPLIED';
    order.appliedAt = order.appliedAt || Date.now();
    order.utilisedAt = order.utilisedAt || order.appliedAt;
    order.utilisationReportId = reportId;
    order.utilisationReportStatus = 'SUCCESS';
    order.productionDate = finalIntent.productionDate;
    order.expirationDate = finalIntent.expirationDate;
    db.save();
  }
  if (!db.get().operations.some(item => item.type === 'utilisation' && item.clientRequestId === intent.clientRequestId)) {
    db.addOperation({
      type: 'utilisation',
      clientRequestId: intent.clientRequestId,
      orderId: finalIntent.orderId,
      gtin: finalIntent.gtin,
      quantity: finalIntent.quantity,
      spendKop: 0,
      note: 'Автоматический отчёт о нанесении подтверждён СУЗ (SUCCESS); ввод в оборот ещё не выполнен'
    });
  }
  return finalIntent;
}

async function ensureIntroductionReady(intent) {
  const readiness = await trueapi.productReadiness(intent.gtin);
  if (!readiness.ok) throw new Error(readiness.error || 'Не удалось проверить карточку товара');
  if (!readiness.signed || !readiness.markReady || !readiness.turnReady) {
    const error = new Error('Карточка товара не готова к маркировке или вводу в оборот');
    error.permanent = true;
    throw error;
  }
  if (readiness.vetControlled) {
    const error = new Error('Для товара требуется площадка ВетИС; автоматический ввод остановлен');
    error.permanent = true;
    throw error;
  }
  const product = await trueapi.productInfo([intent.gtin]);
  if (!product.ok) throw new Error(product.error || 'Не удалось получить данные товара');
  const tnved = String(product.results?.[0]?.tnVedCode10 || '');
  if (!/^\d{10}$/.test(tnved)) {
    const error = new Error('В карточке товара отсутствует корректный код ТН ВЭД');
    error.permanent = true;
    throw error;
  }
  const identities = intent.codes.map(identityPart);
  if (identities.length !== intent.quantity || new Set(identities).size !== identities.length) {
    const error = new Error('Количество или уникальность кодов не совпадает с заданием');
    error.permanent = true;
    throw error;
  }
  const info = await trueapi.cisesInfo(identities);
  if (!info.ok) throw new Error(info.error || 'Не удалось проверить коды перед вводом в оборот');
  const statuses = collectStatuses(info.results);
  if (statuses.length !== identities.length || statuses.some(value => value !== 'APPLIED')) {
    const error = new Error('Не все коды получили статус «Нанесён»; ввод в оборот остановлен');
    error.permanent = true;
    throw error;
  }
  return { identities, tnved };
}

function markLocalIntroduced(intent, documentId) {
  const finalIntent = db.upsertAutomationIntent({
    clientRequestId: intent.clientRequestId,
    state: 'INTRODUCED',
    introductionDocumentId: documentId,
    introductionDocumentStatus: 'CHECKED_OK',
    introducedAt: Date.now(),
    lastError: null,
  });
  const order = db.findOrder(finalIntent.orderId);
  if (order) {
    order.status = 'INTRODUCED';
    order.introducedAt = order.introducedAt || Date.now();
    order.introductionDocumentId = documentId;
    order.introductionDocumentStatus = 'CHECKED_OK';
    db.save();
  }
  if (!db.get().operations.some(item => item.type === 'introduction' && item.clientRequestId === intent.clientRequestId)) {
    db.addOperation({
      type: 'introduction',
      clientRequestId: intent.clientRequestId,
      orderId: finalIntent.orderId,
      gtin: finalIntent.gtin,
      quantity: finalIntent.quantity,
      spendKop: 0,
      note: 'Автоматический ввод удалённого задания: документ CHECKED_OK, все КИ INTRODUCED'
    });
  }
  return finalIntent;
}

async function pollIntroduction(intent, job) {
  const documentId = intent.introductionDocumentId;
  if (!documentId) throw new Error('Нет идентификатора документа ввода в оборот');
  if (job.state !== 'INTRODUCTION_PENDING') {
    await progress(job, 'INTRODUCTION_PENDING', { externalOrderId: intent.orderId, externalReportId: documentId });
  }
    const result = await trueapi.documentInfo(documentId);
    if (!result.ok) throw new Error(result.error || 'Не удалось проверить документ ввода');
    const documentStatus = result.document?.status || 'PROCESSING';
    db.upsertAutomationIntent({ clientRequestId: intent.clientRequestId, introductionDocumentStatus: documentStatus });
    if (documentStatus === 'CHECKED_NOT_OK') {
      const error = new Error('Честный ЗНАК отклонил документ ввода в оборот');
      error.permanent = true;
      throw error;
    }
    if (documentStatus === 'CHECKED_OK') {
      const identities = intent.codes.map(identityPart);
      const info = await trueapi.cisesInfo(identities);
      if (info.ok) {
        const statuses = collectStatuses(info.results);
        if (statuses.length === identities.length && statuses.every(value => value === 'INTRODUCED')) {
          markLocalIntroduced(intent, documentId);
          await progress(job, 'INTRODUCED', { externalOrderId: intent.orderId, externalReportId: documentId });
          return;
        }
      }
    }
  // Yield to other parties while CHZ processes this document. Its ID is durable.
}

async function finishIntroduction(intent, job) {
  if (intent.state === 'INTRODUCED') {
    if (job.state !== 'INTRODUCED') await progress(job, 'INTRODUCED', { externalOrderId: intent.orderId, externalReportId: intent.introductionDocumentId });
    return;
  }
  if (intent.introductionDocumentId) return pollIntroduction(intent, job);
  if (intent.state === 'INTRODUCTION_SUBMITTING') {
    db.upsertAutomationIntent({ clientRequestId: intent.clientRequestId, state: 'INTRODUCTION_UNKNOWN', lastError: 'Перезапуск во время отправки документа' });
    await progress(job, 'INTRODUCTION_UNKNOWN', { externalOrderId: intent.orderId, error: 'Предыдущая отправка ввода могла дойти до Честного ЗНАКа; повтор заблокирован' });
    return;
  }
  const ready = await ensureIntroductionReady(intent);
  db.upsertAutomationIntent({ clientRequestId: intent.clientRequestId, state: 'INTRODUCTION_SUBMITTING', introductionAttemptAt: Date.now() });
  await progress(job, 'INTRODUCTION_SUBMITTING', { externalOrderId: intent.orderId });
  let result;
  try {
    result = await trueapi.createDocument({
      type: 'LP_INTRODUCE_GOODS',
      pg: cfg.productGroup,
      bodyObj: {
        participant_inn: cfg.orgInn,
        producer_inn: cfg.orgInn,
        owner_inn: cfg.orgInn,
        production_date: intent.productionDate,
        production_type: 'OWN_PRODUCTION',
        products: ready.identities.map(uit_code => ({ uit_code, tnved_code: ready.tnved }))
      }
    });
  } catch (error) {
    db.upsertAutomationIntent({ clientRequestId: intent.clientRequestId, state: 'INTRODUCTION_UNKNOWN', lastError: safeMessage(error.message) });
    await progress(job, 'INTRODUCTION_UNKNOWN', { externalOrderId: intent.orderId, error: 'Связь прервалась во время отправки ввода; повтор заблокирован' });
    return;
  }
  if (!result.ok || !result.docId) {
    retryBeforeSubmit(intent, result, 'APPLIED');
    if (result.stage === 'submit') {
      db.upsertAutomationIntent({ clientRequestId: intent.clientRequestId, state: 'INTRODUCTION_UNKNOWN', lastError: safeMessage(result.error) });
      await progress(job, 'INTRODUCTION_UNKNOWN', { externalOrderId: intent.orderId, error: result.error || 'Результат отправки ввода неизвестен' });
      return;
    }
    throw new Error(result.error || 'Честный ЗНАК не вернул номер документа ввода в оборот');
  }
  intent = db.upsertAutomationIntent({
    clientRequestId: intent.clientRequestId,
    state: 'INTRODUCTION_PENDING',
    introductionDocumentId: result.docId,
    introductionDocumentStatus: 'SUBMITTED',
    introductionSubmittedAt: Date.now(),
  });
  await progress(job, 'INTRODUCTION_SUBMITTED', { externalOrderId: intent.orderId, externalReportId: result.docId });
  await pollIntroduction(intent, job);
}

async function pollUtilisationReport(intent, job) {
  const reportId = intent.reportId;
  if (!reportId) throw new Error('Нет reportId для безопасного продолжения проверки отчёта');
  if (job.state !== 'UTILISATION_PENDING') {
    await progress(job, 'UTILISATION_PENDING', { externalOrderId: intent.orderId, externalReportId: reportId });
  }
    const report = await suz.reportInfo({ reportId });
    if (!report.ok) throw new Error(report.error || 'Не удалось проверить отчёт СУЗ');
    if (report.ok && report.reportStatus === 'SUCCESS') {
      markLocalApplied(intent, reportId);
      await progress(job, 'APPLIED', { externalOrderId: intent.orderId, externalReportId: reportId });
      return;
    }
    if (report.ok && TERMINAL_REPORT_STATES.has(report.reportStatus)) {
      const error = new Error(`Отчёт СУЗ завершился со статусом ${report.reportStatus}: ${report.errorReason || 'причина не указана'}`);
      error.permanent = true;
      throw error;
    }
  // Pending is a normal state, not a reason to hold the entire queue.
}

async function finishUtilisation(intent, job) {
  const result = await suz.utilisation({
    sntins: intent.codes,
    productionDate: intent.productionDate,
    expirationDate: intent.expirationDate,
    verifyTimeoutMs: 0,
  });
  if (!result.reportId && !result.ok) retryBeforeSubmit(intent, result, 'CODES_RECEIVED');
  if (result.reportId) {
    intent = db.upsertAutomationIntent({
      clientRequestId: intent.clientRequestId,
      reportId: result.reportId,
      reportStatus: result.reportStatus || 'PENDING',
      state: result.ok ? 'APPLIED' : 'UTILISATION_PENDING',
    });
  }
  if (result.ok && result.reportStatus === 'SUCCESS') {
    markLocalApplied(intent, result.reportId);
    await progress(job, 'APPLIED', { externalOrderId: intent.orderId, externalReportId: result.reportId });
    return;
  }
  if (!result.reportId) {
    db.upsertAutomationIntent({ clientRequestId: intent.clientRequestId, state: 'UTILISATION_UNKNOWN', lastError: result.error });
    await progress(job, 'UTILISATION_UNKNOWN', { externalOrderId: intent.orderId, error: result.error });
    return;
  }
  await pollUtilisationReport(intent, job);
}

async function processJob(job) {
  let validated, intent;
  try { validated = ensureJobIsAllowed(job); intent = prepareIntent(job, validated); }
  catch (error) { error.permanent = true; throw error; }
  if (['SUBMIT_UNKNOWN', 'UTILISATION_UNKNOWN', 'INTRODUCTION_UNKNOWN', 'FAILED'].includes(intent.state)) {
    await progress(job, intent.state, { error: intent.lastError || `Требуется проверка состояния ${intent.state}` });
    return;
  }

  if (!intent.orderId) {
    if (intent.state === 'ORDER_SUBMITTING') {
      await progress(job, 'SUBMIT_UNKNOWN', { error: 'Предыдущая отправка заказа завершилась неоднозначно; слепой повтор запрещён' });
      db.upsertAutomationIntent({ clientRequestId: intent.clientRequestId, state: 'SUBMIT_UNKNOWN' });
      return;
    }
    if (job.state === 'CLAIMED') await progress(job, 'SIGNER_READY');
    db.upsertAutomationIntent({ clientRequestId: intent.clientRequestId, state: 'ORDER_SUBMITTING' });
    await progress(job, 'ORDER_SUBMITTING');
    const result = await suz.createOrder({
      gtin: intent.gtin,
      quantity: intent.quantity,
      templateId: 30,
      releaseMethodType: 'PRODUCTION',
      paymentType: 1,
      productionOrderId: intent.productionOrderId,
      serials: intent.serials,
    });
    if (!result.ok) {
      // These failures are proven to precede the paid /order POST. Retry the
      // same durable intent, never a new order or new serials. Unknown submit
      // results must still take the SUBMIT_UNKNOWN path below.
      retryBeforeSubmit(intent, result, 'CLAIMED');
      const state = result.stage === 'submit' ? 'SUBMIT_UNKNOWN' : 'FAILED';
      db.upsertAutomationIntent({ clientRequestId: intent.clientRequestId, state, lastError: result.error });
      await progress(job, state, { error: result.error });
      return;
    }
    const spendKop = intent.quantity * cfg.tariff.grossKop;
    db.upsertOrder({
      id: result.orderId,
      clientRequestId: intent.clientRequestId,
      gtin: intent.gtin,
      name: intent.productName,
      quantity: intent.quantity,
      productionOrderId: intent.productionOrderId,
      serials: intent.serials,
      status: 'CREATED',
      createdAt: Date.now(),
      expectedMs: result.expectedCompleteTimestamp,
      spendKop,
      codes: [],
      utilisedAt: null,
    });
    if (!db.get().operations.some(item => item.type === 'order' && item.clientRequestId === intent.clientRequestId)) {
      db.addOperation({ type: 'order', clientRequestId: intent.clientRequestId, orderId: result.orderId, gtin: intent.gtin, quantity: intent.quantity, spendKop, note: 'Автоматический заказ КМ из сайта сборки' });
      const data = db.get();
      if (!data.settings) data.settings = { balanceKop: 0 };
      data.settings.balanceKop = Number(data.settings.balanceKop || 0) - spendKop;
      db.save();
    }
    intent = db.upsertAutomationIntent({ clientRequestId: intent.clientRequestId, state: 'ORDER_CREATED', orderId: result.orderId });
    await progress(job, 'ORDER_CREATED', { externalOrderId: intent.orderId });
  }

  if (intent.orderId && job.state === 'ORDER_SUBMITTING') {
    await progress(job, 'ORDER_CREATED', { externalOrderId: intent.orderId });
  }

  if (!intent.codes?.length) {
    if (!await waitForBuffer(intent, job)) return;
    const received = await suz.getCodes({ orderId: intent.orderId, gtin: intent.gtin, quantity: intent.quantity });
    if (!received.ok) throw new Error(received.error || 'Не удалось получить коды СУЗ');
    validateCodes(received.codes, job);
    intent = db.upsertAutomationIntent({ clientRequestId: intent.clientRequestId, state: 'CODES_RECEIVED', codes: received.codes, blockId: received.blockId });
    const order = db.findOrder(intent.orderId);
    if (order) { order.codes = received.codes; order.blockId = received.blockId; order.status = 'CODES_RECEIVED'; db.save(); }
    await progress(job, 'CODES_RECEIVED', { externalOrderId: intent.orderId });
  }

  if (intent.state === 'UTILISATION_PENDING' && intent.reportId) {
    await pollUtilisationReport(intent, job);
  } else if (!['APPLIED', 'INTRODUCTION_SUBMITTING', 'INTRODUCTION_PENDING', 'INTRODUCED'].includes(intent.state)) {
    if (intent.state === 'UTILISATION_SUBMITTING') {
      await progress(job, 'UTILISATION_UNKNOWN', { externalOrderId: intent.orderId, error: 'Предыдущий отчёт мог быть отправлен; повторная отправка заблокирована' });
      db.upsertAutomationIntent({ clientRequestId: intent.clientRequestId, state: 'UTILISATION_UNKNOWN' });
      return;
    }
    db.upsertAutomationIntent({ clientRequestId: intent.clientRequestId, state: 'UTILISATION_SUBMITTING' });
    await progress(job, 'UTILISATION_SUBMITTING', { externalOrderId: intent.orderId });
    await finishUtilisation(intent, job);
  }

  intent = db.findAutomationIntent(job.clientRequestId);
  if (['APPLIED', 'INTRODUCTION_SUBMITTING', 'INTRODUCTION_PENDING', 'INTRODUCED'].includes(intent?.state)) {
    await finishIntroduction(intent, job);
  }
}

async function cycle() {
  if (!cfg.bridge.enabled || cfg.bridge.secret.length < 32 || running || performance.now() < retryAfter) return;
  running = true;
  lastPollAt = Date.now();
  try {
    const response = await requestJson('POST', `${cfg.bridge.url}/jobs/claim`, {
      scheduler: 'steps-v1',
      catalog: catalogSnapshot(),
      status: telemetry()
    });
    await uploadRequestedArtifacts(response.artifactRequests);
    const checkRequest = response.signatureCheck;
    if (checkRequest?.id && signatureState().lastRequest?.id !== checkRequest.id) {
      await checkSignature(checkRequest.id);
      return;
    }
    const signature = signatureState();
    if (signature.blocked) {
      if (Math.abs(Date.now() - Number(signature.checkedAt || 0)) >= 60000) await checkSignature();
      return;
    }
    const job = response.job || null;
    if (!job && (!signature.lastSuccessAt || Math.abs(Date.now() - signature.lastSuccessAt) >= 60000)) {
      await checkSignature();
      return;
    }
    current = job;
    if (job) {
      if (Math.abs(transport.clockStatus().clockOffsetMs) > 120000) {
        throw new Error('Часы Windows требуют синхронизации. Выпуск приостановлен; связь с сайтом сохранена.');
      }
      try {
        if (!await ensureSigningAvailable()) return;
        await processJob(job);
      } catch (error) {
        const message = safeMessage(error?.message || error);
        const canFail = error?.permanent;
        if (canFail) {
          db.upsertAutomationIntent({ clientRequestId: job.clientRequestId, state: 'FAILED', lastError: message });
          await progress(job, 'FAILED', { error: message });
        } else {
          // A per-party read failure must not suspend unrelated parties.
          // No state rollback: SUBMITTING still becomes UNKNOWN on resumption.
          await requestJson('POST', `${cfg.bridge.url}/jobs/${job.id}/defer`, {
            leaseToken: job.leaseToken, error: message
          });
        }
        console.error('[chz-worker job]', job.id, message);
      }
    }
    lastError = null;
    failures = 0;
    retryAfter = 0;
  } catch (error) {
    lastError = safeMessage(error?.message || error);
    failures += 1;
    retryAfter = performance.now() + Math.min(60000, 2000 * (2 ** Math.min(failures, 5)));
    console.error('[chz-worker]', lastError);
  } finally {
    current = null;
    running = false;
  }
}

function start() {
  if (!cfg.bridge.enabled) return { enabled: false };
  if (cfg.bridge.secret.length < 32) throw new Error('CHZ worker secret must contain at least 32 characters');
  if (timer) return { enabled: true };
  refreshSigner().catch(() => {});
  setInterval(() => refreshSigner().catch(() => {}), 30000).unref();
  timer = setInterval(() => cycle().catch(() => {}), cfg.bridge.pollMs);
  timer.unref();
  heartbeatTimer = setInterval(() => heartbeat().catch(() => {}), 10000);
  heartbeatTimer.unref();
  setTimeout(() => cycle().catch(() => {}), 1000).unref();
  setTimeout(() => heartbeat().catch(() => {}), 500).unref();
  return { enabled: true };
}

function status() {
  return {
    enabled: cfg.bridge.enabled,
    configured: cfg.bridge.secret.length >= 32,
    workerId: cfg.bridge.workerId,
    running,
    currentJobId: current?.id || null,
    currentState: current?.state || null,
    lastPollAt,
    lastError,
    lastHeartbeatAt,
    lastHeartbeatError,
    version: VERSION,
    signature: signatureState(),
    signer: signerSnapshot,
    retryInMs: Math.max(0, Math.round(retryAfter - performance.now())),
    ...transport.clockStatus(),
  };
}

async function reportPrintAttempt(jobId, payload) {
  if (!cfg.bridge.enabled || cfg.bridge.secret.length < 32) return { ok: false, skipped: true };
  return requestJson('POST', `${cfg.bridge.url}/jobs/${encodeURIComponent(jobId)}/print`, payload || {});
}

module.exports = { start, status, reportPrintAttempt, ensureJobIsAllowed, payloadFingerprint, validateCodes, normalizeAllocations, renderLabelsArtifact };
