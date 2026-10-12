'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProduct } = require('../src/catalog-service');
const { batchSummary } = require('../src/bulk-order-worker');

test('keeps the official CHZ name and identifiers from product/info', () => {
  const existing = { id: 'p1', bulkExcluded: true, bulkExcludedReason: 'control failure' };
  const product = normalizeProduct({
    name: 'Биологически активная добавка к пище «Инозитол GraFLab»',
    brand: 'GrafLab',
    stateRegistrationCertificate: '1866513',
    goodSignedFlag: true,
    goodMarkFlag: true,
    goodTurnFlag: true
  }, { gtin: '04627174095005', isSet: false, isKit: false, goodStatus: 'published' }, existing);
  assert.equal(product.name, 'Биологически активная добавка к пище «Инозитол GraFLab»');
  assert.equal(product.registeredName, product.name);
  assert.equal(product.stateRegistrationCertificate, '1866513');
  assert.equal(product.gtin, '04627174095005');
  assert.equal(product.bulkExcluded, true);
});

test('bulk summary exposes progress without payment intent internals', () => {
  const summary = batchSummary({
    id: 'bulk-test',
    state: 'QUEUED',
    createdAt: 1,
    createdBy: 'test',
    totalQuantity: 2,
    totalCostKop: 122,
    items: [
      { id: 'i1', gtin: '04627174095005', name: 'Инозитол', quantity: 1, productionDate: '2026-03-04', expirationDate: '2028-03-04', state: 'QUEUED', clientRequestId: 'hidden-a' },
      { id: 'i2', gtin: '04627174095135', name: 'Инозитол', quantity: 1, productionDate: '2026-03-04', expirationDate: '2028-03-04', state: 'QUEUED', clientRequestId: 'hidden-b' }
    ]
  });
  assert.equal(summary.itemCount, 2);
  assert.equal(summary.totalQuantity, 2);
  assert.equal(summary.publicStatus.code, 'PROCESSING');
  assert.equal('clientRequestId' in summary.items[0], false);
});
