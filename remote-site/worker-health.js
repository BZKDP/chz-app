'use strict';
const crypto = require('crypto');

function authenticate({ method, path, headers, body, secret, nonces, now = Date.now() }) {
  const id = String(headers['x-chz-worker-id'] || '');
  const stamp = String(headers['x-chz-timestamp'] || '');
  const nonce = String(headers['x-chz-nonce'] || '');
  const signature = String(headers['x-chz-signature'] || '');
  if (!id || id.length > 120 || !nonce || nonce.length > 128 || !/^\d+$/.test(stamp) || !/^[a-f0-9]{64}$/.test(signature)) {
    return { status: 401, code: 'AUTH_INVALID', error: 'Worker authentication failed' };
  }
  const signed = [method.toUpperCase(), path, stamp, nonce, crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex')].join('\n');
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return { status: 401, code: 'SIGNATURE_INVALID', error: 'Worker signature is invalid' };
  const skewMs = now - Number(stamp) * 1000;
  if (Math.abs(skewMs) > 300000) return { status: 401, code: 'CLOCK_SKEW', error: 'Clock differs from server by more than 5 minutes', workerId: id, skewMs };
  for (const [key, at] of nonces) if (now - at > 600000) nonces.delete(key);
  if (nonces.has(nonce)) return { status: 409, code: 'NONCE_REPLAY', error: 'Worker nonce was already used' };
  nonces.set(nonce, now);
  return { workerId: id };
}

function connectionHealth(worker, now = Date.now()) {
  const lastSeenAt = Number(worker.lastSeenAt || 0);
  const ageMs = lastSeenAt ? Math.max(0, now - lastSeenAt) : null;
  const online = ageMs !== null && ageMs < 45000;
  const status = worker.status || {};
  const clockOffsetMs = Number(status.clockOffsetMs || 0);
  const common = { online, lastSeenAt: lastSeenAt || null, ageMs, version: status.version || null, clockOffsetMs };
  if (worker.lastAuthFailure?.code === 'CLOCK_SKEW' && worker.lastAuthFailure.at > lastSeenAt && now - worker.lastAuthFailure.at < 120000) {
    return { ...common, code: 'CLOCK_SKEW', label: 'Сбились часы на ПК', note: 'Ожидаем синхронизацию времени Windows. Очередь сохранена.' };
  }
  if (!online) return { ...common, code: 'OFFLINE', label: 'Ожидаем компьютер ЧЗ', note: 'Включите ПК, войдите в Windows и подключите интернет. Обработка продолжится после восстановления связи; повторный заказ не нужен.' };
  if (Math.abs(clockOffsetMs) > 120000) return { ...common, code: 'CLOCK_SKEW', label: 'Сбились часы на ПК', note: 'Связь восстановлена с поправкой времени. Выпуск ожидает синхронизации часов Windows.' };
  if (status.signature?.checking) return { ...common, code: 'SIGNATURE_CHECKING', label: 'Проверяем доступ к ЭЦП', note: 'Проверяем подпись на офисном ПК. Если CryptoPro запросит PIN, введите его на том ПК. Проверка может занять до двух минут.' };
  if (status.signature?.blocked) return { ...common, code: 'SIGNATURE_REQUIRED', label: 'ЭЦП недоступна — проверьте флешку', note: 'Подключите носитель ЭЦП к ПК ЧЗ. Проверьте окно CryptoPro и нажмите «ЭЦП подключена — проверить и продолжить». Задания сохранены, повторно заказывать коды не нужно.' };
  const signer = status.signer;
  const signerAge = signer ? now - (Number(signer.checkedAt || 0) + clockOffsetMs) : Infinity;
  if (!signer || signerAge > 120000 || signerAge < -120000) return { ...common, code: 'CHECKING', label: 'Проверяем электронную подпись', note: status.version ? 'ПК подключён. Ожидаем свежую проверку CryptoPro и сертификата.' : 'ПК подключён. Для подробной диагностики требуется обновление офисной программы.' };
  if (!signer.online || !signer.csptest || !signer.cert || (signer.certUntil && signer.certUntil < new Date(now).toISOString().slice(0, 10))) {
    return { ...common, code: 'SIGNER_UNAVAILABLE', label: 'Проверьте электронную подпись', note: 'ПК на связи, но CryptoPro или действующий сертификат недоступны. Проверьте носитель и учётную запись Windows.' };
  }
  if (status.lastError) return { ...common, code: 'RETRYING', label: 'Повторяем подключение к сервису', note: 'Последняя операция встретила ошибку. Безопасные проверки повторяются автоматически; подробности доступны в партии.' };
  return { ...common, code: 'ONLINE', label: 'ПК ЧЗ на связи', note: 'CryptoPro и сертификат проверены. Обработка идёт автоматически.' };
}
module.exports = { authenticate, connectionHealth };
