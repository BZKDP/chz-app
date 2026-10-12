'use strict';

const cfg = require('./config');
const db = require('./db');
const suz = require('./suz');
const trueapi = require('./trueapi');

const TERMINAL_REPORTS = new Set(['REJECTED', 'FAILED', 'PARTIALLY']);
const TERMINAL_ORDERS = new Set(['INTRODUCED', 'WITHDRAWN', 'WITHDRAWN_AUTO_SET']);
const POLL_MS = 4000;
let timer = null;
let running = false;
let currentOrderId = null;
let lastCycleAt = null;
let lastError = null;

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

function isManaged(order) {
  return order && order.automationMode === 'FULL' && order.releaseMethodType === 'PRODUCTION' && (order.cisType || 'UNIT') === 'UNIT';
}

function appendActivity(order, key, label, tone = 'progress') {
  if (!Array.isArray(order.activity)) order.activity = [];
  if (order.activity[0]?.key === key) return;
  order.activity.unshift({ key, label, tone, at: Date.now() });
  order.activity = order.activity.slice(0, 20);
}

function patch(order, values, activity = null) {
  Object.assign(order, values, { automationUpdatedAt: Date.now() });
  if (activity) appendActivity(order, activity.key, activity.label, activity.tone);
  db.save();
}

function schedule(order, delayMs = POLL_MS) {
  patch(order, {
    automationState: 'WAITING',
    automationNextAt: Date.now() + delayMs,
    automationRetryCount: 0,
    automationLastError: null
  });
}

function permanent(message, status) {
  const error = new Error(message);
  error.permanent = true;
  error.orderStatus = status;
  return error;
}

function ambiguous(message, status) {
  const error = new Error(message);
  error.ambiguous = true;
  error.orderStatus = status;
  return error;
}

function recordFailure(order, error) {
  const message = safeMessage(error?.message || error);
  if (error?.permanent || error?.ambiguous) {
    patch(order, {
      status: error.orderStatus || order.status,
      automationState: 'ATTENTION',
      automationLastError: message,
      automationNextAt: null
    }, { key: `attention:${error.orderStatus || order.status}`, label: message, tone: 'error' });
    return;
  }
  const retryCount = Number(order.automationRetryCount || 0) + 1;
  const delay = Math.min(5 * 60 * 1000, 5000 * Math.pow(2, Math.min(retryCount - 1, 6)));
  patch(order, {
    automationState: 'RETRYING',
    automationRetryCount: retryCount,
    automationLastError: message,
    automationNextAt: Date.now() + delay
  });
}

function validateCodes(codes, order) {
  if (!Array.isArray(codes) || codes.length !== Number(order.quantity)) throw permanent('Честный ЗНАК вернул другое количество кодов. Нужна проверка администратора.', 'CODES_INVALID');
  if (new Set(codes).size !== codes.length) throw permanent('Честный ЗНАК вернул повторяющиеся коды. Печать заблокирована.', 'CODES_INVALID');
  const prefix = `01${order.gtin}`;
  if (codes.some(code => !String(code).startsWith(prefix))) throw permanent('В партии обнаружен код другого товара. Печать заблокирована.', 'CODES_INVALID');
}

async function readiness(order) {
  const result = await trueapi.productReadiness(order.gtin);
  if (!result.ok) throw new Error(result.error || 'Не удалось проверить карточку товара');
  if (!result.signed || !result.markReady || !result.turnReady) {
    throw permanent('Карточка товара больше не готова к маркировке или вводу в оборот. Исправьте её в Национальном каталоге.', 'CARD_NOT_READY');
  }
  if (result.vetControlled) {
    throw permanent('Для товара требуется площадка ВетИС. Автоматическая обработка остановлена до проверки администратора.', 'VETIS_REQUIRED');
  }
  return result;
}

function markApplied(order, reportId) {
  order.status = 'APPLIED';
  order.appliedAt = order.appliedAt || Date.now();
  order.utilisedAt = order.utilisedAt || order.appliedAt;
  order.utilisationReportId = reportId;
  order.utilisationReportStatus = 'SUCCESS';
  appendActivity(order, 'applied', 'Нанесение кодов подтверждено', 'success');
  if (!db.get().operations.some(item => item.type === 'utilisation' && item.orderId === order.id)) {
    db.addOperation({ type: 'utilisation', orderId: order.id, gtin: order.gtin, quantity: order.quantity, spendKop: 0, note: 'Автоматический отчёт о нанесении подтверждён СУЗ (SUCCESS)' });
  } else db.save();
}

