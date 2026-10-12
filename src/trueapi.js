'use strict';
// Клиент True API (ГИС МТ): отдельный токен (simpleSignIn БЕЗ omsConnection).
// Используется для баланса лицевого счёта, списка товаров (GTIN) участника, инфо о товаре.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const signer = require('./signer');

const TOKEN_FILE = path.join(cfg.dataDir, 'trueapi_token.json');
let cache = null;
try { cache = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch (_) {}

function valid() { return cache && cache.token && (Date.now() - cache.obtainedAt) < 9 * 3600 * 1000; }

const http = require('./http');
function httpJson(method, url, opts = {}) { return http.request(method, url, opts); }

async function getToken({ force = false, onProgress } = {}) {
  const prog = onProgress || (() => {});
  if (!force && valid()) return { ok: true, token: cache.token, cached: true };
  prog('authKey');
  const key = await httpJson('GET', `${cfg.trueApiBase}/auth/key`, { headers: { Accept: 'application/json' } });
  if (!key.ok || !key.json || !key.json.uuid) return { ok: false, stage: 'authKey', error: `auth/key HTTP ${key.status}: ${key.text}` };
  const sg = await signer.sign('auth', key.json.data, { onProgress: prog });
  if (!sg.ok) return { ok: false, stage: sg.stage || 'sign', error: sg.error };
  prog('signIn');
  const si = await httpJson('POST', `${cfg.trueApiBase}/auth/simpleSignIn`, {
    headers: { Accept: 'application/json', 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ uuid: key.json.uuid, data: sg.signature })
  });
  if (!si.ok || !si.json || !si.json.token) return { ok: false, stage: 'signIn', error: `simpleSignIn HTTP ${si.status}: ${si.text}` };
  cache = { token: si.json.token, obtainedAt: Date.now() };
  try { fs.mkdirSync(cfg.dataDir, { recursive: true }); fs.writeFileSync(TOKEN_FILE, JSON.stringify(cache)); } catch (_) {}
  prog('done');
  return { ok: true, token: cache.token };
}

async function ensure(onProgress) {
  if (valid()) return { ok: true };
  const t = await getToken({ onProgress });
  return t.ok ? { ok: true } : t;
}

// Корень хоста ГИС МТ (без /api/v3/true-api) — для методов разных версий
const HOST = cfg.trueApiBase.replace(/\/api\/v[0-9]+\/true-api\/?$/, '');

function bearer() { return { Authorization: `Bearer ${cache.token}`, Accept: 'application/json' }; }

// Универсальный авторизованный GET относительно trueApiBase (для зондирования)
async function get(pathUrl) {
  const t = await ensure();
  if (!t.ok) return t;
  return httpJson('GET', `${cfg.trueApiBase}${pathUrl}`, { headers: bearer() });
}

// Информация о товарах по массиву GTIN: реальное название/бренд/упаковка/ТГ.
// POST /api/v4/true-api/product/info  {gtins:[...]}
async function productInfo(gtins) {
  const t = await ensure();
  if (!t.ok) return t;
  const r = await httpJson('POST', `${HOST}/api/v4/true-api/product/info`, {
    headers: Object.assign(bearer(), { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ gtins })
  });
  if (!r.ok) return { ok: false, error: `product/info HTTP ${r.status}: ${r.text}` };
  const list = (r.json && (r.json.results || r.json)) || [];
  return { ok: true, results: Array.isArray(list) ? list : [] };
}

// Профиль организации по ИНН: статус, товарные группы.
// GET /api/v3/true-api/participants?inns={inn}
async function participant(inn) {
  const t = await ensure();
  if (!t.ok) return t;
  const r = await httpJson('GET', `${HOST}/api/v3/true-api/participants?inns=${inn}`, { headers: bearer() });
  if (!r.ok) return { ok: false, error: `participants HTTP ${r.status}: ${r.text}` };
  const arr = Array.isArray(r.json) ? r.json : (r.json ? [r.json] : []);
  return { ok: true, participant: arr[0] || null };
}

