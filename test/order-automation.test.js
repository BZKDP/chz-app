'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const automation = require('../src/order-automation');

test('validates exact unique codes for the ordered GTIN', () => {
  const order = { gtin: '04627174095012', quantity: 2 };
  assert.doesNotThrow(() => automation.validateCodes([
    '010462717409501221ABC',
    '010462717409501221XYZ'
  ], order));
  assert.throws(() => automation.validateCodes(['010462717409501221ABC'], order), /другое количество/);
  assert.throws(() => automation.validateCodes([
    '010462717409501221ABC',
    '010462717409501221ABC'
  ], order), /повторяющиеся/);
  assert.throws(() => automation.validateCodes([
    '010462717409501221ABC',
    '010462717409509921XYZ'
  ], order), /другого товара/);
});

test('maps technical states to employee-facing stages', () => {
  assert.equal(automation.publicStatus({ status: 'PENDING' }).label, 'Формируем заказ');
  assert.equal(automation.publicStatus({ status: 'UTILISATION_PENDING' }).label, 'Подтверждаем нанесение');
  assert.equal(automation.publicStatus({ status: 'INTRODUCTION_PENDING' }).label, 'Вводим в оборот');
  assert.deepEqual(automation.publicStatus({ status: 'INTRODUCED' }), {
    code: 'READY', label: 'Готово к печати', tone: 'success', progress: 100, step: 5
  });
  assert.equal(automation.publicStatus({ status: 'APPLIED', automationState: 'ATTENTION' }).code, 'ATTENTION');
});

test('only explicitly enabled production units are processed', () => {
  assert.equal(automation.isManaged({ automationMode: 'FULL', releaseMethodType: 'PRODUCTION', cisType: 'UNIT' }), true);
  assert.equal(automation.isManaged({ automationMode: 'FULL', releaseMethodType: 'REAPPLY', cisType: 'UNIT' }), false);
  assert.equal(automation.isManaged({ automationMode: 'FULL', releaseMethodType: 'PRODUCTION', cisType: 'SET' }), false);
  assert.equal(automation.isManaged({ releaseMethodType: 'PRODUCTION', cisType: 'UNIT' }), false);
});