async function pollOrder(order) {
  const result = await suz.orderStatus({ orderId: order.id, gtin: order.gtin });
  if (!result.ok) throw new Error(result.error || 'Не удалось проверить готовность кодов');
  const buffer = Array.isArray(result.buffers) ? result.buffers[0] : null;
  if (!buffer) throw new Error('Честный ЗНАК пока не вернул состояние заказа');
  if (buffer.rejectionReason) throw permanent(`Заказ отклонён: ${safeMessage(buffer.rejectionReason)}`, 'ORDER_FAILED');
  const bufferStatus = String(buffer.bufferStatus || 'PENDING').toUpperCase();
  const ready = bufferStatus === 'ACTIVE' && Number(buffer.availableCodes || 0) >= Number(order.quantity);
  patch(order, {
    status: ready ? 'ACTIVE' : bufferStatus,
    availableCodes: Number(buffer.availableCodes || 0),
    totalCodes: Number(buffer.totalCodes || order.quantity)
  }, ready ? { key: 'buffer-active', label: 'Коды сформированы', tone: 'success' } : null);
  schedule(order, ready ? 1000 : 6000);
}

async function fetchCodes(order) {
  patch(order, { status: 'FETCHING_CODES', automationState: 'RUNNING' }, { key: 'fetching-codes', label: 'Получаем коды маркировки' });
  let result;
  try {
    result = await suz.getCodes({ orderId: order.id, gtin: order.gtin, quantity: order.quantity });
  } catch (error) {
    order.status = 'ACTIVE';
    throw error;
  }
  if (!result.ok) {
    order.status = 'ACTIVE';
    throw new Error(result.error || 'Коды пока не удалось получить');
  }
  validateCodes(result.codes, order);
  patch(order, {
    codes: result.codes,
    blockId: result.blockId,
    status: 'CODES_RECEIVED'
  }, { key: 'codes-received', label: `${result.codes.length} кодов получено`, tone: 'success' });
  schedule(order, 1000);
}

async function submitUtilisation(order) {
  await readiness(order);
  patch(order, { status: 'UTILISATION_SUBMITTING', automationState: 'RUNNING' }, { key: 'utilisation-submit', label: 'Отправляем отчёт о нанесении' });
  let result;
  try {
    result = await suz.utilisation({
      sntins: order.codes,
      productionDate: order.productionDate,
      expirationDate: order.expirationDate,
      verifyTimeoutMs: 10000
    });
  } catch (error) {
    throw ambiguous(`Связь прервалась во время отправки отчёта о нанесении: ${safeMessage(error.message)}`, 'UTILISATION_UNKNOWN');
  }
  if (result.reportId) {
    order.utilisationReportId = result.reportId;
    order.utilisationReportStatus = result.reportStatus || 'PENDING';
  }
  if (result.ok && result.reportStatus === 'SUCCESS') {
    markApplied(order, result.reportId);
    schedule(order, 1000);
    return;
  }
  if (result.reportId && TERMINAL_REPORTS.has(result.reportStatus)) {
    throw permanent(result.error || `Отчёт о нанесении отклонён: ${result.reportStatus}`, 'UTILISATION_FAILED');
  }
  if (result.reportId) {
    patch(order, { status: 'UTILISATION_PENDING' }, { key: 'utilisation-pending', label: 'Честный ЗНАК проверяет нанесение' });
    schedule(order, 8000);
    return;
  }
  if (result.stage === 'submit') throw ambiguous(result.error || 'Результат отправки отчёта о нанесении неизвестен', 'UTILISATION_UNKNOWN');
  order.status = 'CODES_RECEIVED';
  throw new Error(result.error || 'Не удалось подписать отчёт о нанесении');
}

async function pollUtilisation(order) {
  const result = await suz.reportInfo({ reportId: order.utilisationReportId });
  if (!result.ok) throw new Error(result.error || 'Не удалось проверить отчёт о нанесении');
  order.utilisationReportStatus = result.reportStatus;
  if (result.reportStatus === 'SUCCESS') {
    markApplied(order, order.utilisationReportId);
    schedule(order, 1000);
    return;
  }
  if (TERMINAL_REPORTS.has(result.reportStatus)) {
    throw permanent(`Отчёт о нанесении отклонён: ${safeMessage(result.errorReason || result.reportStatus)}`, 'UTILISATION_FAILED');
  }
  schedule(order, 10000);
}

