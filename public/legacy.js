'use strict'; // Сохранённый технический интерфейс для расширенных операций.
const $ = (s, r = document) => r.querySelector(s);
const el = (t, a = {}, ...kids) => { const e = document.createElement(t); for (const k in a) { if (k === 'class') e.className = a[k]; else if (k === 'html') e.innerHTML = a[k]; else if (k.startsWith('on')) e.addEventListener(k.slice(2), a[k]); else e.setAttribute(k, a[k]); } for (const c of kids) e.append(c && c.nodeType ? c : document.createTextNode(c == null ? '' : c)); return e; };
const rub = k => (Number(k || 0) / 100).toFixed(2) + ' ₽';
async function api(m, u, b) { const r = await fetch(u, { method: m, headers: b ? { 'Content-Type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); try { return JSON.parse(t); } catch { return { ok: false, error: t }; } }

const STAGE_LABEL = { authKey: 'запрос auth/key', prepare: 'подготовка', upload: 'отправка на ноутбук', sign: 'подпись УКЭП', signIn: 'авторизация', submit: 'отправка в СУЗ', verify: 'проверка квитанции', done: 'подтверждено' };

// запустить job и слушать прогресс по SSE
function runJob(url, body, onStage) {
  return new Promise(async (resolve) => {
    const { jobId } = await api('POST', url, body);
    if (!jobId) return resolve({ ok: false, error: 'no jobId' });
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    es.addEventListener('progress', e => onStage && onStage(JSON.parse(e.data).stage));
    es.addEventListener('result', e => { resolve(JSON.parse(e.data)); });
    es.addEventListener('end', () => es.close());
    es.onerror = () => { es.close(); };
  });
}

const TABS = [
  ['status', 'Статус'], ['products', 'Товары'], ['order', 'Заказ КМ'],
  ['orders', 'Заказы и коды'], ['dropout', 'Вывод из оборота'], ['money', 'Баланс и расходы']
];
let ST = {};

function initNav() {
  const nav = $('#nav');
  TABS.forEach(([id, name], i) => nav.append(el('button', { class: i === 0 ? 'active' : '', onclick: () => show(id) }, name)));
}
function show(id) {
  document.querySelectorAll('nav button').forEach((b, i) => b.classList.toggle('active', TABS[i][0] === id));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + id));
  render(id);
}

async function loadStatus() {
  ST = await api('GET', '/api/status');
  const lp = ST.laptop || {};
  $('#env').textContent = ST.env || '—';
  $('#omsLine').textContent = 'omsId ' + (ST.omsId || '');
  const dot = $('#laptopDot'), txt = $('#laptopText');
  if (lp.online && lp.csptest && lp.cert) { dot.style.background = 'var(--ok)'; txt.textContent = 'ноутбук готов (ЭЦП до ' + (lp.certUntil || '?') + ')'; }
  else if (lp.online) { dot.style.background = 'var(--warn)'; txt.textContent = 'ноутбук онлайн, но ' + (!lp.csptest ? 'нет csptest' : 'нет сертификата'); }
  else { dot.style.background = 'var(--err)'; txt.textContent = 'ноутбук офлайн'; }
}

// ---------- рендер вкладок ----------
async function loadBalance() { const r = await api('GET', '/api/balance/live'); if (r.ok) ST.balance = { balances: r.balances }; return r; }
function balanceTotalKop() { return (ST.balance && ST.balance.balances || []).reduce((s, b) => s + (b.balanceKop || 0), 0); }

async function render(id) {
  await loadStatus();
  if ((id === 'status' || id === 'money') && !ST.balance) await loadBalance();
  if (id === 'status') return renderStatus();
  if (id === 'products') return renderProducts();
  if (id === 'order') return renderOrder();
  if (id === 'orders') return renderOrders();
  if (id === 'dropout') return renderDropout();
  if (id === 'money') return renderMoney();
}

function renderStatus() {
  const lp = ST.laptop || {}, tok = ST.token, co = ST.company;
  const c = $('#tab-status'); c.innerHTML = '';
  c.append(
    el('div', { class: 'card' },
      el('div', { class: 'row' }, el('h2', { style: 'margin:0' }, 'Организация'),
        el('button', { class: 'ghost', style: 'margin-left:auto', onclick: async ev => { ev.target.disabled = true; ev.target.textContent = 'запрос…'; await api('GET', '/api/company'); await loadStatus(); renderStatus(); } }, 'Обновить профиль из ЧЗ')),
      el('div', { style: 'height:8px' }),
      co ? el('div', {}, kv('Наименование', co.name), kv('ИНН', ST.orgInn), kv('Статус', co.status || '—', /Зарег/i.test(co.status || '') ? 'ok' : 'warn'),
        kv('Товарные группы', (co.productGroups || []).join(', ') || '—')) : el('div', { class: 'mut' }, 'Нажмите «Обновить профиль из ЧЗ».')),
    el('div', { class: 'card' },
      el('h2', {}, 'Подписывающий ноутбук'),
      kv('Хост', ST.laptop && ST.laptop.online ? 'онлайн' : 'офлайн', lp.online ? 'ok' : 'err'),
      kv('csptest (CryptoPro)', lp.csptest ? 'найден' : 'нет', lp.csptest ? 'ok' : 'err'),
      kv('Сертификат УКЭП', lp.cert ? ('есть, до ' + (lp.certUntil || '?')) : 'нет', lp.cert ? 'ok' : 'err'),
      lp.error ? el('div', { class: 'notice' }, 'Ошибка: ' + lp.error) : '',
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', { class: 'ghost', onclick: async ev => { ev.target.textContent = 'обновляю…'; await loadStatus(); renderStatus(); } }, 'Обновить статус'),
        el('button', { class: 'ghost', onclick: async ev => { ev.target.disabled = true; const r = await api('POST', '/api/laptop/deploy'); alert(r.ok ? 'Скрипт подписи развёрнут' : 'Ошибка: ' + r.error); ev.target.disabled = false; } }, 'Развернуть скрипт подписи'))
    ),
    el('div', { class: 'card' },
      el('h2', {}, 'Авторизация в ЧЗ'),
      kv('Контур', ST.env),
      kv('СУЗ-токен', tok && tok.valid ? ('действителен (' + Math.round(tok.ageMs / 60000) + ' мин)') : 'нет/истёк', tok && tok.valid ? 'ok' : 'warn'),
      el('div', { id: 'pingSteps', class: 'steps' }),
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', { class: 'act', onclick: doRefreshToken }, 'Получить токен заново'),
        el('button', { class: 'ghost', onclick: doPing }, 'Проверить связь (ping)'),
        el('span', { id: 'pingRes', class: 'mut' }))
    ),
    el('div', { class: 'card' },
      el('div', { class: 'row' }, el('h2', { style: 'margin:0' }, 'Баланс лицевого счёта (из ЧЗ)'),
        el('button', { class: 'ghost', style: 'margin-left:auto', onclick: async ev => { ev.target.disabled = true; ev.target.textContent = 'обновляю…'; await loadBalance(); renderStatus(); } }, 'Обновить баланс')),
      el('div', { style: 'height:8px' }),
      el('div', { class: 'kpi' },
        ...((ST.balance && ST.balance.balances || []).map(b => el('div', {}, el('div', { class: 'mut' }, b.name), el('div', { class: 'big' }, rub(b.balanceKop))))),
        el('div', {}, el('div', { class: 'mut' }, 'Итого'), el('div', { class: 'big' }, rub(balanceTotalKop()))),
        el('div', {}, el('div', { class: 'mut' }, 'Потрачено на КМ (учёт)'), el('div', { class: 'big' }, rub(ST.spentTotalKop))),
        el('div', {}, el('div', { class: 'mut' }, 'Цена 1 кода'), el('div', { class: 'big' }, rub(ST.tariff.grossKop))))
    )
  );
}
function kv(k, v, cls) { return el('div', { class: 'row', style: 'padding:4px 0' }, el('span', { class: 'mut', style: 'width:200px' }, k), cls ? el('span', { class: 'pill ' + cls }, v) : el('span', {}, v)); }

