'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const db = require('./db');
const suz = require('./suz');
const trueapi = require('./trueapi');
const orderAutomation = require('./order-automation');

const POLL_MS = 3500;
const TERMINAL_BATCHES = new Set(['ISSUED', 'ATTENTION', 'CANCELLED']);
let timer = null;
let running = false;
let currentBatchId = null;
let lastCycleAt = null;
let lastError = null;

function safeMessage(value) {
  return String(value || 'Неизвестная ошибка')
    .replace(/01\d{14}21[^\s,}"']+/g, '[код скрыт]')
    .replace(/[A-Za-z0-9+/=_-]{48,}/g, '[данные скрыты]')
    .slice(0, 1000);
}

function backupDatabase(batch) {
  if (batch.backupPath) return batch.backupPath;
  const backupDir = path.join(cfg.dataDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupDir, `before-bulk-${batch.id}-${stamp}.json`);
  fs.copyFileSync(cfg.dbFile, target);
  batch.backupPath = target;
  db.save();
  return target;
}

function appendActivity(batch, label, tone = 'progress') {
  if (!Array.isArray(batch.activity)) batch.activity = [];
  batch.activity.unshift({ label, tone, at: Date.now() });
  batch.activity = batch.activity.slice(0, 30);
}

function pause(batch, item, message) {
  const safe = safeMessage(message);
  if (item) {
    item.state = 'ATTENTION';
    item.lastError = safe;
  }
  batch.state = 'ATTENTION';
  batch.lastError = safe;
  batch.nextAt = null;
  appendActivity(batch, safe, 'error');
  db.save();
}

function retry(batch, item, message) {
  const count = Number(item.retryCount || 0) + 1;
  const delay = Math.min(5 * 60 * 1000, 5000 * Math.pow(2, Math.min(count - 1, 6)));
  item.state = 'RETRYING';
  item.retryCount = count;
  item.lastError = safeMessage(message);
  item.nextAt = Date.now() + delay;
  batch.state = 'ISSUING';
  batch.nextAt = item.nextAt;
  db.save();
}

async function processItem(batch, item) {
  if (item.state === 'ORDER_SUBMITTING') {
    const submittedIntent = db.findAutomationIntent(item.clientRequestId);
    if (submittedIntent?.orderId) {
      item.orderId = submittedIntent.orderId;
      item.state = 'ORDER_CREATED';
      item.lastError = null;
      db.save();
      orderAutomation.kick(submittedIntent.orderId);
      return;
    }
    pause(batch, item, 'Сервер был перезапущен во время отправки платного заказа. Повтор заблокирован до сверки с СУЗ.');
    return;
  }
  const readiness = await trueapi.productReadiness(item.gtin);
  if (!readiness.ok) return retry(batch, item, readiness.error || 'Не удалось проверить карточку товара');
  if (!readiness.signed || !readiness.markReady || !readiness.turnReady) {
    pause(batch, item, `Карточка «${item.name}» больше не готова к заказу или вводу в оборот.`);
    return;
  }
  if (readiness.vetControlled) {
    pause(batch, item, `Карточка «${item.name}» требует площадку ВетИС. Массовый выпуск остановлен для ручной проверки.`);
    return;
  }

  let intent = db.findAutomationIntent(item.clientRequestId);
  if (!intent) {
    intent = {
      clientRequestId: item.clientRequestId,
      bulkBatchId: batch.id,
      bulkItemId: item.id,
      gtin: item.gtin,
      quantity: item.quantity,
      templateId: 30,
      releaseMethodType: 'PRODUCTION',
      paymentType: 1,
      cisType: 'UNIT',
      automationMode: 'FULL',
      productionDate: item.productionDate,
      expirationDate: item.expirationDate,
      productionOrderId: crypto.randomUUID(),
      serials: suz.genSerials(item.quantity),
      state: 'INTENT_READY'
    };
    db.upsertAutomationIntent(intent);
  } else if (intent.orderId) {
    item.orderId = intent.orderId;
    item.state = 'ORDER_CREATED';
    db.save();
    return;
  } else if (intent.state === 'ORDER_SUBMITTING' || intent.state === 'SUBMIT_UNKNOWN') {
    pause(batch, item, `Результат предыдущей отправки заказа для «${item.name}» неизвестен. Повтор заблокирован.`);
    return;
  }

  item.state = 'ORDER_SUBMITTING';
  item.lastError = null;
  batch.state = 'ISSUING';
  appendActivity(batch, `Заказываем 1 код: ${item.name}`);
  db.upsertAutomationIntent({ clientRequestId: item.clientRequestId, state: 'ORDER_SUBMITTING' });
  db.save();

  let result;
  try {
    result = await suz.createOrder({
      gtin: item.gtin,
      quantity: item.quantity,
      templateId: 30,
      cisType: 'UNIT',
      releaseMethodType: 'PRODUCTION',
      paymentType: 1,
      productionOrderId: intent.productionOrderId,
      serials: intent.serials
    });
  } catch (error) {
    db.upsertAutomationIntent({ clientRequestId: item.clientRequestId, state: 'SUBMIT_UNKNOWN', lastError: safeMessage(error.message) });
    pause(batch, item, `Связь прервалась во время заказа «${item.name}». Повтор заблокирован до сверки с СУЗ.`);
    return;
  }

  if (!result.ok) {
    const ambiguous = result.stage === 'submit';
    db.upsertAutomationIntent({
      clientRequestId: item.clientRequestId,
      state: ambiguous ? 'SUBMIT_UNKNOWN' : 'FAILED_BEFORE_SUBMIT',
      lastError: safeMessage(result.error)
    });
    if (ambiguous) pause(batch, item, `Честный ЗНАК не подтвердил результат заказа «${item.name}». Повтор заблокирован.`);
    else retry(batch, item, result.error || `Не удалось подписать заказ «${item.name}»`);
    return;
  }

  const spendKop = item.quantity * cfg.tariff.grossKop;
  db.upsertOrder({
    id: result.orderId,
    gtin: item.gtin,
    name: item.name,
    quantity: item.quantity,
    clientRequestId: item.clientRequestId,
    bulkBatchId: batch.id,
    productionOrderId: result.productionOrderId,
    serials: result.serials,
    status: 'CREATED',
    createdAt: Date.now(),
    expectedMs: result.expectedCompleteTimestamp,
    spendKop,
    codes: [],
    utilisedAt: null,
    releaseMethodType: 'PRODUCTION',
    cisType: 'UNIT',
    productionDate: item.productionDate,
    expirationDate: item.expirationDate,
    automationMode: 'FULL',
    automationState: 'QUEUED',
    automationNextAt: Date.now(),
    automationRetryCount: 0,
    automationLastError: null,
    createdBy: batch.createdBy,
    activity: [{ key: 'order-created', label: 'Заказ создан в составе массового выпуска', tone: 'success', at: Date.now() }]
  });
  db.upsertAutomationIntent({ clientRequestId: item.clientRequestId, state: 'ORDER_CREATED', orderId: result.orderId });
  db.addOperation({ type: 'order', orderId: result.orderId, gtin: item.gtin, quantity: item.quantity, spendKop, note: `Массовый выпуск ${batch.id}` });
  const settings = db.get().settings;
  if (settings && Number.isFinite(Number(settings.balanceKop))) settings.balanceKop -= spendKop;
  item.orderId = result.orderId;
  item.state = 'ORDER_CREATED';
  item.retryCount = 0;
  item.nextAt = null;
  appendActivity(batch, `Заказ создан: ${item.name}`, 'success');
  db.save();
  orderAutomation.kick(result.orderId);
}

async function cycle() {
  if (running) return;
  running = true;
  lastCycleAt = Date.now();
  try {
    const now = Date.now();
    const batch = db.get().bulkBatches
      .filter(row => !TERMINAL_BATCHES.has(row.state))
      .filter(row => !row.nextAt || Number(row.nextAt) <= now)
      .sort((a, b) => Number(a.createdAt) - Number(b.createdAt))[0];
    currentBatchId = batch?.id || null;
    if (!batch) return;
    backupDatabase(batch);
    const item = batch.items.find(row => !['ORDER_CREATED', 'SKIPPED'].includes(row.state) && (!row.nextAt || Number(row.nextAt) <= now));
    if (!item) {
      if (batch.items.every(row => row.state === 'ORDER_CREATED' || row.state === 'SKIPPED')) {
        batch.state = 'ISSUED';
        batch.nextAt = null;
        appendActivity(batch, 'Все платные заказы созданы. Партии обрабатываются автоматически.', 'success');
        db.save();
      }
      return;
    }
    await processItem(batch, item);
    lastError = null;
  } catch (error) {
    lastError = safeMessage(error?.message || error);
    const batch = currentBatchId ? db.findBulkBatch(currentBatchId) : null;
    if (batch) {
      batch.nextAt = Date.now() + 10000;
      batch.lastError = lastError;
      db.save();
    }
  } finally {
    currentBatchId = null;
    running = false;
  }
}

function start() {
  if (timer) return status();
  timer = setInterval(() => cycle().catch(error => { lastError = safeMessage(error?.message || error); }), POLL_MS);
  timer.unref();
  setTimeout(() => cycle().catch(error => { lastError = safeMessage(error?.message || error); }), 700).unref();
  return status();
}

function kick(batchId) {
  const batch = db.findBulkBatch(batchId);
  if (batch && batch.state !== 'ATTENTION') {
    batch.nextAt = Date.now();
    db.save();
  }
  setTimeout(() => cycle().catch(error => { lastError = safeMessage(error?.message || error); }), 50).unref();
}

function batchSummary(batch) {
  const orders = batch.items.map(item => item.orderId && db.findOrder(item.orderId)).filter(Boolean);
  const issuedCount = batch.items.filter(item => item.orderId).length;
  const readyCount = orders.filter(order => order.status === 'INTRODUCED' && order.introductionDocumentStatus === 'CHECKED_OK').length;
  const orderAttention = orders.filter(order => order.automationState === 'ATTENTION').length;
  const attention = batch.state === 'ATTENTION' || orderAttention > 0;
  const ready = issuedCount === batch.items.length && readyCount === batch.items.length;
  const publicStatus = ready
    ? { code: 'READY', label: 'Все коды готовы к печати', tone: 'success' }
    : attention
      ? { code: 'ATTENTION', label: 'Требуется проверка', tone: 'danger' }
      : { code: 'PROCESSING', label: batch.state === 'ISSUED' ? 'Обрабатываем коды' : 'Создаём заказы', tone: 'progress' };
  return {
    id: batch.id,
    createdAt: batch.createdAt,
    createdBy: batch.createdBy,
    state: batch.state,
    itemCount: batch.items.length,
    totalQuantity: batch.totalQuantity,
    totalCostKop: batch.totalCostKop,
    issuedCount,
    readyCount,
    attentionCount: Number(attention),
    lastError: batch.lastError || orders.find(order => order.automationState === 'ATTENTION')?.automationLastError || null,
    publicStatus,
    activity: Array.isArray(batch.activity) ? batch.activity.slice(0, 20) : [],
    items: batch.items.map(item => {
      const order = item.orderId ? db.findOrder(item.orderId) : null;
      return {
        id: item.id,
        gtin: item.gtin,
        name: item.name,
        quantity: item.quantity,
        productionDate: item.productionDate,
        expirationDate: item.expirationDate,
        state: item.state,
        orderId: item.orderId || null,
        lastError: item.lastError || order?.automationLastError || null,
        publicStatus: order ? orderAutomation.publicStatus(order) : null
      };
    })
  };
}

function status() {
  const batches = db.get().bulkBatches;
  return {
    enabled: Boolean(timer),
    running,
    currentBatchId,
    lastCycleAt,
    lastError,
    activeCount: batches.filter(row => !TERMINAL_BATCHES.has(row.state)).length,
    attentionCount: batches.filter(row => row.state === 'ATTENTION').length
  };
}

module.exports = { start, kick, cycle, status, batchSummary };