async function submitIntroduction(order) {
  await readiness(order);
  const product = await trueapi.productInfo([order.gtin]);
  if (!product.ok) throw new Error(product.error || 'Не удалось получить данные товара');
  const card = product.results?.[0];
  const tnved = String(card?.tnVedCode10 || '');
  if (!/^\d{10}$/.test(tnved)) throw permanent('В карточке товара отсутствует корректный код ТН ВЭД. Нужна проверка администратора.', 'INTRODUCTION_FAILED');
  const identities = order.codes.map(identityPart);
  const info = await trueapi.cisesInfo(identities);
  if (!info.ok) throw new Error(info.error || 'Не удалось проверить коды перед вводом в оборот');
  const statuses = collectStatuses(info.results);
  if (statuses.length !== identities.length || statuses.some(value => value !== 'APPLIED')) {
    throw permanent('Не все коды получили статус «Нанесён». Ввод в оборот остановлен.', 'INTRODUCTION_FAILED');
  }
  patch(order, {
    status: 'INTRODUCTION_SUBMITTING',
    automationState: 'RUNNING',
    introductionAttemptState: 'SUBMITTING',
    introductionAttemptAt: Date.now()
  }, { key: 'introduction-submit', label: 'Отправляем ввод в оборот' });
  let result;
  try {
    result = await trueapi.createDocument({
      type: 'LP_INTRODUCE_GOODS',
      pg: cfg.productGroup,
      bodyObj: {
        participant_inn: cfg.orgInn,
        producer_inn: cfg.orgInn,
        owner_inn: cfg.orgInn,
        production_date: order.productionDate,
        production_type: 'OWN_PRODUCTION',
        products: identities.map(uit_code => ({ uit_code, tnved_code: tnved }))
      }
    });
  } catch (error) {
    throw ambiguous(`Связь прервалась во время отправки ввода в оборот: ${safeMessage(error.message)}`, 'INTRODUCTION_UNKNOWN');
  }
  if (!result.ok || !result.docId) {
    if (result.stage === 'submit') throw ambiguous(result.error || 'Результат отправки ввода в оборот неизвестен', 'INTRODUCTION_UNKNOWN');
    order.status = 'APPLIED';
    order.introductionAttemptState = 'FAILED_BEFORE_SUBMIT';
    throw new Error(result.error || 'Не удалось подписать ввод в оборот');
  }
  patch(order, {
    introductionDocumentId: result.docId,
    introductionDocumentStatus: 'SUBMITTED',
    introductionAttemptState: 'SUBMITTED',
    introductionSubmittedAt: Date.now(),
    status: 'INTRODUCTION_PENDING'
  }, { key: 'introduction-pending', label: 'Честный ЗНАК проверяет ввод в оборот' });
  schedule(order, 8000);
}

async function pollIntroduction(order) {
  const result = await trueapi.documentInfo(order.introductionDocumentId);
  if (!result.ok) throw new Error(result.error || 'Не удалось проверить документ ввода в оборот');
  const documentStatus = result.document?.status || 'PROCESSING';
  order.introductionDocumentStatus = documentStatus;
  if (documentStatus === 'CHECKED_NOT_OK') {
    throw permanent('Честный ЗНАК отклонил ввод в оборот. Откройте расширенный режим для просмотра причины.', 'INTRODUCTION_FAILED');
  }
  if (documentStatus !== 'CHECKED_OK') {
    schedule(order, 10000);
    return;
  }
  const identities = order.codes.map(identityPart);
  const info = await trueapi.cisesInfo(identities);
  if (!info.ok) throw new Error(info.error || 'Документ принят, но статусы кодов пока недоступны');
  const statuses = collectStatuses(info.results);
  if (statuses.length !== identities.length || statuses.some(value => value !== 'INTRODUCED')) {
    schedule(order, 8000);
    return;
  }
  patch(order, {
    status: 'INTRODUCED',
    introducedAt: order.introducedAt || Date.now(),
    introductionDocumentStatus: 'CHECKED_OK',
    automationState: 'DONE',
    automationNextAt: null,
    automationLastError: null
  }, { key: 'introduced', label: 'Коды введены в оборот и готовы к печати', tone: 'success' });
  if (!db.get().operations.some(item => item.type === 'introduction' && item.orderId === order.id)) {
    db.addOperation({ type: 'introduction', orderId: order.id, gtin: order.gtin, quantity: order.quantity, spendKop: 0, note: 'Автоматический ввод: документ CHECKED_OK, все КИ INTRODUCED' });
  }
}

