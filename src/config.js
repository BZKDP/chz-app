'use strict';
const path = require('path');
const os = require('os');

// Значения по умолчанию можно переопределить через data/config.local.json
let local = {};
try { local = require(path.join(__dirname, '..', 'data', 'config.local.json')); } catch (_) {}

const cfg = {
  // ---- HTTP сервер ----
  port: local.port || 3030,

  // ---- Контур Честного Знака ----
  // PROD; для песочницы поменять на sandbox-хосты в config.local.json
  env: local.env || 'PROD',
  trueApiBase: local.trueApiBase || 'https://markirovka.crpt.ru/api/v3/true-api',
  suzBase:     local.suzBase     || 'https://suzgrid.crpt.ru',

  // ---- Идентификаторы интеграции (СУЗ) ----
  // Задаются через data/config.local.json или переменные окружения.
  omsId:        local.omsId         || process.env.CHZ_OMS_ID         || '',
  omsConnection:local.omsConnection || process.env.CHZ_OMS_CONNECTION || '',
  productGroup: local.productGroup  || process.env.CHZ_PRODUCT_GROUP  || 'bio',
  orgInn:       local.orgInn        || process.env.CHZ_ORG_INN        || '', // ИНN организации (как в сертификате УКЭП)
  nkApiKey:     local.nkApiKey      || process.env.CHZ_NK_API_KEY     || null, // apikey Национального каталога (ЛК НК → Профиль → API)

  // ---- Защищённая очередь внешнего сайта сборки ----
  bridge: {
    enabled: local.chzWorkerEnabled === true || process.env.CHZ_WORKER_ENABLED === '1',
    url: String(local.chzWorkerUrl || process.env.CHZ_WORKER_URL || '').replace(/\/+$/, ''),
    workerId: String(local.chzWorkerId || process.env.CHZ_WORKER_ID || `chz-${os.hostname()}`).slice(0, 120),
    secret: String(local.chzWorkerSecret || process.env.CHZ_WORKER_SECRET || ''),
    pollMs: Math.max(2000, Number(local.chzWorkerPollMs || process.env.CHZ_WORKER_POLL_MS || 5000)),
    maxQuantity: Math.max(1, Number(local.chzWorkerMaxQuantity || 5000))
  },

  // ---- Подпись (УКЭП) на офисном компьютере ----
  signer: {
    local:    local.signerLocal === true,
    host:     local.signerHost     || process.env.CHZ_SIGNER_HOST || '',
    user:     local.signerUser     || process.env.CHZ_SIGNER_USER || '',
    key:      local.signerKey      || path.join(os.homedir(), '.ssh', 'chz_signer'),
    thumbprint: local.thumbprint   || process.env.CHZ_SIGNER_THUMBPRINT || '',
    csptest:  local.csptest        || 'C:\\Program Files\\Crypto Pro\\CSP\\csptest.exe',
    workdir:  local.signerWorkdir  || 'C:\\crpt-suz',
    scriptPath: local.signerScript || 'C:\\crpt-suz\\chz_sign.ps1',
    connectTimeout: 10
  },

  // ---- Стоимость кода маркировки (для расчёта расхода) ----
  tariff: {
    netKop: local.tariffNetKop != null ? local.tariffNetKop : 50,   // 50 коп. без НДС
    vatPercent: local.vatPercent != null ? local.vatPercent : 22    // НДС %
  },

  // ---- Пути ----
  dataDir: path.join(__dirname, '..', 'data'),
  workDir: path.join(__dirname, '..', 'work'),
  dbFile:  path.join(__dirname, '..', 'data', 'db.json')
};

cfg.tariff.grossKop = Math.round(cfg.tariff.netKop * (1 + cfg.tariff.vatPercent / 100));

module.exports = cfg;
