'use strict';
// Клиент СУЗ-ОБЛАКО API v3 + авторизация через True API (получение clientToken).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const signer = require('./signer');

const TOKEN_FILE = path.join(cfg.dataDir, 'suz_token.json');
let tokenCache = null; // { token, obtainedAt, omsConnection }

function loadTokenFromDisk() {
  try { tokenCache = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch (_) { tokenCache = null; }
}
loadTokenFromDisk();

function tokenAgeMs() { return tokenCache ? Date.now() - tokenCache.obtainedAt : Infinity; }
function tokenValid() {
  // СУЗ-токен живёт ~10ч; берём запас и считаем валидным до 9ч.
  return tokenCache && tokenCache.token && tokenCache.omsConnection === cfg.omsConnection && tokenAgeMs() < 9 * 3600 * 1000;
}

const http = require('./http');
function httpJson(method, url, opts = {}) { return http.request(method, url, opts); }

// Получить clientToken. onProgress(stage): 'authKey'|'prepare'|'upload'|'sign'|'signIn'|'done'
async function getToken({ force = false, onProgress } = {}) {
  const prog = onProgress || (() => {});
  if (!force && tokenValid()) return { ok: true, token: tokenCache.token, cached: true };

  prog('authKey');
  const key = await httpJson('GET', `${cfg.trueApiBase}/auth/key`, { headers: { Accept: 'application/json' } });
  if (!key.ok || !key.json || !key.json.uuid || !key.json.data) {
    return { ok: false, stage: 'authKey', error: `auth/key HTTP ${key.status}: ${key.text}` };
  }
  const { uuid, data } = key.json;

  // Присоединённая подпись data
  const sg = await signer.sign('auth', data, { onProgress: prog });
  if (!sg.ok) return { ok: false, stage: sg.stage || 'sign', error: sg.error };

  prog('signIn');
  const signIn = await httpJson('POST', `${cfg.trueApiBase}/auth/simpleSignIn/${cfg.omsConnection}`, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ uuid, data: sg.signature })
  });
  if (!signIn.ok || !signIn.json || !signIn.json.token) {
    return { ok: false, stage: 'signIn', error: `simpleSignIn HTTP ${signIn.status}: ${signIn.text}` };
  }
  tokenCache = { token: signIn.json.token, obtainedAt: Date.now(), omsConnection: cfg.omsConnection };
  try { fs.mkdirSync(cfg.dataDir, { recursive: true }); fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenCache)); } catch (_) {}
  prog('done');
  return { ok: true, token: tokenCache.token, cached: false };
}

function authHeaders(extra = {}) {
  return Object.assign({ Accept: 'application/json', clientToken: tokenCache.token }, extra);
}

async function ensureToken(onProgress) {
  if (tokenValid()) return { ok: true };
  const t = await getToken({ onProgress });
  return t.ok ? { ok: true } : t;
}

// Проверка доступности OMS
async function ping() {
  const t = await ensureToken();
  if (!t.ok) return t;
  const r = await httpJson('GET', `${cfg.suzBase}/api/v3/ping?omsId=${cfg.omsId}`, { headers: authHeaders() });
  if (!r.ok) return { ok: false, error: `ping HTTP ${r.status}: ${r.text}` };
  return { ok: true, ...r.json };
}

function genSerials(quantity, len = 12) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const set = new Set();
  while (set.size < quantity) {
    let s = '';
    const buf = crypto.randomBytes(len);
    for (let i = 0; i < len; i++) s += alphabet[buf[i] % alphabet.length];
    set.add(s);
  }
  return [...set];
}

