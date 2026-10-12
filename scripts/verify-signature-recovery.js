'use strict';
// Run on the authorized portal server. Only diagnostic signing, no paid jobs.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root='C:\\ProgramData\\CHZPortal\\app';
const config=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));
const payload=Buffer.from(JSON.stringify({user:config.authUser,exp:Date.now()+180000,nonce:crypto.randomUUID()})).toString('base64url');
const cookie=payload+'.'+crypto.createHmac('sha256',config.cookieSecret).update(payload).digest('base64url');
const headers={cookie:'chz_session='+cookie,'content-type':'application/json'};
async function request(route,method='GET'){
 const r=await fetch('http://127.0.0.1:3040'+route,{method,headers,...(method==='POST'?{body:'{}'}:{}),signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error(route+' HTTP '+r.status);return r.json();
}
(async()=>{
 const before=await request('/api/orders/summary');
 const status=await request('/api/status');
 if(status.bridge.version!=='2026.10.05.2'||!status.signatureRecovery.supported)throw Error('Office update not ready');
 const sent=await request('/api/signature/recheck','POST');
 const again=await request('/api/signature/recheck','POST');
 if(sent.recovery.request.id!==again.recovery.request.id)throw Error('Recheck duplicate');
 for(let i=0;i<55;i++){
  const current=await request('/api/status');
  const check=current.signatureRecovery.request;
  if(check.id===sent.recovery.request.id && ['FAILED','SUCCEEDED'].includes(check.state)){
   const after=await request('/api/orders/summary');
   if(before.length!==after.length)throw Error('Order count changed during diagnostic');
   console.log(JSON.stringify({workerVersion:current.bridge.version,connection:current.connection.code,signatureCheck:check.state,blocked:current.signatureRecovery.blocked,duplicateClickDeduplicated:true,orderCount:after.length,parties:after.filter(x=>[9,10].includes(x.remoteJobId)).map(x=>({id:x.id,quantity:x.quantity,status:x.status,printAllowed:x.printAllowed}))},null,2));
   if(check.state!=='SUCCEEDED')process.exitCode=2;return;
  }
  await new Promise(resolve=>setTimeout(resolve,2000));
 }
 throw Error('Diagnostic still pending; no paid jobs were created');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