async function doRefreshToken(ev) {
  const steps = $('#pingSteps'); steps.innerHTML = ''; ev.target.disabled = true;
  const order = ['authKey', 'prepare', 'upload', 'sign', 'signIn', 'done'];
  order.forEach(s => steps.append(el('span', { id: 'st-' + s }, STAGE_LABEL[s] || s)));
  const r = await runJob('/api/token/refresh', {}, stage => {
    const e = $('#st-' + stage); if (e) e.className = 'cur';
    order.slice(0, order.indexOf(stage)).forEach(s => { const x = $('#st-' + s); if (x) x.className = 'done'; });
  });
  ev.target.disabled = false;
  alert(r.ok ? 'Токен получен' : 'Ошибка: ' + (r.error || JSON.stringify(r)));
  renderStatus();
}
async function doPing() {
  const res = $('#pingRes'); res.textContent = 'проверяю…';
  const r = await api('GET', '/api/ping');
  res.innerHTML = r.ok ? `<span class="pill ok">связь есть, API ${r.apiVersion}</span>` : `<span class="pill err">${r.error || 'ошибка'}</span>`;
}

async function renderProducts() {
  const prods = await api('GET', '/api/products');
  const c = $('#tab-products'); c.innerHTML = '';
  const tbl = el('table', {}, el('tr', {}, el('th', {}, 'Название'), el('th', {}, 'GTIN'), el('th', {}, 'Бренд / упаковка'), el('th', {}, 'ТГ'), el('th', {}, 'template'), el('th', {}, 'Срок, дн'), el('th', {}, '')));
  prods.forEach(p => tbl.append(el('tr', {},
    el('td', {}, el('b', {}, p.name || '—')),
    el('td', { class: 'mono' }, p.gtin),
    el('td', { class: 'mut' }, [p.brand, p.packageType].filter(Boolean).join(' · ') || '—'),
    el('td', {}, p.productGroup ? el('span', { class: 'pill' }, p.productGroup) : '—'),
    el('td', {}, String(p.templateId || 30)),
    el('td', {}, p.expirationDays || '—'),
    el('td', {}, el('button', { class: 'ghost', onclick: async () => { if (confirm('Удалить товар?')) { await api('DELETE', '/api/products/' + p.id); renderProducts(); } } }, 'удалить')))));
  const f = el('div', { class: 'row' },
    inp('gtin', 'GTIN (14 цифр)', ''), inp('name', 'Название (пусто = из ЧЗ)', ''), inp('templateId', 'templateId', '30'), inp('expirationDays', 'Срок годн., дн', '730'),
    el('button', { class: 'act', onclick: async ev => { ev.target.disabled = true; ev.target.textContent = 'запрашиваю ЧЗ…'; const b = { gtin: v('gtin'), name: v('name'), templateId: v('templateId'), expirationDays: v('expirationDays') }; const r = await api('POST', '/api/products', b); ev.target.disabled = false; ev.target.textContent = 'Добавить'; if (r.error) alert(r.error); else renderProducts(); } }, 'Добавить'));
  c.append(
    el('div', { class: 'card' },
      el('div', { class: 'row' }, el('h2', { style: 'margin:0' }, 'Наши товары'),
        el('button', { class: 'ghost', style: 'margin-left:auto', onclick: async ev => { ev.target.disabled = true; ev.target.textContent = 'обновляю…'; const r = await api('POST', '/api/products/refresh'); ev.target.disabled = false; if (r.error) alert('ЧЗ: ' + r.error); renderProducts(); } }, 'Обновить названия из ЧЗ')),
      el('div', { style: 'height:10px' }), tbl),
    el('div', { class: 'card' }, el('h2', {}, 'Добавить товар по GTIN'),
      el('div', { class: 'notice', style: 'margin-bottom:10px' }, 'Введите GTIN — название, бренд и товарная группа подтянутся из Честного Знака автоматически.'), f),
    el('div', { class: 'card' },
      el('h2', {}, 'Массовое добавление по списку GTIN'),
      el('div', { class: 'notice', style: 'margin-bottom:10px' }, 'Вставь все свои GTIN (по одному в строке или через пробел/запятую) — приложение добавит их все и подтянет названия из Честного Знака.'),
      el('textarea', { id: 'bulkGtins', placeholder: '04627174095012\n0460...', style: 'width:100%;min-height:120px;background:#0d1218;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:8px', class: 'mono' }),
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', { class: 'act', onclick: async ev => { ev.target.disabled = true; ev.target.textContent = 'добавляю…'; const r = await api('POST', '/api/products/bulk', { text: $('#bulkGtins').value }); ev.target.disabled = false; ev.target.textContent = 'Добавить все'; if (r.error) alert(r.error); else { alert(`Добавлено: ${r.added}, пропущено (дубли): ${r.skipped}` + (r.noInfo ? `, без названия из ЧЗ: ${r.noInfo}` : '')); renderProducts(); } } }, 'Добавить все')),
      el('div', { style: 'height:14px' }),
      el('h2', {}, 'Загрузить все товары из ЧЗ автоматически'),
      el('div', { class: 'notice', style: 'margin-bottom:10px' }, 'Один клик — приложение получит ВСЕ твои GTIN по всем товарным группам организации (product/gtin) и подтянет названия. apikey не нужен.'),
      el('button', { class: 'act', onclick: async ev => { ev.target.disabled = true; ev.target.textContent = 'загружаю из ЧЗ…'; const r = await api('POST', '/api/products/load-all'); ev.target.disabled = false; ev.target.textContent = 'Загрузить все товары из ЧЗ'; if (r.error) alert(r.error); else alert(`Найдено GTIN: ${r.foundGtins} (группы: ${(r.groups || []).join(', ')})\nДобавлено: ${r.added}, пропущено (уже были): ${r.skipped}`); renderProducts(); } }, 'Загрузить все товары из ЧЗ')));
}
function inp(id, ph, val) { return el('div', {}, el('label', {}, ph), el('input', { id: 'in-' + id, value: val, placeholder: ph })); }
function v(id) { const e = $('#in-' + id); return e ? e.value.trim() : ''; }

