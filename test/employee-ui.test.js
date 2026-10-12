'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
function ui() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', className: '' });
    return elements.get(id);
  };
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').replace(/\ninit\(\);\s*$/, '\nupdateOrderSummary=()=>{}; module.exports={state,renderSystem,renderDashboard,moscowDay,issueDateRange,matchesIssueDate,renderHistory,renderBulkBatches};');
  const sandbox = { document: { querySelector: element, querySelectorAll: () => [] }, module: { exports: {} }, Intl, URL, console };
  vm.runInNewContext(source, sandbox);
  return { ...sandbox.module.exports, element };
}
test('browser connection loss removes previously green status from all system cards', () => {
  const app = ui();
  app.state.system = { connection: { code: 'ONLINE', label: 'ПК ЧЗ на связи', note: 'Проверено', online: true, version: 'fixture' }, laptop: { online: true, csptest: true, cert: true }, orderAutomation: { enabled: true }, bulkOrderWorker: { enabled: true } };
  app.renderSystem();
  assert.match(app.element('#systemBanner').className, /good/);
  app.state.systemError = 'Нет интернета';
  app.renderSystem();
  assert.match(app.element('#systemBanner').className, /problem/);
  assert.match(app.element('#systemBanner').innerHTML, /Нет интернета/);
  assert.equal(app.element('#systemClock').textContent, 'Нет свежих данных');
});

test('employee sees actionable ECP warning despite cached certificate; offline recheck stays queued', () => {
  const app = ui();
  app.state.system = { connection: { code: 'SIGNATURE_REQUIRED', online: true }, laptop: { online:true,cert:true,csptest:true }, signatureRecovery: { supported:true, blocked:true } };
  app.renderSystem();
  assert.equal(app.element('#signatureNotice').hidden, false);
  assert.match(app.element('#signatureNoticeText').textContent, /Подключите флешку/);
  assert.equal(app.element('#systemSigner').textContent, 'ЭЦП недоступна');
  app.state.system.connection.online=false;
  app.state.system.signatureRecovery.request={state:'QUEUED'};
  app.renderSystem();
  assert.match(app.element('#signatureNoticeText').textContent, /когда офисный ПК подключится/);
});

test('issue-date filter defaults to today and uses Moscow midnight, not production date', () => {
  const app = ui();
  const now = Date.parse('2026-10-04T09:00:00Z');
  assert.equal(app.state.datePeriod, 'today');
  assert.equal(app.matchesIssueDate({ createdAt: Date.parse('2026-10-03T20:59:59Z') }, now), false);
  assert.equal(app.matchesIssueDate({ createdAt: Date.parse('2026-10-03T21:00:00Z'), productionDate: '2025-01-01' }, now), true);
  assert.equal(app.matchesIssueDate({ createdAt: Date.parse('2026-10-04T20:59:59Z') }, now), true);
  assert.equal(app.matchesIssueDate({ createdAt: Date.parse('2026-10-04T21:00:00Z') }, now), false);
  app.state.datePeriod = 'yesterday';
  assert.equal(app.issueDateRange(now).from, '2026-10-03');
  app.state.datePeriod = 'week';
  assert.equal(app.issueDateRange(now).from, '2026-09-28');
  app.state.datePeriod = 'custom'; app.state.dateFrom = '2026-09-28'; app.state.dateTo = '2026-10-04';
  assert.equal(app.matchesIssueDate({ createdAt: now }, now), true);
  app.state.dateFrom = '2026-10-05';
  assert.equal(app.matchesIssueDate({ createdAt: now }, now), false);
  app.state.datePeriod = 'all';
  assert.equal(app.matchesIssueDate({ createdAt: Date.parse('2025-01-01') }, now), true);
});

test('dashboard and bulk list hide old orders by default, then restore them for all time', () => {
  const app = ui();
  const make = (id, createdAt) => ({ id, createdAt, name: id, quantity: 1, releaseMethodType: 'PRODUCTION', cisType: 'UNIT', publicStatus: { code: 'READY', label: 'Готово' } });
  app.state.orders = [make('today-fixture', Date.now()), make('old-fixture', 1)];
  app.state.bulkBatches = [{ createdAt: 1, itemCount: 1, totalQuantity: 1 }];
  app.renderDashboard(); app.renderBulkBatches();
  assert.match(app.element('#activeOrders').innerHTML, /today-fixture/);
  assert.doesNotMatch(app.element('#activeOrders').innerHTML, /old-fixture/);
  assert.equal(app.element('#metricReady').textContent, 1);
  assert.match(app.element('#bulkBatchList').innerHTML, /За выбранные даты/);
  app.state.datePeriod = 'all'; app.renderDashboard(); app.renderBulkBatches();
  assert.match(app.element('#activeOrders').innerHTML, /old-fixture/);
  assert.equal(app.element('#metricReady').textContent, 2);
  assert.match(app.element('#bulkBatchList').innerHTML, /bulk-batch-row/);
});
test('queued jobs are visible on dashboard before worker claims them', () => {
  const app = ui();
  app.state.orders = [{ id: 'fixture', gtin: '00000000000001', name: 'Fixture', quantity: 1, releaseMethodType: 'PRODUCTION', cisType: 'UNIT', createdAt: Date.now(), publicStatus: { code: 'QUEUED', label: 'В очереди', progress: 5 } }];
  app.renderDashboard();
  assert.equal(app.element('#metricActive').textContent, 1);
  assert.match(app.element('#activeOrders').innerHTML, /В очереди/);
});
