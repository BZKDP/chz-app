'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const {EventEmitter}=require('events');
test('hung CryptoPro descendants cannot hold the request past its deadline',async()=>{
  const spawned=[];
  const spawn=(bin,args)=>{spawned.push({bin,args});const p=new EventEmitter();p.pid=12345;p.stdout=new EventEmitter();p.stderr=new EventEmitter();p.kill=()=>{};return p;};
  const sandbox={module:{exports:{}},process:{platform:'win32'},setTimeout,clearTimeout,require:name=>name==='child_process'?{spawn}:name==='./config'?{signer:{}}:require(name)};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/signer.js'),'utf8')+'\nmodule.exports.testRun=run;',sandbox);
  const result=await sandbox.module.exports.testRun('powershell.exe',['fixture'],{timeoutMs:15});
  assert.equal(result.timedOut,true);
  assert.equal(spawned[1].bin,'taskkill.exe');
  assert.deepEqual(Array.from(spawned[1].args),['/PID','12345','/T','/F']);
});