async function processOrder(order) {
  if (order.status === 'FETCHING_CODES') order.status = 'ACTIVE';
  if (order.status === 'UTILISATION_SUBMITTING') {
    if (order.utilisationReportId) order.status = 'UTILISATION_PENDING';
    else throw ambiguous('Сервер был перезапущен во время отправки нанесения. Автоматический повтор заблокирован.', 'UTILISATION_UNKNOWN');
  }
  if (order.status === 'INTRODUCTION_SUBMITTING') {
    if (order.introductionDocumentId) order.status = 'INTRODUCTION_PENDING';
    else throw ambiguous('Сервер был перезапущен во время ввода в оборот. Автоматический повтор заблокирован.', 'INTRODUCTION_UNKNOWN');
  }
  patch(order, { automationState: 'RUNNING', automationLastRunAt: Date.now() });
  if (['CREATED', 'PENDING', 'PROCESSING'].includes(order.status)) return pollOrder(order);
  if (order.status === 'ACTIVE') return fetchCodes(order);
  if (order.status === 'CODES_RECEIVED') return submitUtilisation(order);
  if (order.status === 'UTILISATION_PENDING') return pollUtilisation(order);
  if (order.status === 'APPLIED') return submitIntroduction(order);
  if (order.status === 'INTRODUCTION_PENDING') return pollIntroduction(order);
  if (!TERMINAL_ORDERS.has(order.status)) throw permanent(`Неизвестное состояние партии: ${order.status}`, 'AUTOMATION_STOPPED');
}

async function cycle() {
  if (running) return;
  running = true;
  lastCycleAt = Date.now();
  try {
    const now = Date.now();
    const order = db.get().orders
      .filter(isManaged)
      .filter(item => !TERMINAL_ORDERS.has(item.status) && item.automationState !== 'ATTENTION')
      .filter(item => !item.automationNextAt || Number(item.automationNextAt) <= now)
      .sort((a, b) => Number(a.automationNextAt || a.createdAt || 0) - Number(b.automationNextAt || b.createdAt || 0))[0];
    currentOrderId = order?.id || null;
    if (order) {
      try {
        await processOrder(order);
        lastError = null;
      } catch (error) {
        recordFailure(order, error);
        lastError = safeMessage(error?.message || error);
      }
    }
  } finally {
    currentOrderId = null;
    running = false;
  }
}

function start() {
  if (timer) return status();
  timer = setInterval(() => cycle().catch(error => { lastError = safeMessage(error?.message || error); }), POLL_MS);
  timer.unref();
  setTimeout(() => cycle().catch(error => { lastError = safeMessage(error?.message || error); }), 500).unref();
  return status();
}

function kick(orderId = null) {
  if (orderId) {
    const order = db.findOrder(orderId);
    if (order && isManaged(order) && order.automationState !== 'ATTENTION') {
      order.automationNextAt = Date.now();
      db.save();
    }
  }
  setTimeout(() => cycle().catch(error => { lastError = safeMessage(error?.message || error); }), 50).unref();
}

function status() {
  const managed = db.get().orders.filter(isManaged);
  return {
    enabled: Boolean(timer),
    running,
    currentOrderId,
    lastCycleAt,
    lastError,
    activeCount: managed.filter(item => !TERMINAL_ORDERS.has(item.status) && item.automationState !== 'ATTENTION').length,
    attentionCount: managed.filter(item => item.automationState === 'ATTENTION').length
  };
}

function publicStatus(order) {
  const code = order.status || 'CREATED';
  if (['INTRODUCED'].includes(code)) return { code: 'READY', label: 'Готово к печати', tone: 'success', progress: 100, step: 5 };
  if (['WITHDRAWN', 'WITHDRAWN_AUTO_SET'].includes(code)) return { code: 'ARCHIVE', label: 'Выведено из оборота', tone: 'neutral', progress: 100, step: 5 };
  if (order.automationState === 'ATTENTION' || /FAILED|UNKNOWN|INVALID|REQUIRED|STOPPED/.test(code)) return { code: 'ATTENTION', label: 'Требуется проверка', tone: 'danger', progress: progressFor(code), step: stepFor(code) };
  if (['APPLIED', 'INTRODUCTION_SUBMITTING', 'INTRODUCTION_PENDING'].includes(code)) return { code: 'INTRODUCTION', label: 'Вводим в оборот', tone: 'progress', progress: 80, step: 4 };
  if (['CODES_RECEIVED', 'UTILISATION_SUBMITTING', 'UTILISATION_PENDING'].includes(code)) return { code: 'UTILISATION', label: 'Подтверждаем нанесение', tone: 'progress', progress: 60, step: 3 };
  if (['ACTIVE', 'FETCHING_CODES'].includes(code)) return { code: 'CODES', label: 'Получаем коды', tone: 'progress', progress: 40, step: 2 };
  return { code: 'ORDER', label: 'Формируем заказ', tone: 'progress', progress: 20, step: 1 };
}

function stepFor(code) {
  if (/INTRODUCTION|INTRODUCED/.test(code)) return 4;
  if (/UTILISATION|APPLIED/.test(code)) return 3;
  if (/CODES|ACTIVE/.test(code)) return 2;
  return 1;
}

function progressFor(code) { return stepFor(code) * 20; }

module.exports = { start, kick, cycle, status, publicStatus, isManaged, validateCodes };