async function renderOrder() {
  const prods = await api('GET', '/api/products');
  const c = $('#tab-order'); c.innerHTML = '';
  const sel = el('select', { id: 'in-prod' });
  const orderable = p => !p.isSet && !p.isKit && (!p.productGroup || p.productGroup === 'bio');
  const sorted = [...prods].sort((a, b) => (orderable(b) ? 1 : 0) - (orderable(a) ? 1 : 0));
  sorted.forEach(p => {
    const ok = orderable(p);
    const suffix = p.isSet || p.isKit ? '  [набор — заказ недоступен]' : (p.productGroup && p.productGroup !== 'bio' ? `  [${p.productGroup} — другое подключение]` : '');
    sel.append(el('option', Object.assign({ value: p.id }, ok ? {} : { disabled: 'disabled' }), `${p.name} — ${p.gtin}${suffix}`));
  });
  const card = el('div', { class: 'card' },
    el('h2', {}, 'Новый заказ кодов маркировки'),
    el('div', { class: 'row' }, el('div', {}, el('label', {}, 'Товар'), sel), inp('qty', 'Количество', '1')),
    el('div', { id: 'orderEst', class: 'notice', style: 'margin-top:10px' }),
    el('div', { class: 'steps', id: 'orderSteps' }),
    el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'act', id: 'orderBtn', onclick: () => doOrder(prods) }, 'Заказать КМ')),
    el('div', { id: 'orderRes' })
  );
  c.append(card);
  const upd = () => { const q = Number(v('qty')) || 0; $('#orderEst').textContent = `Будет заказано ${q} КМ · ориентировочный расход ${rub(q * ST.tariff.grossKop)} (${ST.tariff.grossKop} коп./код с НДС). Контур: ${ST.env}.`; };
  $('#in-qty').addEventListener('input', upd); upd();
}
async function doOrder(prods) {
  const p = prods.find(x => x.id === $('#in-prod').value);
  const qty = Number(v('qty'));
  if (!p || !qty || qty < 1) return alert('Выберите товар и количество');
  if (!confirm(`ПОДТВЕРЖДЕНИЕ (${ST.env})\n\nТовар: ${p.name}\nGTIN: ${p.gtin}\nКоличество: ${qty} КМ\nРасход: ~${rub(qty * ST.tariff.grossKop)}\n\nСоздать реальный заказ в Честном Знаке?`)) return;
  const btn = $('#orderBtn'); btn.disabled = true;
  const steps = $('#orderSteps'); steps.innerHTML = '';
  const order = ['authKey', 'prepare', 'upload', 'sign', 'submit', 'done'];
  order.forEach(s => steps.append(el('span', { id: 'os-' + s }, STAGE_LABEL[s] || s)));
  const r = await runJob('/api/order', { gtin: p.gtin, quantity: qty, name: p.name, templateId: p.templateId }, stage => {
    const e = $('#os-' + stage); if (e) e.className = 'cur';
    order.slice(0, order.indexOf(stage)).forEach(s => { const x = $('#os-' + s); if (x) x.className = 'done'; });
  });
  btn.disabled = false;
  $('#orderRes').innerHTML = r.ok
    ? `<div class="notice" style="color:var(--ok)">Заказ создан. orderId: <span class="mono">${r.orderId}</span>. Готовность ~${Math.round((r.expectedCompleteTimestamp || 0) / 1000)} c. Перейдите во вкладку «Заказы и коды».</div>`
    : `<div class="notice" style="color:var(--err)">Ошибка (${r.stage || ''}): ${r.error || JSON.stringify(r)}</div>`;
}

