'use strict';
// One-off repair of two proven PRE-submit failures, only with service stopped.
// Never use for unknown/timeout submit results. No new IDs, serials or dates.
const fs = require('fs');
const [mode, file] = process.argv.slice(2);
if (!['worker', 'portal'].includes(mode) || !file) throw Error('Expected worker|portal and exact DB path');
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const targets = [
  {id:9, request:'employee:6712a120-36b7-45cc-9f50-5dd4ce80bab4', gtin:'04627174095142',quantity:100},
  {id:10, request:'employee:9e1e25d5-dba0-4c47-b36c-578d79a0a185', gtin:'04627174095067',quantity:60}
];
const rows = targets.map(t => {
  const j=(mode==='worker'?d.automationIntents:d.jobs).find(x => Number(mode==='worker'?x.remoteJobId:x.id)===t.id);
  if(!j||j.clientRequestId!==t.request||j.gtin!==t.gtin||Number(j.quantity)!==t.quantity||j.state!=='FAILED'||(mode==='worker'?j.lastError:j.error)!=='sign failed'||j.orderId||j.externalOrderId||j.codes?.length||j.reportId||j.externalReportId)throw Error('Pre-submit repair guard failed for '+t.id);
  if(mode==='worker'&&d.orders.some(o=>o.clientRequestId===t.request))throw Error('Existing paid order found; reconciliation required');
  return j;
});
const backup=file+'.before-sign-recovery-'+Date.now();
fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);
for(const j of rows){
  const at=Date.now();
  if(mode==='worker'){
    j.recoveryAudit=[...(j.recoveryAudit||[]),{at,from:'FAILED',reason:'Confirmed sign failure before paid POST; token refreshed successfully; retry original intent'}];
    j.lastError=null; j.state='CLAIMED';
  }else{
    j.activity.unshift({key:'pre_submit_recovered',label:'Подпись восстановлена. Продолжаем исходный заказ без дубликата.',tone:'progress',at});
    j.state='REQUESTED';j.error=null;j.pollError=null;j.pollFailures=0;j.nextPollAt=0;j.lastScheduledAt=0;j.leaseToken=null;j.leaseUntil=null;
  }
  j.updatedAt=at;
}
const tmp=file+'.repair-'+process.pid;
const fd=fs.openSync(tmp,'wx',0o600);
try{fs.writeFileSync(fd,JSON.stringify(d,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
fs.renameSync(tmp,file);
console.log(JSON.stringify({backup,recovered:rows.map(j=>({id:j.remoteJobId||j.id,state:j.state,quantity:j.quantity,productionDate:j.productionDate,expirationDate:j.expirationDate}))}));
