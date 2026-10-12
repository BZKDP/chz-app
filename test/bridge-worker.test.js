'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAllocations, payloadFingerprint } = require('../src/bridge-worker');

test('accepts a complete deterministic allocation', () => {
  const rows = normalizeAllocations([
    { orderId: 'OZ-2', sourceArticle: 'SET-1', unitIndex: 1, codeIndex: 1 },
    { orderId: 'OZ-1', sourceArticle: 'SET-1', unitIndex: 1, codeIndex: 0 },
  ], 2);
  assert.deepEqual(rows.map((row) => row.codeIndex), [0, 1]);
  assert.deepEqual(rows.map((row) => row.orderId), ['OZ-1', 'OZ-2']);
});

test('rejects missing, duplicate and non-contiguous code indexes', () => {
  assert.throws(() => normalizeAllocations([], 1), /полное распределение/);
  assert.throws(() => normalizeAllocations([
    { orderId: '1', unitIndex: 1, codeIndex: 0 },
    { orderId: '2', unitIndex: 1, codeIndex: 0 },
  ], 2), /уникальными и непрерывными/);
});

test('allocation is part of the idempotency fingerprint', () => {
  const base = {
    gtin: '04627174095142', quantity: 1,
    productionDate: '2026-09-01', expirationDate: '2028-09-01',
    templateId: 30, releaseMethodType: 'REAPPLY', paymentType: 1,
  };
  const left = payloadFingerprint({ ...base, allocations: [{ orderId: 'OZ-1', unitIndex: 1, codeIndex: 0 }] });
  const right = payloadFingerprint({ ...base, allocations: [{ orderId: 'OZ-2', unitIndex: 1, codeIndex: 0 }] });
  assert.notEqual(left, right);
});