let ordersPollTimer = null;
const STATUS_RU = { CREATED: 'создан', PENDING: 'готовится', APPROVED: 'подтверждён', ACTIVE: 'готов (коды доступны)', REJECTED: 'отклонён', CODES_RECEIVED: 'коды получены', UTILISATION_PENDING: 'отчёт о нанесении обрабатывается', UTILISATION_FAILED: 'ошибка отчёта о нанесении', APPLIED: 'нанесён, ожидает ввода', INTRODUCED: 'введён в оборот', UTILISED: 'старый статус: только нанесён', APPLIED_REAPPLY_INVALID: 'карантин: неверный тип REAPPLY', EMITTED_REAPPLY_INVALID: 'карантин: неверный тип REAPPLY', REAPPLY_INVALID_REVIEW: 'карантин: проверить REAPPLY', WITHDRAWN: 'выведен из оборота' };
const PENDING_STATES = ['CREATED', 'PENDING', 'APPROVED', undefined, null, ''];
function isPending(s) { return PENDING_STATES.includes(s); }

async function renderOrders() {
  if (ordersPollTimer) { clearTimeout(ordersPollTimer); ordersPollTimer = null; }
  const orders = await api('GET', '/api/orders');
  const c = $('#tab-orders'); c.innerHTML = '';
  if (!orders.length) { c.append(el('div', { class: 'card mut' }, 'Заказов пока нет. Создайте заказ во вкладке «Заказ КМ».')); return; }
  orders.forEach(o => {
    const cls = ['REJECTED', 'UTILISATION_FAILED', 'APPLIED_REAPPLY_INVALID', 'EMITTED_REAPPLY_INVALID', 'REAPPLY_INVALID_REVIEW'].includes(o.status) ? ' rej' : (['ACTIVE', 'CODES_RECEIVED', 'APPLIED', 'INTRODUCED', 'WITHDRAWN'].includes(o.status) ? ' ok' : '');
    const pending = isPending(o.status);
    const card = el('div', { class: 'card order-card' + cls, id: 'ord-' + o.id });
    card.append(
      el('div', { class: 'row' },
        el('div', {}, el('b', {}, o.name || o.gtin), ' · ', el('span', { class: 'mono' }, o.gtin), ' · ', o.quantity + ' КМ'),
        el('span', { class: 'pill ' + statusCls(o.status) + (pending ? ' pending' : ''), style: 'margin-left:auto' },
          pending ? el('span', { class: 'spinner', style: 'margin-right:6px' }) : '', STATUS_RU[o.status] || o.status || '—')),
      el('div', { class: 'mut', style: 'margin:6px 0' }, 'orderId ', el('span', { class: 'mono' }, o.id), ' · расход ' + rub(o.spendKop) +
        (o.availableCodes != null && o.totalCodes != null && o.totalCodes >= 0 ? ` · буфер ${o.availableCodes}/${o.totalCodes}` : '')),
      o.status === 'REJECTED' && o.rejectionReason ? el('div', { class: 'notice', style: 'color:var(--err);margin-bottom:8px' }, '⛔ ' + o.rejectionReason) : '',
      pending ? el('div', { class: 'notice', style: 'margin-bottom:8px' }, 'Заказ обрабатывается в Честном Знаке — статус обновляется автоматически…') : '',
      el('div', { class: 'row' },
        el('button', { class: 'ghost', onclick: () => refreshOrder(o.id) }, 'Обновить статус'),
        (o.status === 'ACTIVE' && !(o.codes && o.codes.length)) ? el('button', { class: 'act', onclick: () => fetchCodes(o.id) }, 'Получить коды') : '',
        (o.codes && o.codes.length) ? el('button', { class: 'ghost', onclick: () => toggleDM(o.id) }, 'DataMatrix') : '',
        (o.codes && o.codes.length && !o.doNotPrintOrShip && !o.appliedAt && !o.utilisedAt && o.status !== 'UTILISATION_PENDING') ? el('button', { class: 'act', onclick: () => showUtil(o) }, 'Отчёт о нанесении') : '',
        o.doNotPrintOrShip ? el('span', { class: 'pill rej' }, 'НЕ КЛЕИТЬ / НЕ ОТГРУЖАТЬ') : '',
        o.status === 'UTILISATION_PENDING' ? el('button', { class: 'ghost', onclick: () => refreshUtilStatus(o.id) }, 'Проверить ввод') : '',
        (o.appliedAt || o.utilisedAt) && o.status !== 'INTRODUCED' ? el('span', { class: 'pill ok' }, 'нанесён; не введён в оборот') : '',
        o.status === 'INTRODUCED' ? el('span', { class: 'pill ok' }, 'введён в оборот') : '',
        (o.codes && o.codes.length && o.status !== 'WITHDRAWN') ? el('button', { class: 'ghost', onclick: () => showWithdraw(o) }, 'Вывести из оборота') : '',
        o.status === 'WITHDRAWN' ? el('span', { class: 'pill ok' }, 'выведен из оборота') : ''),
      el('div', { id: 'dm-' + o.id }),
      el('div', { id: 'util-' + o.id })
    );
    c.append(card);
  });
  // авто-опрос статуса для «готовящихся» заказов
  const pend = orders.filter(o => isPending(o.status));
  if (pend.length) {
    ordersPollTimer = setTimeout(async () => {
      await Promise.all(pend.map(o => api('GET', `/api/order/${o.id}/status`).catch(() => {})));
      if ($('#tab-orders').classList.contains('active')) renderOrders();
    }, 4000);
  }
}
function statusCls(s) { return ['ACTIVE', 'CODES_RECEIVED', 'APPLIED', 'INTRODUCED', 'WITHDRAWN'].includes(s) ? 'ok' : ['REJECTED', 'UTILISATION_FAILED', 'APPLIED_REAPPLY_INVALID', 'EMITTED_REAPPLY_INVALID', 'REAPPLY_INVALID_REVIEW'].includes(s) ? 'err' : 'warn'; }
async function refreshOrder(id) { const r = await api('GET', `/api/order/${id}/status`); if (!r.ok) alert('Ошибка: ' + r.error); renderOrders(); }
async function refreshUtilStatus(id) { const r = await api('GET', `/api/order/${id}/utilisation-status`); if (!r.ok) alert('Ошибка: ' + r.error); renderOrders(); }
async function fetchCodes(id) { const r = await api('POST', `/api/order/${id}/fetch-codes`); if (!r.ok) alert('Ошибка: ' + (r.error || JSON.stringify(r))); renderOrders(); }
function codeVisible(c) { return String(c).replace(new RegExp(String.fromCharCode(29), 'g'), '␣'); }
async function toggleDM(id) {
  const box = $('#dm-' + id); if (box.innerHTML) { box.innerHTML = ''; return; }
  const o = (await api('GET', '/api/orders')).find(x => x.id === id);
  const bar = el('div', { class: 'row', style: 'margin:12px 0' },
    el('a', { class: 'act', href: `/api/order/${id}/labels`, target: '_blank', style: 'text-decoration:none' }, 'Открыть для печати / PDF'),
    el('a', { class: 'ghost', href: `/api/order/${id}/codes.txt`, style: 'text-decoration:none' }, 'Скачать коды (.txt)'));
  const grid = el('div', { class: 'dm-grid', style: 'margin-top:8px' });
  o.codes.forEach((code, i) => {
    grid.append(el('figure', {},
      el('img', { src: '/api/dm.png?scale=5&text=' + encodeURIComponent(code) }),
      el('figcaption', {},
        el('div', {}, '#' + (i + 1)),
        el('div', { class: 'mono', style: 'font-size:9px;margin:4px 0;color:#222;word-break:break-all' }, codeVisible(code)),
        el('a', { href: `/api/dm.png?scale=8&download=km_${i + 1}.png&text=` + encodeURIComponent(code), style: 'font-size:11px;color:#1858c0' }, 'Скачать PNG'))));
  });
  box.append(bar, grid);
}
function addYears(dateStr, y) { const d = new Date(dateStr || Date.now()); d.setFullYear(d.getFullYear() + y); return d.toISOString().slice(0, 10); }
function showUtil(o) {
  const box = $('#util-' + o.id); box.innerHTML = '';
  const today = new Date().toISOString().slice(0, 10);
  const exp = o.expirationDays ? new Date(Date.now() + o.expirationDays * 864e5).toISOString().slice(0, 10) : addYears(today, 2);
  const setExp = y => { $('#ed-' + o.id).value = addYears($('#pd-' + o.id).value || today, y); };
  box.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('h2', {}, 'Отчёт о нанесении'),
    el('div', { class: 'row' },
      el('div', {}, el('label', {}, 'Дата производства'), el('input', { id: 'pd-' + o.id, type: 'date', value: today })),
      el('div', {}, el('label', {}, 'Срок годности до (дата)'), el('input', { id: 'ed-' + o.id, type: 'date', value: exp })),
      el('div', {}, el('label', {}, 'Быстро'),
        el('div', { class: 'row' },
          el('button', { class: 'ghost', onclick: () => setExp(1) }, '+1 год'),
          el('button', { class: 'ghost', onclick: () => setExp(2) }, '+2 года'),
          el('button', { class: 'ghost', onclick: () => setExp(3) }, '+3 года')))),
    el('div', { class: 'notice', style: 'margin-top:8px' }, 'Этот шаг переводит коды только в APPLIED («нанесён»). После него нужен отдельный документ «Ввод в оборот. Производство РФ» и статус INTRODUCED.'),
    el('div', { class: 'steps', id: 'us-' + o.id }),
    el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'act', onclick: () => doUtil(o) }, 'Отправить отчёт о нанесении')),
    el('div', { id: 'ur-' + o.id })));
}
async function doUtil(o) {
  const pd = $('#pd-' + o.id).value.trim(), ed = $('#ed-' + o.id).value.trim();
  if (!confirm(`Отправить отчёт о нанесении для ${o.quantity} КМ (дата пр-ва ${pd})? Это ещё не ввод в оборот.`)) return;
  const steps = $('#us-' + o.id); steps.innerHTML = '';
  const order = ['prepare', 'upload', 'sign', 'submit', 'verify', 'done'];
  order.forEach(s => steps.append(el('span', { id: 'us2-' + o.id + '-' + s }, STAGE_LABEL[s] || s)));
  const r = await runJob(`/api/order/${o.id}/utilisation`, { productionDate: pd, expirationDate: ed }, stage => {
    const e = $('#us2-' + o.id + '-' + stage); if (e) e.className = 'cur';
    order.slice(0, order.indexOf(stage)).forEach(s => { const x = $('#us2-' + o.id + '-' + s); if (x) x.className = 'done'; });
  });
  $('#ur-' + o.id).innerHTML = r.ok ? '<div class="notice" style="color:var(--ok)">Отчёт о нанесении принят: APPLIED. Для оборота ещё нужен LP_INTRODUCE_GOODS.</div>' : `<div class="notice" style="color:var(--err)">Отчёт о нанесении не подтверждён: ${r.error}</div>`;
  if (r.ok) setTimeout(renderOrders, 1500);
}

