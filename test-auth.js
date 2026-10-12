// Живой тест: получить clientToken (True API + подпись на ноутбуке) и ping в СУЗ. Без денег.
const suz = require('./src/suz');
(async () => {
  console.log('1) Получаю токен (auth/key -> подпись на ноутбуке -> simpleSignIn)...');
  const t = await suz.getToken({ force: true, onProgress: s => console.log('   stage:', s) });
  if (!t.ok) { console.error('   ОШИБКА токена:', t.stage, t.error); process.exit(1); }
  console.log('   OK, токен получен (длина', t.token.length + ',', 'маска', t.token.slice(0, 8) + '…' + t.token.slice(-4) + ')');
  console.log('2) Ping СУЗ...');
  const p = await suz.ping();
  console.log('   ', p);
  process.exit(p.ok ? 0 : 2);
})();