// Создать заказ КМ (bio). Возвращает { ok, orderId, expectedCompleteTimestamp, body, productionOrderId, serials }
async function createOrder({
  gtin,
  quantity,
  templateId = 30,
  cisType = 'UNIT',
  contactPerson = 'Швыдченко Е. Н.',
  releaseMethodType = 'PRODUCTION',
  paymentType = 1,
  productionOrderId,
  serials,
  onProgress
}) {
  const prog = onProgress || (() => {});
  const t = await ensureToken(prog);
  if (!t.ok) return t;

  const preparedSerials = Array.isArray(serials) ? serials.map(value => String(value)) : genSerials(quantity);
  const preparedProductionOrderId = String(productionOrderId || crypto.randomUUID());
  if (preparedSerials.length !== Number(quantity) || new Set(preparedSerials).size !== preparedSerials.length) {
    return { ok: false, stage: 'prepare', error: 'Количество или уникальность заранее подготовленных серийных номеров не совпадает с заказом' };
  }
  const bodyObj = {
    productGroup: cfg.productGroup,
    products: [{
      gtin: String(gtin),
      quantity: Number(quantity),
      serialNumberType: 'SELF_MADE',
      serialNumbers: preparedSerials,
      templateId: Number(templateId),
      cisType: String(cisType)
    }],
    attributes: {
      contactPerson,
      releaseMethodType: String(releaseMethodType),
      productionOrderId: preparedProductionOrderId,
      paymentType: Number(paymentType)
    }
  };
  const bodyStr = JSON.stringify(bodyObj);

  const sg = await signer.sign('detached', bodyStr, { onProgress: prog });
  if (!sg.ok) return { ok: false, stage: sg.stage || 'sign', error: sg.error };

  prog('submit');
  const r = await httpJson('POST', `${cfg.suzBase}/api/v3/order?omsId=${cfg.omsId}`, {
    headers: authHeaders({ 'Content-Type': 'application/json;charset=UTF-8', 'X-Signature': sg.signature }),
    body: bodyStr
  });
  if (!r.ok || !r.json || !r.json.orderId) {
    return { ok: false, stage: 'submit', error: `order HTTP ${r.status}: ${r.text}`, httpStatus: r.status };
  }
  prog('done');
  return {
    ok: true,
    orderId: r.json.orderId,
    expectedCompleteTimestamp: r.json.expectedCompleteTimestamp,
    productionOrderId: preparedProductionOrderId, serials: preparedSerials, body: bodyObj
  };
}

// Статус заказа/буфера
async function orderStatus({ orderId, gtin }) {
  const t = await ensureToken();
  if (!t.ok) return t;
  const url = `${cfg.suzBase}/api/v3/order/status?omsId=${cfg.omsId}&orderId=${orderId}&gtin=${gtin}`;
  const r = await httpJson('GET', url, { headers: authHeaders() });
  if (!r.ok) return { ok: false, error: `status HTTP ${r.status}: ${r.text}` };
  const arr = Array.isArray(r.json) ? r.json : [r.json];
  return { ok: true, buffers: arr };
}

// Получить коды из заказа
async function getCodes({ orderId, gtin, quantity }) {
  const t = await ensureToken();
  if (!t.ok) return t;
  const url = `${cfg.suzBase}/api/v3/codes?omsId=${cfg.omsId}&orderId=${orderId}&gtin=${gtin}&quantity=${quantity}`;
  const r = await httpJson('GET', url, { headers: authHeaders() });
  if (!r.ok || !r.json || !r.json.codes) return { ok: false, error: `codes HTTP ${r.status}: ${r.text}` };
  return { ok: true, codes: r.json.codes, blockId: r.json.blockId };
}

// Отчёт о нанесении (utilisation) для bio. SUCCESS переводит КИ в APPLIED,
// но не заменяет отдельный документ ввода в оборот LP_INTRODUCE_GOODS.
async function utilisation({ sntins, productionDate, expirationDate, vetisGuid, verifyTimeoutMs = 180000, onProgress }) {
  const prog = onProgress || (() => {});
  const t = await ensureToken(prog);
  if (!t.ok) return t;
  const attributes = {};
  if (productionDate) attributes.productionDate = productionDate;
  if (expirationDate) attributes.expirationDate = expirationDate;
  if (vetisGuid) attributes.vetisGuid = vetisGuid;
  const bodyStr = JSON.stringify({ productGroup: cfg.productGroup, sntins, attributes });

  const sg = await signer.sign('detached', bodyStr, { onProgress: prog });
  if (!sg.ok) return { ok: false, stage: sg.stage || 'sign', error: sg.error };

  prog('submit');
  const r = await httpJson('POST', `${cfg.suzBase}/api/v3/utilisation?omsId=${cfg.omsId}`, {
    headers: authHeaders({ 'Content-Type': 'application/json', 'X-Signature': sg.signature }),
    body: bodyStr
  });
  if (!r.ok) return { ok: false, stage: 'submit', error: `utilisation HTTP ${r.status}: ${r.text}` };
  const reportId = r.json && r.json.reportId;
  if (!reportId) return { ok: false, stage: 'submit', error: `СУЗ принял отчёт, но не вернул reportId: ${r.text}` };

  // Отчёт обрабатывается асинхронно. SUCCESS означает «нанесён» (APPLIED).
  const verified = await waitReport({ reportId, timeoutMs: verifyTimeoutMs, onProgress: prog });
  if (!verified.ok) return { ...verified, reportId, response: r.json, raw: r.text };
  prog('done');
  return { ok: true, reportId, reportStatus: verified.reportStatus, response: r.json, raw: r.text };
}