function showWithdraw(o) {
  const box = $('#util-' + o.id); box.innerHTML = '';
  const today = new Date().toISOString().slice(0, 10);
  box.append(el('div', { class: 'card', style: 'margin-top:12px' },
    el('h2', {}, 'Вывод из оборота — розничная продажа'),
    el('div', { class: 'notice', style: 'margin-bottom:10px' }, 'Укажи данные чека, по которому продан товар. Коды выйдут из оборота (статус «Выбыл»).'),
    el('div', { class: 'row' },
      el('div', {}, el('label', {}, 'Тип документа'), (() => { const s = el('select', { id: 'wo-type-' + o.id });[['RECEIPT', 'Кассовый чек'], ['SALES_RECEIPT', 'Товарный чек'], ['OTHER', 'Другое']].forEach(([v, t]) => s.append(el('option', { value: v }, t))); return s; })()),
      el('div', {}, el('label', {}, 'Номер чека'), el('input', { id: 'wo-num-' + o.id, value: '1' })),
      el('div', {}, el('label', {}, 'Дата'), el('input', { id: 'wo-date-' + o.id, type: 'date', value: today }))),
    el('div', { class: 'steps', id: 'wo-steps-' + o.id }),
    el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'act', onclick: () => doWithdrawOrder(o) }, 'Вывести из оборота')),
    el('div', { id: 'wo-res-' + o.id })));
}
async function doWithdrawOrder(o) {
  const documentType = $('#wo-type-' + o.id).value;
  const documentNumber = ($('#wo-num-' + o.id).value || '').trim() || '1';
  const documentDate = $('#wo-date-' + o.id).value.trim();
  if (!documentDate) return alert('Укажите дату документа');
  if (!confirm(`Вывести из оборота ${o.codes.length} КМ «${o.name}»?\nЧек ${documentType} №${documentNumber} от ${documentDate}`)) return;
  const steps = $('#wo-steps-' + o.id); steps.innerHTML = '';
  const order = ['prepare', 'upload', 'sign', 'submit', 'done'];
  order.forEach(s => steps.append(el('span', { id: 'wox-' + o.id + '-' + s }, STAGE_LABEL[s] || s)));
  const r = await runJob('/api/withdraw', { cises: o.codes, documentNumber, documentDate, actionDate: documentDate, documentType }, stage => {
    const e = $('#wox-' + o.id + '-' + stage); if (e) e.className = 'cur';
    order.slice(0, order.indexOf(stage)).forEach(s => { const x = $('#wox-' + o.id + '-' + s); if (x) x.className = 'done'; });
  });
  if (r.ok) { alert('Выведено из оборота.\nДокумент: ' + (r.docId || '')); renderOrders(); }
  else { $('#wo-res-' + o.id).innerHTML = `<div class="notice" style="color:var(--err)">Ошибка: ${r.error || JSON.stringify(r)}</div>`; }
}

