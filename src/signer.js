'use strict';
// Удалённая подпись УКЭП на офисном ноутбуке через SSH + CryptoPro csptest.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const S = cfg.signer;
const SSH = cfg.signerSshBin || 'ssh';
const SCP = cfg.signerScpBin || 'scp';

function powershellEncoded(script, opts) {
  const encoded = Buffer.from(String(script), 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], opts);
}

function sshBaseArgs() {
  return [
    '-i', S.key,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${S.connectTimeout}`
  ];
}

function run(bin, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '', err = '';
    let settled = false;
    const finish = result => { if (!settled) { settled = true; clearTimeout(t); resolve(result); } };
    const t = setTimeout(() => {
      // CryptoPro can retain inherited pipes after its PowerShell parent dies.
      // Kill only this spawned process tree and resolve at the deadline; never
      // wait indefinitely for the descendant's stdout/close event.
      if (process.platform === 'win32' && p.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { try { p.kill(); } catch (_) {} });
      } else { try { p.kill(); } catch (_) {} }
      finish({ code: -1, out: '', err: 'Signing process timed out', timedOut: true });
    }, timeoutMs);
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('error', e => finish({ code: -1, out, err: String(e) }));
    p.on('close', code => finish({ code, out, err }));
  });
}

function isTransientSsh(r) {
  const s = (r.err || '') + (r.out || '');
  return r.code !== 0 && /Connection timed out|Connection refused|Connection closed|kex_exchange|Connection reset|timed out|Broken pipe|No route to host/i.test(s);
}

// Ретрай SSH/SCP при кратковременной недоступности ноутбука (сон/WiFi).
async function runRetry(bin, args, opts) {
  let r;
  for (let a = 1; a <= 3; a++) {
    r = await run(bin, args, opts);
    if (r.code === 0 || !isTransientSsh(r)) return r;
    await new Promise(res => setTimeout(res, 1500 * a));
  }
  return r;
}

async function ssh(command, opts) {
  const args = [...sshBaseArgs(), `${S.user}@${S.host}`, command];
  return runRetry(SSH, args, opts);
}

async function scpTo(localFile, remoteFile) {
  const remote = `${S.user}@${S.host}:${remoteFile.replace(/\\/g, '/')}`;
  const args = [...sshBaseArgs(), localFile, remote];
  return runRetry(SCP, args);
}

// Быстрый статус ноутбука: доступность SSH, наличие csptest и целевого сертификата.
async function status() {
  const script =
    `$c=Test-Path '${S.csptest}';` +
    `$t=(Get-ChildItem Cert:\\CurrentUser\\My,Cert:\\LocalMachine\\My -EA SilentlyContinue | Where-Object {$_.Thumbprint -eq '${S.thumbprint}'});` +
    `Write-Output ('csptest='+$c);` +
    `Write-Output ('cert='+([bool]$t));` +
    `if($t){Write-Output ('certUntil='+$t[0].NotAfter.ToString('yyyy-MM-dd'))}`;
  const command = `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
  const r = S.local ? await powershellEncoded(script, { timeoutMs: 15000 }) : await ssh(command, { timeoutMs: 15000 });
  const online = r.code === 0;
  const info = { online, csptest: false, cert: false, certUntil: null, raw: (r.out || r.err || '').trim() };
  if (online) {
    info.csptest = /csptest=True/i.test(r.out);
    info.cert = /cert=True/i.test(r.out);
    const m = r.out.match(/certUntil=([\d-]+)/);
    if (m) info.certUntil = m[1];
  } else {
    info.error = (r.err || 'connection failed').trim();
  }
  return info;
}

// Подпись строки. mode: 'auth' (присоединённая) | 'detached' (открепленная CMS).
// onProgress(stage) — 'prepare' | 'upload' | 'sign' | 'done'
async function sign(mode, content, { onProgress } = {}) {
  const prog = onProgress || (() => {});
  const id = `${mode}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const localFile = path.join(cfg.workDir, id);
  const remoteFile = S.local ? localFile : `${S.workdir}\\${id}`;

  prog('prepare');
  fs.mkdirSync(cfg.workDir, { recursive: true });
  // ВАЖНО: байты файла = ровно то, что подписываем (UTF-8 без BOM).
  fs.writeFileSync(localFile, content, { encoding: 'utf8' });

  if (!S.local) {
    prog('upload');
    const up = await scpTo(localFile, remoteFile);
    if (up.code !== 0) {
      try { fs.unlinkSync(localFile); } catch (_) {}
      return { ok: false, stage: 'upload', error: (up.err || 'scp failed').trim() };
    }
  }

  prog('sign');
  const cmd = `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${S.scriptPath}" -Mode ${mode} -In "${remoteFile}" -Thumb ${S.thumbprint}`;
  const r = S.local
    ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', S.scriptPath, '-Mode', mode, '-In', remoteFile, '-Thumb', S.thumbprint], { timeoutMs: 90000 })
    : await ssh(cmd, { timeoutMs: 90000 });
  try { fs.unlinkSync(localFile); } catch (_) {}
  if (r.code !== 0) {
    if (r.timedOut) return { ok: false, stage: 'sign', code: 'SIGN_TIMEOUT', error: 'CryptoPro не завершил подпись за 90 секунд. Проверьте носитель ЭЦП и запрос PIN на компьютере подписи.' };
    return { ok: false, stage: 'sign', error: (r.err || r.out || 'sign failed').trim() };
  }
  const signature = (r.out || '').replace(/\s/g, '');
  if (signature.length < 100) {
    return { ok: false, stage: 'sign', error: `signature too short (${signature.length}): ${r.err}` };
  }
  prog('done');
  return { ok: true, signature, remoteFile };
}

// Развернуть/обновить chz_sign.ps1 на ноутбуке (копия из laptop/chz_sign.ps1).
async function deployScript() {
  const local = path.join(__dirname, '..', 'laptop', 'chz_sign.ps1');
  if (S.local) {
    try {
      fs.mkdirSync(path.dirname(S.scriptPath), { recursive: true });
      fs.copyFileSync(local, S.scriptPath);
      return { ok: true, error: null };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  }
  const r = await scpTo(local, S.scriptPath);
  return { ok: r.code === 0, error: r.code === 0 ? null : (r.err || '').trim() };
}

module.exports = { status, sign, deployScript, ssh };
