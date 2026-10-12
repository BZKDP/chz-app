'use strict';
// Простое JSON-хранилище (без нативных зависимостей). Единственный пользователь — локальное приложение.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const DEFAULT = {
  products: [
    // Тестовый товар из интеграции
    { id: 'p1', name: 'Тестовый БАД', gtin: '04627174095012', templateId: 30, expirationDays: 730 }
  ],
  orders: [],       // { id(orderId), gtin, name, quantity, productionOrderId, status, createdAt, expectedMs, spendKop, codes:[], utilisedAt, ... }
  bulkBatches: [],  // durable employee bulk-order queues; raw KM remain only in orders
  automationIntents: [], // durable idempotency state for sborka CHZ jobs
  chzPrintAttempts: [], // локальный аудит: коды не покидают этот компьютер
  operations: []    // { id, ts, type: 'order'|'utilisation'|'dropout', orderId, gtin, quantity, spendKop, note }
};

let data = null;

function load() {
  try {
    data = JSON.parse(fs.readFileSync(cfg.dbFile, 'utf8'));
    for (const k of Object.keys(DEFAULT)) if (!(k in data)) data[k] = DEFAULT[k];
  } catch (error) {
    // A damaged existing database must not become an empty order history.
    if (error.code !== 'ENOENT') throw new Error('CHZ database cannot be read; processing stopped to prevent duplicate orders', { cause: error });
    data = JSON.parse(JSON.stringify(DEFAULT));
    save();
  }
  return data;
}

function save() {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const temporary = cfg.dbFile + '.tmp';
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, cfg.dbFile);
}

function get() { if (!data) load(); return data; }

function addOperation(op) {
  const d = get();
  op.id = op.id || `op_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;
  op.ts = op.ts || Date.now();
  d.operations.unshift(op);
  save();
  return op;
}

function upsertOrder(order) {
  const d = get();
  const i = d.orders.findIndex(o => o.id === order.id);
  if (i >= 0) d.orders[i] = Object.assign(d.orders[i], order);
  else d.orders.unshift(order);
  save();
  return d.orders.find(o => o.id === order.id);
}

function findOrder(id) { return get().orders.find(o => o.id === id); }

function upsertBulkBatch(batch) {
  const d = get();
  const id = String(batch && batch.id || '');
  if (!id) throw new Error('id массового выпуска обязателен');
  const i = d.bulkBatches.findIndex(item => item.id === id);
  const now = Date.now();
  if (i >= 0) d.bulkBatches[i] = Object.assign(d.bulkBatches[i], batch, { updatedAt: now });
  else d.bulkBatches.unshift(Object.assign({ createdAt: now }, batch, { id, updatedAt: now }));
  save();
  return d.bulkBatches.find(item => item.id === id);
}

function findBulkBatch(id) { return get().bulkBatches.find(item => item.id === String(id || '')); }

function upsertAutomationIntent(intent) {
  const d = get();
  const key = String(intent && intent.clientRequestId || '');
  if (!key) throw new Error('clientRequestId обязателен');
  const i = d.automationIntents.findIndex(item => item.clientRequestId === key);
  const now = Date.now();
  if (i >= 0) d.automationIntents[i] = Object.assign(d.automationIntents[i], intent, { updatedAt: now });
  else d.automationIntents.unshift(Object.assign({ createdAt: now }, intent, { clientRequestId: key, updatedAt: now }));
  save();
  return d.automationIntents.find(item => item.clientRequestId === key);
}

function findAutomationIntent(clientRequestId) {
  return get().automationIntents.find(item => item.clientRequestId === String(clientRequestId || ''));
}

function addChzPrintAttempt(attempt) {
  const d = get();
  const row = Object.assign({
    token: `print_${Date.now()}_${Math.floor(Math.random() * 1e9)}`,
    state: 'PREPARED',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }, attempt || {});
  d.chzPrintAttempts.unshift(row);
  save();
  return row;
}

function findChzPrintAttempt(token) {
  return get().chzPrintAttempts.find(item => item.token === String(token || ''));
}

function updateChzPrintAttempt(token, patch) {
  const row = findChzPrintAttempt(token);
  if (!row) return null;
  Object.assign(row, patch || {}, { updatedAt: Date.now() });
  save();
  return row;
}

module.exports = {
  load, save, get, addOperation, upsertOrder, findOrder,
  upsertBulkBatch, findBulkBatch,
  upsertAutomationIntent, findAutomationIntent,
  addChzPrintAttempt, findChzPrintAttempt, updateChzPrintAttempt
};