// Рекурсивно собрать объекты, содержащие поле gtin (толерантно к разным форматам НК)
function extractGoods(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(n => extractGoods(n, out)); return; }
  const gtin = node.gtin || node.GTIN || (node.good && node.good.gtin);
  if (gtin) {
    const g = node.good || node;
    out.push({
      gtin: String(gtin).padStart(14, '0'),
      name: g.name || g.good_name || g.productName || g.title || null,
      brand: g.brand || g.trademark || null,
      productGroup: g.productGroup || g.category || null,
      packageType: g.packageType || null
    });
  }
  for (const k in node) if (node[k] && typeof node[k] === 'object') extractGoods(node[k], out);
}

// Импорт всех карточек товаров из Национального каталога.
// GET /api/v3/product/list?apikey=<apikey>  (авторизация — наш Bearer-токен + apikey НК)
async function importNk(apikey, { limit = 1000 } = {}) {
  const t = await ensure();
  if (!t.ok) return t;
  const r = await httpJson('GET', `${HOST}/api/v3/product/list?apikey=${encodeURIComponent(apikey)}&limit=${limit}`, { headers: bearer() });
  if (!r.ok) return { ok: false, error: `product/list HTTP ${r.status}: ${r.text}`, raw: r.text };
  const items = [];
  extractGoods(r.json, items);
  // дедуп по gtin
  const seen = new Set(); const uniq = [];
  for (const it of items) if (!seen.has(it.gtin)) { seen.add(it.gtin); uniq.push(it); }
  return { ok: true, items: uniq, raw: uniq.length ? null : r.text };
}

// Соответствие числового productGroupId названию товарной группы
const PG_NAMES = { 17: 'БАД (bio)', 23: 'Безалкогольные напитки (softdrinks)' };
function pgName(id) { return PG_NAMES[id] || ('Товарная группа #' + id); }

// Денежный баланс лицевого счёта по всем товарным группам (в копейках).
// GET /api/v3/true-api/elk/product-groups/balance/all
async function getBalance() {
  const t = await ensure();
  if (!t.ok) return t;
  const r = await httpJson('GET', `${HOST}/api/v3/true-api/elk/product-groups/balance/all`, { headers: bearer() });
  if (!r.ok) return { ok: false, error: `balance HTTP ${r.status}: ${r.text}` };
  const arr = Array.isArray(r.json) ? r.json : [];
  const balances = arr.map(x => ({
    productGroupId: x.productGroupId,
    name: pgName(x.productGroupId),
    balanceKop: x.balance,
    contractId: x.contractId,
    organisationId: x.organisationId
  }));
  return { ok: true, balances };
}

// Единый метод создания документов ГИС МТ.
// POST /lk/documents/create?pg={pg}  body {document_format, type, product_document(base64), signature(detached base64)}
async function createDocument({ type, bodyObj, pg, onProgress }) {
  const prog = onProgress || (() => {});
  const t = await ensure(prog);
  if (!t.ok) return t;
  const json = JSON.stringify(bodyObj);
  const productDocument = Buffer.from(json, 'utf8').toString('base64');
  const sg = await signer.sign('detached', json, { onProgress: prog });
  if (!sg.ok) return { ok: false, stage: sg.stage || 'sign', error: sg.error };
  prog('submit');
  const body = JSON.stringify({ document_format: 'MANUAL', type, product_document: productDocument, signature: sg.signature });
  const r = await httpJson('POST', `${cfg.trueApiBase}/lk/documents/create?pg=${encodeURIComponent(pg)}`, {
    headers: Object.assign(bearer(), { 'Content-Type': 'application/json' }), body
  });
  if (!r.ok) return { ok: false, stage: 'submit', error: `create HTTP ${r.status}: ${r.text}`, httpStatus: r.status };
  const docId = typeof r.json === 'string' ? r.json : (r.json && (r.json.value || r.json.documentId || r.json.reportId)) || (r.text || '').replace(/^"|"$/g, '');
  prog('done');
  return { ok: true, docId, raw: r.text };
}

// Вывод из оборота (розничная продажа) — документ LK_RECEIPT.
async function withdrawRetail({ cises, actionDate, documentType = 'RECEIPT', documentNumber, documentDate, pg = cfg.productGroup, onProgress }) {
  const bodyObj = {
    inn: cfg.orgInn,
    action: 'RETAIL',
    action_date: actionDate,
    document_type: documentType,
    document_number: documentNumber,
    document_date: documentDate,
    products: cises.map(c => ({ cis: c }))
  };
  return createDocument({ type: 'LK_RECEIPT', bodyObj, pg, onProgress });
}