let PREFILL_WITHDRAW = '';
const TA = 'width:100%;min-height:110px;background:#0d1218;border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:8px';

function renderDropout() {
  const c = $('#tab-dropout'); c.innerHTML = '';
  const today = new Date().toISOString().slice(0, 10);
  // --- Розничная продажа (True API LK_RECEIPT) ---
  c.append(el('div', { class: 'card' },
    el('h2', {}, 'Вывод из оборота — розничная продажа'),
    el('div', { class: 'notice', style: 'margin-bottom:10px' }, 'Документ «Вывод из оборота» (LK_RECEIPT, причина RETAIL) через True API. Коды выйдут из оборота со статусом «Выбыл». Для розницы обязательны тип, номер и дата документа продажи (чека).'),
    el('label', {}, 'Коды КМ (по одному в строке, полный код с криптохвостом)'),
    el('textarea', { id: 'wCodes', class: 'mono', style: TA }, PREFILL_WITHDRAW),
    el('div', { class: 'row', style: 'margin-top:10px' },
      el('div', {}, el('label', {}, 'Тип документа'), (() => { const s = el('select', { id: 'wDocType' });[['RECEIPT', 'Кассовый чек'], ['SALES_RECEIPT', 'Товарный чек'], ['OTHER', 'Другое']].forEach(([v, t]) => s.append(el('option', { value: v }, t))); return s; })()),
      el('div', {}, el('label', {}, 'Номер документа/чека'), el('input', { id: 'wDocNum', value: '' })),
      el('div', {}, el('label', {}, 'Дата документа'), el('input', { id: 'wDocDate', type: 'date', value: today })),
      el('div', {}, el('label', {}, 'Дата вывода'), el('input', { id: 'wActDate', type: 'date', value: today }))),
    el('div', { class: 'steps', id: 'wSteps' }),
    el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'act', onclick: doWithdraw }, 'Вывести из оборота (продажа)')),
    el('div', { id: 'wRes' })));
  PREFILL_WITHDRAW = '';
  // --- Списание (СУЗ dropout) ---
  c.append(el('div', { class: 'card' },
    el('h2', {}, 'Списание (брак / утеря / уничтожение / срок)'),
    el('div', { class: 'notice', style: 'margin-bottom:10px' }, 'Это НЕ продажа. Отчёт о выбытии по причине через СУЗ (dropout) — для брака, утери, уничтожения, истёкшего срока.'),
    el('div', { class: 'row' },
      el('div', {}, el('label', {}, 'Причина'), (() => { const s = el('select', { id: 'dropReason' });['DEFECT', 'EXPIRATION', 'LOSS', 'DESTRUCTION'].forEach(x => s.append(el('option', { value: x }, x))); return s; })())),
    el('div', { style: 'margin-top:10px' }, el('label', {}, 'Коды КМ (по одному в строке)'), el('textarea', { id: 'dropCodes', class: 'mono', style: TA })),
    el('div', { class: 'steps', id: 'dropSteps' }),
    el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'act', onclick: doDropout }, 'Списать')),
    el('div', { id: 'dropRes' })));
}
async function doWithdraw() {
  const cises = $('#wCodes').value.split('\n').map(s => s.trim()).filter(Boolean);
  const documentNumber = $('#wDocNum').value.trim(), documentDate = $('#wDocDate').value.trim(), actionDate = $('#wActDate').value.trim(), documentType = $('#wDocType').value;
  if (!cises.length) return alert('Вставьте коды');
  if (!documentNumber || !documentDate) return alert('Укажите номер и дату документа продажи');
  if (!confirm(`Вывести из оборота (розничная продажа) ${cises.length} КМ?\nДокумент: ${documentType} №${documentNumber} от ${documentDate}`)) return;
  const steps = $('#wSteps'); steps.innerHTML = '';
  const order = ['prepare', 'upload', 'sign', 'submit', 'done'];
  order.forEach(s => steps.append(el('span', { id: 'ws-' + s }, STAGE_LABEL[s] || s)));
  const r = await runJob('/api/withdraw', { cises, documentNumber, documentDate, actionDate, documentType }, stage => {
    const e = $('#ws-' + stage); if (e) e.className = 'cur';
    order.slice(0, order.indexOf(stage)).forEach(s => { const x = $('#ws-' + s); if (x) x.className = 'done'; });
  });
  $('#wRes').innerHTML = r.ok ? `<div class="notice" style="color:var(--ok)">Документ вывода из оборота отправлен. ID: <span class="mono">${r.docId || '—'}</span> (обрабатывается асинхронно, результат — в квитанции ЧЗ).</div>` : `<div class="notice" style="color:var(--err)">Ошибка (${r.stage || ''}): ${r.error}</div>`;
}
async function doDropout() {
  const codes = $('#dropCodes').value.split('\n').map(s => s.trim()).filter(Boolean);
  const reason = $('#dropReason').value;
  if (!codes.length) return alert('Вставьте коды');
  if (!confirm(`Списать (вывести из оборота) ${codes.length} КМ по причине ${reason}?`)) return;
  const steps = $('#dropSteps'); steps.innerHTML = '';
  const order = ['prepare', 'upload', 'sign', 'submit', 'done'];
  order.forEach(s => steps.append(el('span', { id: 'ds-' + s }, STAGE_LABEL[s] || s)));
  const r = await runJob('/api/dropout', { sntins: codes, dropoutReason: reason }, stage => {
    const e = $('#ds-' + stage); if (e) e.className = 'cur';
    order.slice(0, order.indexOf(stage)).forEach(s => { const x = $('#ds-' + s); if (x) x.className = 'done'; });
  });
  $('#dropRes').innerHTML = r.ok ? '<div class="notice" style="color:var(--ok)">Отчёт о выводе из оборота отправлен.</div>' : `<div class="notice" style="color:var(--err)">Ошибка: ${r.error}</div>`;
}

