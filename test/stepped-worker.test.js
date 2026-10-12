'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fixture() {
  const intents = new Map(), events = [], calls = { orders: 0, utilisation: 0, introduction: 0 };
  let completeReport = false;
  const db = {
    findAutomationIntent: id => intents.get(id),
    upsertAutomationIntent: value => { const saved = { ...intents.get(value.clientRequestId), ...value }; intents.set(value.clientRequestId, saved); return saved; },
    findOrder: () => null,
    get: () => ({ operations: [] }), addOperation: () => {}, save: () => {}
  };
  const suz = {
    orderStatus: async () => ({ ok: true, buffers: [{ bufferStatus: 'PENDING' }] }),
    reportInfo: async () => ({ ok: true, reportStatus: completeReport ? 'SUCCESS' : 'PENDING' }),
    utilisation: async options => { calls.utilisation++; assert.equal(options.verifyTimeoutMs, 0); return { ok: false, reportId: 'report-fixture', pending: true }; },
    createOrder: async () => { calls.orders++; throw new Error('must not reissue'); }
  };
  const trueapi = {
    documentInfo: async () => ({ ok: true, document: { status: 'PROCESSING' } }),
    createDocument: async () => { calls.introduction++; throw new Error('must not resubmit'); }
  };
  const sandbox = { module: { exports: {} }, console, setTimeout: () => { throw new Error('waiting blocks other parties'); },
    require: name => {
      if (name === './config') return { bridge: { secret: 'fixture'.repeat(8), workerId: 'fixture' } };
      if (name === './bridge-transport') return { createTransport: () => ({}) };
      if (name === './db') return db;
      if (name === './suz') return suz;
      if (name === './trueapi') return trueapi;
      if (name === './signer') return {};
      return require(name);
    }, events, intents
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/bridge-worker.js'), 'utf8') + `
    ensureJobIsAllowed=()=>({}); prepareIntent=job=>intents.get(job.clientRequestId);
    ensureIntroductionReady=async()=>({identities:['fixture'],tnved:'1234567890'});
    progress=async(job,state)=>{job.state=state; events.push({id:job.id,state});};
    module.exports.processJob=processJob;
  `, sandbox);
  function job(id, state, extra = {}) {
    const item = { id, clientRequestId: String(id), state };
    intents.set(item.clientRequestId, { ...item, orderId: 'order-'+id, gtin:'00000000000001', quantity:1, codes:['fixture'], ...extra });
    return item;
  }
  return { ...sandbox.module.exports, suz, trueapi, job, intents, calls, events, finishReport: () => { completeReport = true; } };
}

test('proven pre-submit sign failure retries the existing intent, but ambiguous POST remains blocked', async () => {
  const f = fixture();
  const job = f.job(1, 'CLAIMED', { orderId: null, codes: [] });
  f.suz.createOrder = async () => ({ ok: false, stage: 'sign', error: 'sign failed' });
  await assert.rejects(f.processJob(job), /CryptoPro/);
  assert.equal(f.intents.get('1').state, 'CLAIMED');
  f.suz.createOrder = async () => ({ ok: false, stage: 'submit', error: 'Connection reset' });
  await f.processJob(job);
  assert.equal(f.intents.get('1').state, 'SUBMIT_UNKNOWN');
});

test('missing key during utilisation or introduction resumes only the proven unsent step', async () => {
  const f=fixture();
  const util=f.job(1,'CODES_RECEIVED');
  f.suz.utilisation=async()=>({ok:false,stage:'sign',error:'key unavailable'});
  await assert.rejects(f.processJob(util),/CryptoPro/);
  assert.equal(f.intents.get('1').state,'CODES_RECEIVED');
  const intro=f.job(2,'APPLIED');
  f.trueapi.createDocument=async()=>({ok:false,stage:'sign',error:'key unavailable'});
  await assert.rejects(f.processJob(intro),/CryptoPro/);
  assert.equal(f.intents.get('2').state,'APPLIED');
  f.trueapi.createDocument=async()=>({ok:false,stage:'submit',error:'unknown response'});
  await f.processJob(intro);
  assert.equal(f.intents.get('2').state,'INTRODUCTION_UNKNOWN');
});

test('pending utilisation yields; another party submits once; both can resume after restart', async () => {
  const f = fixture();
  const a = f.job(1, 'UTILISATION_PENDING', { reportId: 'existing-report' });
  const b = f.job(2, 'CODES_RECEIVED');
  await f.processJob(a);
  await f.processJob(b);
  assert.equal(f.calls.utilisation, 1);
  assert.equal(f.intents.get('2').reportId, 'report-fixture');
  await f.processJob(a); await f.processJob(b);
  assert.equal(f.calls.utilisation, 1, 'durable receipt prevents repeat POST');
  assert.equal(f.calls.orders, 0);
});

test('pending buffers and introduction return immediately without repeated submissions', async () => {
  const f = fixture();
  await f.processJob(f.job(1, 'ORDER_CREATED', { codes: [] }));
  await f.processJob(f.job(2, 'INTRODUCTION_PENDING', { introductionDocumentId: 'existing-document' }));
  assert.equal(f.calls.orders + f.calls.utilisation + f.calls.introduction, 0);
});

test('uncertain paid order, utilisation and introduction never resubmit', async () => {
  const f = fixture();
  await f.processJob(f.job(1, 'ORDER_SUBMITTING', { orderId: null, codes: [] }));
  await f.processJob(f.job(2, 'UTILISATION_SUBMITTING'));
  await f.processJob(f.job(3, 'INTRODUCTION_SUBMITTING'));
  assert.equal(f.calls.orders + f.calls.utilisation + f.calls.introduction, 0);
  assert.deepEqual(f.events.map(e => e.state), ['SUBMIT_UNKNOWN', 'UTILISATION_UNKNOWN', 'INTRODUCTION_UNKNOWN']);
});