// Информация/статус кодов маркировки — POST /cises/info, тело = массив строк КМ.
async function cisesInfo(cises) {
  const t = await ensure();
  if (!t.ok) return t;
  const r = await httpJson('POST', `${cfg.trueApiBase}/cises/info`, {
    headers: Object.assign(bearer(), { 'Content-Type': 'application/json' }),
    body: JSON.stringify(cises)
  });
  if (!r.ok) return { ok: false, error: `cises/info HTTP ${r.status}: ${r.text}` };
  const arr = Array.isArray(r.json) ? r.json : (r.json ? [r.json] : []);
  return { ok: true, results: arr };
}

// Информация о документе по актуальному True API v4.
// GET /api/v4/true-api/doc/{docId}/info
async function documentInfo(docId) {
  const t = await ensure();
  if (!t.ok) return t;
  const r = await httpJson('GET', `${HOST}/api/v4/true-api/doc/${encodeURIComponent(docId)}/info`, { headers: bearer() });
  if (!r.ok) return { ok: false, error: `doc/info HTTP ${r.status}: ${r.text}`, httpStatus: r.status };
  const row = Array.isArray(r.json) ? r.json[0] : r.json;
  return { ok: true, document: row || null };
}

// Список кодов товаров (GTIN) участника по товарной группе — GET /api/v4/true-api/product/gtin?pg=...
async function productGtins(pg, { limit = 10000, page = 0, includeSubaccount = false } = {}) {
  const t = await ensure();
  if (!t.ok) return t;
  const url = `${HOST}/api/v4/true-api/product/gtin?pg=${encodeURIComponent(pg)}&limit=${limit}&page=${page}&includeSubaccount=${includeSubaccount}`;
  const r = await httpJson('GET', url, { headers: bearer() });
  if (!r.ok) return { ok: false, error: `product/gtin HTTP ${r.status}: ${r.text}` };
  const results = (r.json && r.json.results) || [];
  return { ok: true, gtins: results.map(x => x.gtin), results, total: r.json && r.json.total };
}

// Готовность собственной карточки НК к операциям оборота.
// Не возвращаем наружу полный набор атрибутов карточки: только безопасные
// признаки, необходимые для блокировки заказа/отчёта до исправления НК.
async function productReadiness(gtin) {
  const normalized = String(gtin || '').trim();
  if (!/^\d{14}$/.test(normalized)) return { ok: false, error: 'gtin должен состоять из 14 цифр' };
  const t = await ensure();
  if (!t.ok) return t;
  const r = await httpJson('GET', `${cfg.trueApiBase}/nk/feed-product?gtin=${encodeURIComponent(normalized)}`, {
    headers: bearer()
  });
  if (!r.ok) return { ok: false, error: `feed-product HTTP ${r.status}: ${r.text}` };
  const rows = r.json && r.json.result;
  const card = Array.isArray(rows) ? rows[0] : null;
  if (!card) return { ok: false, error: `Карточка ${normalized} не найдена в Национальном каталоге` };
  const attrs = Array.isArray(card.good_attrs) ? card.good_attrs : [];
  const vet = attrs.find(item => Number(item.attr_id) === 23501);
  const totalMass = attrs.find(item => Number(item.attr_id) === 23502);
  const unitMass = attrs.find(item => Number(item.attr_id) === 22311);
  const vetValue = vet ? String(vet.attr_value || '').trim() : '';
  return {
    ok: true,
    gtin: normalized,
    goodId: card.good_id,
    status: card.good_status || null,
    detailedStatus: card.good_detailed_status || [],
    signed: card.good_signed === true,
    markReady: card.good_mark_flag === true,
    turnReady: card.good_turn_flag === true,
    vetControlled: /^да$/i.test(vetValue),
    vetControlledValue: vetValue || null,
    totalMass: totalMass ? { value: totalMass.attr_value, unit: totalMass.attr_value_type || null } : null,
    unitMass: unitMass ? { value: unitMass.attr_value, unit: unitMass.attr_value_type || null } : null
  };
}

module.exports = { getToken, ensure, get, productInfo, participant, importNk, getBalance, pgName, createDocument, withdrawRetail, productGtins, productReadiness, cisesInfo, documentInfo, valid, token: () => (cache ? cache.token : null) };
