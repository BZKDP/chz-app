'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
test('a real signing probe, not employee acknowledgement, clears durable blocking',async()=>{
  const data={settings:{}};let available=false,probes=0;
  const load=()=>{
    const sandbox={module:{exports:{}},console,require:name=>{
      if(name==='./config')return {bridge:{enabled:false,secret:'fixture'}};
      if(name==='./db')return {get:()=>data,save:()=>{}};
      if(name==='./signer')return {sign:async(mode,content)=>{probes++;assert.equal(mode,'auth');assert.match(content,/local key availability check/);return {ok:available,signature:'not-exposed'};}};
      if(name==='./bridge-transport')return {createTransport:()=>({})};
      if(name.startsWith('./'))return {};
      return require(name);
    }};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/bridge-worker.js'),'utf8')+'\nmodule.exports={checkSignature,signatureState,ensureSigningAvailable};',sandbox);
    return sandbox.module.exports;
  };
  let guard=load();
  assert.equal(await guard.checkSignature('button-1'),false);
  assert.equal(guard.signatureState().blocked,true);
  assert.equal(guard.signatureState().lastRequest.ok,false);
  guard=load();
  assert.equal(guard.signatureState().blocked,true,'USB wait survives process restart');
  assert.equal(await guard.ensureSigningAvailable(),false);
  assert.equal(probes,1,'blocked job cannot invoke paid/signing workflow');
  available=true;
  assert.equal(await guard.checkSignature('button-2'),true);
  assert.equal(guard.signatureState().blocked,false);
  assert.equal(guard.signatureState().lastRequest.id,'button-2');
  assert.equal(JSON.stringify(data).includes('not-exposed'),false,'signature never persisted or sent to portal');
});