// Места осуществления деятельности/производственные площадки из профиля ЧЗ.
async function businessPlaces() {
  const t = await ensureToken();
  if (!t.ok) return t;
  const url = `${cfg.suzBase}/api/v3/mod?omsId=${cfg.omsId}&productGroup=${encodeURIComponent(cfg.productGroup)}`;
  const r = await httpJson('GET', url, { headers: authHeaders() });
  if (!r.ok) return { ok: false, error: `mod HTTP ${r.status}: ${r.text}` };
  const places = r.json && r.json.manufactureInfo;
  return { ok: true, totalCount: Number(r.json && r.json.totalCount) || 0, places: Array.isArray(places) ? places : [] };
}

// Статус асинхронного отчёта СУЗ (utilisation/dropout/aggregation и т.п.).
async function reportInfo({ reportId }) {
  const t = await ensureToken();
  if (!t.ok) return t;
  const url = `${cfg.suzBase}/api/v3/report/info?omsId=${cfg.omsId}&reportId=${encodeURIComponent(reportId)}`;
  const r = await httpJson('GET', url, { headers: authHeaders() });
  if (!r.ok) return { ok: false, stage: 'verify', error: `report/info HTTP ${r.status}: ${r.text}` };
  return {
    ok: true,
    reportId,
    reportStatus: r.json && r.json.reportStatus,
    errorReason: r.json && r.json.errorReason,
    response: r.json
  };
}

async function waitReport({ reportId, timeoutMs = 180000, pollMs = 2000, onProgress } = {}) {
  const prog = onProgress || (() => {});
  const failed = new Set(['REJECTED', 'FAILED', 'PARTIALLY']);
  const deadline = Date.now() + timeoutMs;
  prog('verify');
  let last = null;
  while (Date.now() < deadline) {
    last = await reportInfo({ reportId });
    // Кратковременный 404/тайм-аут возможен, пока отчёт появляется в индексе.
    if (!last.ok) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      continue;
    }
    if (last.reportStatus === 'SUCCESS') return last;
    if (failed.has(last.reportStatus)) {
      return {
        ok: false,
        stage: 'verify',
        reportId,
        reportStatus: last.reportStatus,
        error: `Отчёт СУЗ завершился со статусом ${last.reportStatus}: ${last.errorReason || 'причина не указана'}`,
        response: last.response
      };
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  return {
    ok: false,
    stage: 'verify',
    reportId,
    reportStatus: last && last.reportStatus,
    pending: true,
    error: `СУЗ не завершил обработку отчёта за ${Math.round(timeoutMs / 1000)} секунд${last && last.error ? `: ${last.error}` : ''}`
  };
}

// Вывод из оборота через СУЗ (dropout) — списание: брак/утеря/уничтожение и т.п.
async function dropout({ sntins, dropoutReason, onProgress }) {
  const prog = onProgress || (() => {});
  const t = await ensureToken(prog);
  if (!t.ok) return t;
  const bodyStr = JSON.stringify({ productGroup: cfg.productGroup, dropoutReason, sntins });

  const sg = await signer.sign('detached', bodyStr, { onProgress: prog });
  if (!sg.ok) return { ok: false, stage: sg.stage || 'sign', error: sg.error };

  prog('submit');
  const r = await httpJson('POST', `${cfg.suzBase}/api/v3/dropout?omsId=${cfg.omsId}`, {
    headers: authHeaders({ 'Content-Type': 'application/json', 'X-Signature': sg.signature }),
    body: bodyStr
  });
  if (!r.ok) return { ok: false, stage: 'submit', error: `dropout HTTP ${r.status}: ${r.text}` };
  prog('done');
  return { ok: true, response: r.json, raw: r.text };
}

module.exports = {
  getToken, ping, createOrder, orderStatus, getCodes, utilisation, businessPlaces, reportInfo, waitReport, dropout,
  genSerials,
  tokenValid, tokenInfo: () => (tokenCache ? { obtainedAt: tokenCache.obtainedAt, ageMs: tokenAgeMs(), valid: tokenValid() } : null)
};
