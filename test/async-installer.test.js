'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

test('Windows PowerShell preserves installer HMAC helper arguments and paths with spaces', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chz installer fixture '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/config.js'), "module.exports={bridge:{url:'https://fixture.invalid/api/chz-worker',secret:'fake',workerId:'fixture'}};");
  fs.writeFileSync(path.join(root, 'src/bridge-transport.js'), `module.exports={createTransport: config=>({request:async(method,url,body)=>{
    if(config.secret!=='fake'||config.workerId!=='fixture'||method!=='POST'||!url.endsWith('/maintenance')||body.pause!==true)throw Error('bad arguments');
    console.log('fixture-maintenance-ok'); return {ok:true};
  }})};`);
  const installer = fs.readFileSync(path.join(__dirname, '../public/upgrade-chz-async.ps1'), 'utf8');
  const js = installer.match(/\$js = @'\r?\n([\s\S]*?)\r?\n'@/)[1];
  const ps = "$js = @'\n" + js + "\n'@\n& '" + process.execPath.replace(/'/g, "''") + "' -e $js '" + root.replace(/'/g, "''") + "' pause\nexit $LASTEXITCODE";
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fixture-maintenance-ok/);
});