async function renderMoney() {
  const ops = await api('GET', '/api/operations');
  const c = $('#tab-money'); c.innerHTML = '';
  const rows = (ST.balance && ST.balance.balances || []);
  c.append(el('div', { class: 'card' },
    el('div', { class: 'row' }, el('h2', { style: 'margin:0' }, 'Баланс лицевого счёта (из Честного Знака)'),
      el('button', { class: 'ghost', style: 'margin-left:auto', onclick: async ev => { ev.target.disabled = true; ev.target.textContent = 'обновляю…'; await loadBalance(); renderMoney(); } }, 'Обновить баланс из ЧЗ')),
    el('div', { style: 'height:10px' }),
    el('div', { class: 'kpi' },
      ...rows.map(b => el('div', {}, el('div', { class: 'mut' }, b.name), el('div', { class: 'big' }, rub(b.balanceKop)),
        el('div', { class: 'mut', style: 'font-size:11px' }, 'договор ' + (b.contractId || '—')))),
      el('div', {}, el('div', { class: 'mut' }, 'Итого на счёте'), el('div', { class: 'big' }, rub(balanceTotalKop()))),
      el('div', {}, el('div', { class: 'mut' }, 'Потрачено на КМ (учёт приложения)'), el('div', { class: 'big' }, rub(ST.spentTotalKop)))),
    el('div', { class: 'notice', style: 'margin-top:10px' }, 'Баланс берётся напрямую из ЧЗ (elk/product-groups/balance/all), в рублях. Для БАД используется группа «БАД (bio)».')));
  const tbl = el('table', {}, el('tr', {}, el('th', {}, 'Дата'), el('th', {}, 'Операция'), el('th', {}, 'GTIN'), el('th', {}, 'Кол-во'), el('th', {}, 'Расход')));
  ops.forEach(o => tbl.append(el('tr', {}, el('td', {}, new Date(o.ts).toLocaleString('ru-RU')), el('td', {}, o.note || o.type), el('td', { class: 'mono' }, o.gtin), el('td', {}, o.quantity), el('td', {}, o.spendKop ? rub(o.spendKop) : '—'))));
  c.append(el('div', { class: 'card' }, el('h2', {}, 'История операций'), tbl));
}

initNav();
show('status');
