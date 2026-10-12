'use strict';
// Реестр фоновых задач с трансляцией прогресса через SSE.
const jobs = new Map(); // id -> { id, events:[], done, result, listeners:Set<res> }

function create() {
  const id = `job_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const job = { id, events: [], done: false, result: null, listeners: new Set() };
  jobs.set(id, job);
  // автоочистка через 10 минут
  setTimeout(() => jobs.delete(id), 10 * 60 * 1000);
  return job;
}

function emit(job, event, payload) {
  const msg = { event, payload, ts: Date.now() };
  job.events.push(msg);
  for (const res of job.listeners) writeEvent(res, msg);
}

function writeEvent(res, msg) {
  res.write(`event: ${msg.event}\n`);
  res.write(`data: ${JSON.stringify(msg.payload)}\n\n`);
}

function finish(job, result) {
  job.done = true;
  job.result = result;
  emit(job, 'result', result);
  emit(job, 'end', {});
}

function subscribe(id, res) {
  const job = jobs.get(id);
  if (!job) { res.status(404).end(); return; }
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders && res.flushHeaders();
  // отдать уже накопленные события
  for (const msg of job.events) writeEvent(res, msg);
  if (job.done) { res.end(); return; }
  job.listeners.add(res);
  res.on('close', () => job.listeners.delete(res));
}

module.exports = { create, emit, finish, subscribe };
