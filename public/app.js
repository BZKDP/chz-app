'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const money = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' });
const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTimeFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const state = {
  products: [], orders: [], bulkBatches: [], system: null, readiness: null,
  submitting: false, bulkSubmitting: false, lastOrderSync: null, draft: false,
  bulkDraft: false, bulkItems: {}, bulkClientRequestId: null, catalogSource: null, catalogSyncedAt: null,
  productMenuOpen: false, productActiveIndex: 0, systemError: null, systemCheckedAt: null,
  ordersLoading: false, systemLoading: false, bulkLoading: false, detailsOrderId: null,
  datePeriod: 'today', dateFrom: '', dateTo: '', signatureSubmitting: false
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function friendlyError(message) {
  const text = String(message || 'Неизвестная ошибка');
  if (/Connection closed|Connection reset|Broken pipe|scp:.*closed|port 22/i.test(text)) return 'Компьютер электронной подписи временно оборвал связь. Система повторит обработку автоматически.';
  if (/Connection timed out|Connection refused|No route to host/i.test(text)) return 'Нет связи с компьютером электронной подписи. Проверьте, что он включён и подключён к сети.';
  return text;
}

async function request(method, url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
  const response = await fetch(url, {
    method,
    signal: controller.signal, credentials: 'same-origin', cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  if (response.status === 401 || (response.redirected && new URL(response.url).pathname === '/login')) {
    throw new Error('Сессия закончилась. Обновите страницу и войдите снова.');
  }
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Сайт вернул неожиданный ответ. Повторяем проверку соединения.');
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { error: raw }; }
  if (!response.ok) throw new Error(friendlyError(data.error || `Ошибка HTTP ${response.status}`));
  return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Сайт не ответил за 20 секунд. Проверка повторится автоматически.');
    if (error instanceof TypeError) throw new Error('Нет связи с сайтом. Проверьте интернет; данные на экране могут устареть.');
    throw error;
  } finally { clearTimeout(timer); }
}

function runJob(url, body, onProgress) {
  return new Promise(async (resolve, reject) => {
    try {
      const started = await request('POST', url, body);
      if (!started.jobId) throw new Error(started.error || 'Сервер не создал задание');
      const stream = new EventSource(`/api/jobs/${encodeURIComponent(started.jobId)}/events`);
      const timeout = setTimeout(() => {
        stream.close();
        reject(new Error('Операция продолжается дольше обычного. Проверьте её на странице «Обзор» через несколько минут.'));
      }, 240000);
      stream.addEventListener('progress', event => {
        try { onProgress?.(JSON.parse(event.data).stage || 'Обрабатываем запрос…'); } catch (_) {}
      });
      stream.addEventListener('result', event => {
        clearTimeout(timeout);
        stream.close();
        let result;
        try { result = JSON.parse(event.data); } catch (_) { result = { ok: false, error: 'Сервер вернул некорректный ответ' }; }
        if (result.ok === false) reject(new Error(friendlyError(result.error || 'Операция не выполнена')));
        else resolve(result);
      });
      stream.addEventListener('error', () => {
        clearTimeout(timeout);
        stream.close();
        reject(new Error('Связь прервалась после отправки. Проверьте «Все партии». Повтор этой же формы использует прежний номер запроса.'));
      });
    } catch (error) { reject(error); }
  });
}

function showToast(message, error = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.className = 'toast'; }, 5000);
}

function cleanName(value) {
  return String(value || '')
    .replace(/биологически активная добавка к пище/ig, '')
    .replace(/[«»"]/g, '')
    .replace(/^\s*[—:.-]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim() || 'Товар без названия';
}

function registeredName(product) { return String(product?.registeredName || product?.name || product?.gtin || 'Товар без названия'); }

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime()) ? '—' : dateFormat.format(date);
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateTimeFormat.format(date);
}

function currentView() {
  const view = new URL(location.href).searchParams.get('view');
  return ['dashboard', 'new', 'bulk', 'history', 'system'].includes(view) ? view : 'dashboard';
}

function hasDraft() {
  if (currentView() === 'bulk') return state.bulkDraft;
  return state.draft && Boolean($('#productSelect').value || $('#productionDate').value || $('#expirationDate').value || Number($('#quantity').value) !== 1);
}

function navigate(view, { replace = false, force = false } = {}) {
  if (!force && ['new', 'bulk'].includes(currentView()) && view !== currentView() && hasDraft() && !window.confirm('Данные выпуска не сохранены. Перейти в другой раздел?')) return;
  const url = new URL(location.href);
  url.searchParams.set('view', view);
  if (view !== 'history') { url.searchParams.delete('status'); url.searchParams.delete('q'); }
  history[replace ? 'replaceState' : 'pushState']({}, '', url);
  renderRoute();
}

function renderRoute() {
  syncDateFilterFromUrl();
  const view = currentView();
  state.productMenuOpen = false;
  $$('.page').forEach(page => { page.hidden = page.id !== `page-${view}`; });
  $$('[data-route]').forEach(link => link.classList.toggle('active', link.dataset.route === view));
  $('#mobileNav').hidden = true;
  $('#menuButton').setAttribute('aria-expanded', 'false');
  if (view === 'history') syncHistoryControlsFromUrl();
  if (view === 'bulk') renderBulkProducts();
  renderProducts();
  $('#main').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

function selectedProduct() { return state.products.find(product => product.gtin === $('#productSelect').value); }

function productInputLabel(product) { return cleanName(registeredName(product)); }

function visibleProducts() {
  const selected = selectedProduct();
  const rawQuery = $('#productSearch').value.trim();
  const query = selected && rawQuery === productInputLabel(selected) ? '' : rawQuery.toLocaleLowerCase('ru-RU');
  return state.products
    .filter(product => !product.bulkExcluded && !product.isSet && !product.isKit && (!product.productGroup || product.productGroup === 'bio'))
    .filter(product => !query || `${registeredName(product)} ${product.gtin} ${product.stateRegistrationCertificate || ''} ${product.brand || ''}`.toLocaleLowerCase('ru-RU').includes(query))
    .sort((a, b) => cleanName(registeredName(a)).localeCompare(cleanName(registeredName(b)), 'ru'));
}

function renderProducts() {
  const selected = selectedProduct();
  const products = visibleProducts();
  state.productActiveIndex = Math.max(0, Math.min(state.productActiveIndex, Math.max(0, products.length - 1)));
  const options = $('#productOptions');
  options.innerHTML = products.length ? products.map((product, index) => {
    const isSelected = selected?.gtin === product.gtin;
    const isActive = state.productMenuOpen && index === state.productActiveIndex;
    return `<button class="product-option${isActive ? ' active' : ''}" id="product-option-${escapeHtml(product.gtin)}" type="button" role="option" aria-selected="${isSelected}" tabindex="-1" data-product-gtin="${escapeHtml(product.gtin)}">
      <span class="product-option-main"><strong>${escapeHtml(productInputLabel(product))}</strong><small>${escapeHtml(registeredName(product))}</small></span>
      <span class="product-option-meta"><b>${product.stateRegistrationCertificate ? `СГР ${escapeHtml(product.stateRegistrationCertificate)}` : 'СГР не указан'}</b><small translate="no">GTIN ${escapeHtml(product.gtin)}</small></span>
    </button>`;
  }).join('') : '<div class="product-options-empty"><strong>Ничего не найдено</strong><span>Попробуйте название, СГР или GTIN.</span></div>';
  options.hidden = !state.productMenuOpen;
  const activeProduct = products[state.productActiveIndex];
  if (state.productMenuOpen && activeProduct) $('#productSearch').setAttribute('aria-activedescendant', `product-option-${activeProduct.gtin}`);
  else $('#productSearch').removeAttribute('aria-activedescendant');
  $('#productSearch').setAttribute('aria-expanded', String(state.productMenuOpen));
  $('#productComboboxButton').setAttribute('aria-expanded', String(state.productMenuOpen));
  $('#productCombobox').classList.toggle('open', state.productMenuOpen);
  renderSelectedProductCard();
  updateOrderSummary();
}

function openProductMenu({ showAll = false } = {}) {
  if (showAll && selectedProduct()) $('#productSearch').value = productInputLabel(selectedProduct());
  state.productMenuOpen = true;
  const products = visibleProducts();
  const selectedIndex = products.findIndex(product => product.gtin === selectedProduct()?.gtin);
  state.productActiveIndex = selectedIndex >= 0 ? selectedIndex : 0;
  renderProducts();
}

function closeProductMenu() {
  if (!state.productMenuOpen) return;
  state.productMenuOpen = false;
  renderProducts();
}

function selectComboboxProduct(gtin) {
  const product = state.products.find(item => item.gtin === gtin);
  if (!product) return;
  $('#productSelect').value = product.gtin;
  $('#productSearch').value = productInputLabel(product);
  state.productMenuOpen = false;
  state.productActiveIndex = 0;
  state.draft = true;
  renderProducts();
  checkReadiness();
}

function moveProductHighlight(direction) {
  const products = visibleProducts();
  if (!products.length) return;
  if (!state.productMenuOpen) {
    state.productMenuOpen = true;
    state.productActiveIndex = direction > 0 ? 0 : products.length - 1;
  } else {
    state.productActiveIndex = (state.productActiveIndex + direction + products.length) % products.length;
  }
  renderProducts();
  document.getElementById(`product-option-${products[state.productActiveIndex].gtin}`)?.scrollIntoView({ block: 'nearest' });
}

function handleProductSearch() {
  const product = selectedProduct();
  if (product && $('#productSearch').value !== productInputLabel(product)) {
    $('#productSelect').value = '';
    state.readiness = null;
    renderSelectedProductCard();
    updateOrderSummary();
    const message = $('#readinessMessage');
    message.className = 'field-message neutral';
    message.textContent = 'Выберите товар из найденных карточек.';
  }
  state.productMenuOpen = true;
  state.productActiveIndex = 0;
  state.draft = true;
  renderProducts();
}

function renderSelectedProductCard() {
  const card = $('#selectedProductCard');
  const product = selectedProduct();
  if (!product) { card.hidden = true; card.innerHTML = ''; return; }
  card.hidden = false;
  card.innerHTML = `<span>Название зарегистрировано в Честном ЗНАКе</span><strong>${escapeHtml(registeredName(product))}</strong><small><span translate="no">GTIN ${escapeHtml(product.gtin)}</span>${product.stateRegistrationCertificate ? ` · СГР ${escapeHtml(product.stateRegistrationCertificate)}` : ''}${product.packageType ? ` · ${escapeHtml(product.packageType)}` : ''}</small>`;
}

async function loadProducts() {
  try {
    const result = await request('GET', '/api/catalog');
    state.products = Array.isArray(result.products) ? result.products : [];
    state.catalogSource = result.source || 'Честный ЗНАК';
    state.catalogSyncedAt = result.syncedAt || null;
    initializeBulkItems();
    renderProducts();
    renderBulkProducts();
    renderCatalogSource(result.ok, result.error);
  } catch (error) {
    $('#productOptions').innerHTML = '<div class="product-options-empty"><strong>Каталог недоступен</strong><span>Проверьте соединение и обновите страницу.</span></div>';
    renderCatalogSource(false, error.message);
    showToast(error.message, true);
  }
}

async function checkReadiness() {
  const product = selectedProduct();
  const checkedGtin = product?.gtin;
  const message = $('#readinessMessage');
  state.readiness = null;
  updateOrderSummary();
  if (!product) {
    message.className = 'field-message neutral';
    message.textContent = 'Выберите товар — система проверит его готовность.';
    return;
  }
  renderSelectedProductCard();
  message.className = 'field-message neutral';
  message.textContent = 'Проверяем карточку в Национальном каталоге…';
  try {
    const result = await request('GET', `/api/products/${encodeURIComponent(product.gtin)}/readiness`);
    if (selectedProduct()?.gtin !== checkedGtin) return;
    state.readiness = result;
    if (result.signed && result.markReady && result.turnReady) {
      message.className = 'field-message success';
      message.textContent = 'Карточка готова к заказу и вводу в оборот.';
    } else {
      message.className = 'field-message error';
      message.textContent = 'Карточка не готова к вводу в оборот. Исправьте её в Национальном каталоге.';
    }
  } catch (error) {
    message.className = 'field-message error';
    message.textContent = `Проверка не выполнена. ${error.message}`;
  }
}

function updateOrderSummary() {
  const product = selectedProduct();
  const quantity = Math.max(1, Math.min(5000, Math.round(Number($('#quantity').value) || 1)));
  const grossKop = Number(state.system?.tariff?.grossKop || 0);
  $('#summaryProduct').textContent = product ? cleanName(registeredName(product)) : 'Не выбран';
  $('#summaryQuantity').textContent = `${quantity} шт.`;
  $('#summaryLabels').textContent = `${quantity} шт.`;
  $('#summaryCost').textContent = grossKop ? money.format(quantity * grossKop / 100) : 'Уточняется';
}

function addYears(value, years) {
  if (!value) return '';
  const date = new Date(`${value}T12:00:00`);
  date.setFullYear(date.getFullYear() + years);
  return date.toLocaleDateString('sv-SE');
}

function formValues() {
  const product = selectedProduct();
  const quantity = Number($('#quantity').value);
  const productionDate = $('#productionDate').value;
  const expirationDate = $('#expirationDate').value;
  const today = new Date().toLocaleDateString('sv-SE');
  if (!product) return { error: 'Выберите товар.', field: $('#productSearch') };
  if (!state.readiness?.signed || !state.readiness?.markReady || !state.readiness?.turnReady) return { error: 'Карточка товара не готова к заказу.', field: $('#productSearch') };
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 5000) return { error: 'Укажите количество от 1 до 5000.', field: $('#quantity') };
  if (!productionDate) return { error: 'Укажите дату производства.', field: $('#productionDate') };
  if (!expirationDate) return { error: 'Укажите срок годности.', field: $('#expirationDate') };
  if (productionDate > today) return { error: 'Дата производства не может быть в будущем.', field: $('#productionDate') };
  if (expirationDate < productionDate) return { error: 'Срок годности должен быть позже даты производства.', field: $('#expirationDate') };
  return { product, quantity, productionDate, expirationDate };
}

function showFormError(result) {
  const box = $('#formError');
  box.hidden = false;
  box.textContent = result.error;
  result.field?.focus();
}

function openConfirmation() {
  const values = formValues();
  if (values.error) return showFormError(values);
  $('#formError').hidden = true;
  const grossKop = Number(state.system?.tariff?.grossKop || 0);
  const rows = [
    ['Товар', registeredName(values.product)], ['GTIN', values.product.gtin], ['Количество', `${values.quantity} шт.`],
    ['Произведено', formatDate(values.productionDate)], ['Годен до', formatDate(values.expirationDate)],
    ['Стоимость', grossKop ? money.format(values.quantity * grossKop / 100) : 'По действующему тарифу']
  ];
  $('#confirmSummary').innerHTML = rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
  $('#confirmDialog').showModal();
}

async function createOrder() {
  const values = formValues();
  if (values.error || state.submitting) return;
  state.submitting = true;
  const button = $('#confirmButton');
  button.disabled = true;
  button.textContent = 'Создаём заказ…';
  try {
    const fingerprint = JSON.stringify([values.product.gtin, values.quantity, values.productionDate, values.expirationDate]);
    let savedIntent;
    try { savedIntent = JSON.parse(sessionStorage.getItem('chzSingleIntent') || 'null'); } catch (_) {}
    const clientRequestId = savedIntent?.fingerprint === fingerprint ? savedIntent.id : `employee:${crypto.randomUUID()}`;
    sessionStorage.setItem('chzSingleIntent', JSON.stringify({ id: clientRequestId, fingerprint }));
    const result = await runJob('/api/order', {
      gtin: values.product.gtin,
      name: registeredName(values.product),
      quantity: values.quantity,
      productionDate: values.productionDate,
      expirationDate: values.expirationDate,
      templateId: 30,
      releaseMethodType: 'PRODUCTION',
      paymentType: 1,
      cisType: 'UNIT',
      automationMode: 'FULL',
      createdBy: 'Рабочее место офиса',
      clientRequestId
    }, stage => { button.textContent = stage === 'submit' ? 'Отправляем заказ…' : 'Подписываем…'; });
    sessionStorage.removeItem('chzSingleIntent');
    $('#confirmDialog').close();
    state.draft = false;
    $('#newOrderForm').reset();
    $('#quantity').value = '1';
    state.readiness = null;
    renderProducts();
    updateOrderSummary();
    showToast('Партия создана. Дальше система обработает её автоматически.');
    await loadOrders();
    navigate('dashboard', { force: true });
    if (result.orderId) setTimeout(() => document.getElementById(`order-${CSS.escape(result.orderId)}`)?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }), 100);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.submitting = false;
    button.disabled = false;
    button.textContent = 'Заказать коды';
  }
}

function bulkEligible(product) {
  return !product.bulkExcluded && !product.isSet && !product.isKit && (!product.productGroup || product.productGroup === 'bio') && product.signed === true && product.markReady === true && product.turnReady === true;
}

function initializeBulkItems() {
  const next = {};
  for (const product of state.products.filter(item => !item.productGroup || item.productGroup === 'bio')) {
    const previous = state.bulkItems[product.gtin];
    next[product.gtin] = previous || {
      selected: bulkEligible(product),
      quantity: 1,
      productionDate: '',
      expirationDate: ''
    };
    if (!bulkEligible(product)) next[product.gtin].selected = false;
  }
  state.bulkItems = next;
}

function renderCatalogSource(ok = true, error = null) {
  const target = $('#catalogSource');
  if (!target) return;
  if (ok) {
    const time = state.catalogSyncedAt ? formatDateTime(state.catalogSyncedAt) : 'только что';
    target.textContent = `Официальные названия и статусы получены из Честного ЗНАКа · ${time}`;
  } else {
    target.textContent = `Каталог не обновлён: ${friendlyError(error)}. Платный запуск будет заблокирован до успешной проверки.`;
  }
}

function visibleBulkProducts() {
  const query = $('#bulkProductSearch')?.value.trim().toLocaleLowerCase('ru-RU') || '';
  return state.products
    .filter(product => !product.productGroup || product.productGroup === 'bio')
    .filter(product => !query || `${registeredName(product)} ${product.gtin} ${product.brand || ''}`.toLocaleLowerCase('ru-RU').includes(query))
    .sort((a, b) => cleanName(registeredName(a)).localeCompare(cleanName(registeredName(b)), 'ru'));
}

function readinessLabel(product) {
  if (product.bulkExcluded) return { label: 'Исключён', tone: 'danger', note: product.bulkExcludedReason || 'Карточка отключена после контрольного выпуска' };
  if (product.isSet || product.isKit) return { label: 'Набор — отдельно', tone: 'neutral', note: 'Не входит в массовый выпуск единиц' };
  if (bulkEligible(product)) return { label: 'Готов', tone: 'success', note: 'Можно заказать и ввести в оборот' };
  return { label: 'Не готов', tone: 'danger', note: 'Проверьте карточку в Национальном каталоге' };
}

function renderBulkProducts() {
  const body = $('#bulkProductRows');
  if (!body) return;
  const products = visibleBulkProducts();
  body.innerHTML = products.map(product => {
    const draft = state.bulkItems[product.gtin] || { selected: false, quantity: 1, productionDate: '', expirationDate: '' };
    const ready = readinessLabel(product);
    const disabled = !bulkEligible(product);
    const inputDisabled = disabled || !draft.selected;
    const suffix = product.gtin.slice(-4);
    return `<tr class="${draft.selected ? 'selected' : ''}${disabled ? ' unavailable' : ''}" data-bulk-row="${escapeHtml(product.gtin)}">
      <td data-label="Выбор" class="check-column"><label class="check-hit" for="bulk-check-${escapeHtml(product.gtin)}"><span class="visually-hidden">Выбрать ${escapeHtml(cleanName(registeredName(product)))}</span><input id="bulk-check-${escapeHtml(product.gtin)}" type="checkbox" data-bulk-field="selected" data-gtin="${escapeHtml(product.gtin)}" ${draft.selected ? 'checked' : ''} ${disabled ? 'disabled' : ''}></label></td>
      <td data-label="Товар"><div class="catalog-product"><strong>${escapeHtml(cleanName(registeredName(product)))}</strong><span class="official-name">${escapeHtml(registeredName(product))}</span><small translate="no">${product.stateRegistrationCertificate ? `СГР ${escapeHtml(product.stateRegistrationCertificate)} · ` : ''}GTIN ${escapeHtml(product.gtin)} · …${escapeHtml(suffix)}</small></div></td>
      <td data-label="Готовность"><span class="catalog-status ${escapeHtml(ready.tone)}"><i aria-hidden="true"></i>${escapeHtml(ready.label)}</span><small class="status-note">${escapeHtml(ready.note)}</small></td>
      <td data-label="Кодов"><label class="visually-hidden" for="bulk-qty-${escapeHtml(product.gtin)}">Количество кодов для ${escapeHtml(cleanName(registeredName(product)))}</label><input class="compact-input" id="bulk-qty-${escapeHtml(product.gtin)}" type="number" min="1" max="5000" step="1" inputmode="numeric" autocomplete="off" data-bulk-field="quantity" data-gtin="${escapeHtml(product.gtin)}" value="${escapeHtml(draft.quantity)}" ${inputDisabled ? 'disabled' : ''}></td>
      <td data-label="Произведено"><label class="visually-hidden" for="bulk-prod-${escapeHtml(product.gtin)}">Дата производства ${escapeHtml(cleanName(registeredName(product)))}</label><input class="compact-input date" id="bulk-prod-${escapeHtml(product.gtin)}" type="date" autocomplete="off" data-bulk-field="productionDate" data-gtin="${escapeHtml(product.gtin)}" value="${escapeHtml(draft.productionDate)}" ${inputDisabled ? 'disabled' : ''}></td>
      <td data-label="Годен до"><label class="visually-hidden" for="bulk-exp-${escapeHtml(product.gtin)}">Срок годности ${escapeHtml(cleanName(registeredName(product)))}</label><input class="compact-input date" id="bulk-exp-${escapeHtml(product.gtin)}" type="date" autocomplete="off" data-bulk-field="expirationDate" data-gtin="${escapeHtml(product.gtin)}" value="${escapeHtml(draft.expirationDate)}" ${inputDisabled ? 'disabled' : ''}></td>
    </tr>`;
  }).join('');
  $('#bulkCatalogEmpty').hidden = products.length > 0;
  $('.bulk-table-wrap').hidden = products.length === 0;
  const today = new Date().toLocaleDateString('sv-SE');
  $$('input[type="date"][data-bulk-field="productionDate"]', body).forEach(input => { input.max = today; });
  updateBulkSummary();
}

function selectedBulkItems() {
  return state.products
    .filter(product => state.bulkItems[product.gtin]?.selected && bulkEligible(product))
    .map(product => ({ product, ...state.bulkItems[product.gtin] }));
}

function updateBulkSummary() {
  const items = selectedBulkItems();
  const codes = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const grossKop = Number(state.system?.tariff?.grossKop || 0);
  $('#bulkSelectedCount').textContent = items.length;
  $('#bulkCodeCount').textContent = codes;
  $('#bulkCost').textContent = grossKop ? money.format(codes * grossKop / 100) : 'Уточняется';
}

function applyBulkDates() {
  const productionDate = $('#bulkProductionDate').value;
  const expirationDate = $('#bulkExpirationDate').value;
  if (!productionDate || !expirationDate) {
    const field = !productionDate ? $('#bulkProductionDate') : $('#bulkExpirationDate');
    showBulkError('Укажите обе общие даты, затем примените их к товарам.', field);
    return;
  }
  for (const item of selectedBulkItems()) {
    item.productionDate = productionDate;
    item.expirationDate = expirationDate;
    state.bulkItems[item.product.gtin].productionDate = productionDate;
    state.bulkItems[item.product.gtin].expirationDate = expirationDate;
  }
  state.bulkDraft = true;
  $('#bulkFormError').hidden = true;
  renderBulkProducts();
  showToast('Даты применены ко всем выбранным товарам.');
}

function showBulkError(message, field = null) {
  const box = $('#bulkFormError');
  box.hidden = false;
  box.textContent = message;
  field?.focus();
  box.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

function bulkValues() {
  const items = selectedBulkItems();
  const today = new Date().toLocaleDateString('sv-SE');
  if (!items.length) return { error: 'Выберите хотя бы один готовый товар.', field: $('#selectAllReadyButton') };
  for (const item of items) {
    if (!Number.isInteger(Number(item.quantity)) || Number(item.quantity) < 1 || Number(item.quantity) > 5000) return { error: `Проверьте количество для «${cleanName(registeredName(item.product))}».`, field: $(`#bulk-qty-${item.product.gtin}`) };
    if (!item.productionDate) return { error: `Укажите дату производства для «${cleanName(registeredName(item.product))}».`, field: $(`#bulk-prod-${item.product.gtin}`) };
    if (!item.expirationDate) return { error: `Укажите срок годности для «${cleanName(registeredName(item.product))}».`, field: $(`#bulk-exp-${item.product.gtin}`) };
    if (item.productionDate > today) return { error: `Дата производства «${cleanName(registeredName(item.product))}» не может быть в будущем.`, field: $(`#bulk-prod-${item.product.gtin}`) };
    if (item.expirationDate < item.productionDate) return { error: `Срок годности «${cleanName(registeredName(item.product))}» раньше даты производства.`, field: $(`#bulk-exp-${item.product.gtin}`) };
  }
  return { items };
}

function openBulkConfirmation() {
  const values = bulkValues();
  if (values.error) return showBulkError(values.error, values.field);
  $('#bulkFormError').hidden = true;
  const totalCodes = values.items.reduce((sum, item) => sum + Number(item.quantity), 0);
  const grossKop = Number(state.system?.tariff?.grossKop || 0);
  $('#bulkConfirmSummary').innerHTML = `<div><span>Товаров</span><strong>${values.items.length}</strong></div><div><span>Кодов</span><strong>${totalCodes}</strong></div><div><span>Стоимость</span><strong>${escapeHtml(grossKop ? money.format(totalCodes * grossKop / 100) : 'По действующему тарифу')}</strong></div>`;
  $('#bulkConfirmList').innerHTML = values.items.map(item => `<article><div><strong>${escapeHtml(cleanName(registeredName(item.product)))}</strong><small translate="no">GTIN ${escapeHtml(item.product.gtin)}</small></div><div><strong>${escapeHtml(item.quantity)} код</strong><small>${escapeHtml(formatDate(item.productionDate))} — ${escapeHtml(formatDate(item.expirationDate))}</small></div></article>`).join('');
  state.bulkClientRequestId = state.bulkClientRequestId || sessionStorage.getItem('chzBulkClientRequestId') || `employee-bulk:${crypto.randomUUID()}`;
  sessionStorage.setItem('chzBulkClientRequestId', state.bulkClientRequestId);
  $('#bulkConfirmDialog').showModal();
}

async function createBulkBatch() {
  const values = bulkValues();
  if (values.error || state.bulkSubmitting) return;
  state.bulkSubmitting = true;
  const button = $('#confirmBulkButton');
  button.disabled = true;
  button.textContent = 'Проверяем систему…';
  try {
    const result = await request('POST', '/api/bulk-batches', {
      createdBy: 'Рабочее место офиса',
      clientRequestId: state.bulkClientRequestId,
      items: values.items.map(item => ({
        gtin: item.product.gtin,
        quantity: Number(item.quantity),
        productionDate: item.productionDate,
        expirationDate: item.expirationDate
      }))
    });
    $('#bulkConfirmDialog').close();
    state.bulkDraft = false;
    state.bulkClientRequestId = null;
    sessionStorage.removeItem('chzBulkClientRequestId');
    showToast(`Массовый выпуск создан: ${result.batch.itemCount} товаров. Очередь работает автоматически.`);
    await Promise.all([loadOrders(), loadBulkBatches()]);
    navigate('dashboard', { force: true });
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.bulkSubmitting = false;
    button.disabled = false;
    button.textContent = 'Заказать все коды';
  }
}

function renderBulkBatches() {
  const target = $('#bulkBatchList');
  if (!target) return;
  const rows = state.bulkBatches.filter(batch => matchesIssueDate(batch));
  target.innerHTML = rows.length ? rows.map(batch => {
    const status = batch.publicStatus || { label: batch.state, tone: 'neutral' };
    const progress = batch.itemCount ? Math.round(((batch.readyCount || batch.issuedCount || 0) / batch.itemCount) * 100) : 0;
    return `<article class="bulk-batch-row"><div><strong>Массовый выпуск · ${escapeHtml(formatDateTime(batch.createdAt))}</strong><small>${escapeHtml(batch.itemCount)} товаров · ${escapeHtml(batch.totalQuantity)} кодов · ${escapeHtml(money.format(Number(batch.totalCostKop || 0) / 100))}</small></div><div class="batch-progress"><span class="table-status">${statusHtml(status)}</span><small>${escapeHtml(batch.readyCount)} готовы · ${escapeHtml(batch.issuedCount)} заказаны</small><div class="progress-track"><span style="width:${progress}%"></span></div></div></article>`;
  }).join('') : '<div class="empty"><strong>За выбранные даты массовых выпусков нет</strong><p>Выберите другой период или создайте новый выпуск.</p></div>';
}

async function loadBulkBatches({ quiet = false } = {}) {
  if (state.bulkLoading) return;
  state.bulkLoading = true;
  try {
    const batches = await request('GET', '/api/bulk-batches/summary');
    state.bulkBatches = Array.isArray(batches) ? batches : [];
    renderBulkBatches();
  } catch (error) {
    if (!quiet) showToast(error.message, true);
  } finally { state.bulkLoading = false; }
}

function portalOrders() {
  return state.orders
    .filter(order => order.releaseMethodType === 'PRODUCTION' && order.cisType !== 'SET')
    .filter(order => !['APPLIED_REAPPLY_INVALID', 'EMITTED_REAPPLY_INVALID', 'REJECTED'].includes(order.status))
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

// Issue date means the day the employee placed the order, not jar production
// or CHZ completion date. Moscow calendar boundaries, inclusive at both ends.
function moscowDay(timestamp = Date.now()) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function issueDateRange(now = Date.now()) {
  const today = moscowDay(now);
  const shift = days => new Date(Date.parse(today + 'T12:00:00Z') + days * 86400000).toISOString().slice(0, 10);
  if (state.datePeriod === 'all') return { from: '', to: '' };
  if (state.datePeriod === 'custom') return { from: state.dateFrom, to: state.dateTo };
  if (state.datePeriod === 'yesterday') return { from: shift(-1), to: shift(-1) };
  return { from: state.datePeriod === 'week' ? shift(-6) : today, to: today };
}

function matchesIssueDate(order, now = Date.now()) {
  const range = issueDateRange(now);
  const day = moscowDay(order.createdAt ?? NaN);
  return Boolean(day) && (!range.from || day >= range.from) && (!range.to || day <= range.to);
}

function renderDateControls() {
  const range = issueDateRange();
  $$('[data-date-period]').forEach(el => { el.value = state.datePeriod; });
  $$('[data-date-from]').forEach(el => { el.value = state.dateFrom; el.max = state.dateTo; });
  $$('[data-date-to]').forEach(el => { el.value = state.dateTo; el.min = state.dateFrom; });
  $$('[data-date-range]').forEach(el => { el.hidden = state.datePeriod !== 'custom'; });
  const invalid = range.from && range.to && range.from > range.to;
  $$('[data-date-note]').forEach(el => { el.textContent = invalid ? 'Начало периода должно быть не позже окончания.' : 'По дню создания заказа · московское время'; });
}

function syncDateFilterFromUrl() {
  const params = new URL(location.href).searchParams;
  const period = params.get('period');
  state.datePeriod = ['today', 'yesterday', 'week', 'all', 'custom'].includes(period) ? period : 'today';
  const validDate = key => /^\d{4}-\d{2}-\d{2}$/.test(params.get(key) || '') ? params.get(key) : '';
  state.dateFrom = validDate('from');
  state.dateTo = validDate('to');
  renderDateControls();
  renderDashboard();
  renderBulkBatches();
}

function changeDateFilter(event) {
  const el = event.target;
  if (el.hasAttribute('data-date-period')) {
    state.datePeriod = el.value;
    if (el.value === 'custom' && !state.dateFrom && !state.dateTo) state.dateFrom = state.dateTo = moscowDay();
  } else if (el.hasAttribute('data-date-from')) state.dateFrom = el.value;
  else state.dateTo = el.value;
  const url = new URL(location.href);
  url.searchParams.set('period', state.datePeriod);
  for (const [key, value] of [['from', state.dateFrom], ['to', state.dateTo]]) {
    if (state.datePeriod === 'custom' && value) url.searchParams.set(key, value); else url.searchParams.delete(key);
  }
  history.replaceState({}, '', url);
  renderDateControls(); renderDashboard(); renderHistory(); renderBulkBatches();
}

function statusHtml(status) {
  return `<span class="status-mark ${escapeHtml(status.tone)}" aria-hidden="true"></span><span>${escapeHtml(status.label)}</span>`;
}

function pdfDownloadButton(order, label = 'Скачать PDF') {
  return `<button class="small-button" type="button" data-download-pdf="${escapeHtml(order.id)}" data-download-name="${escapeHtml(cleanName(order.name))}">${escapeHtml(label)}</button>`;
}

function orderRow(order) {
  const status = order.publicStatus || { label: order.status, tone: 'neutral', progress: 0 };
  const print = order.printAllowed ? `<a class="small-button print" href="/api/order/${encodeURIComponent(order.id)}/labels" target="_blank" rel="noopener">Посмотреть</a>${pdfDownloadButton(order)}` : '';
  return `<article class="order-row" id="order-${escapeHtml(order.id)}">
    <div class="order-main"><strong title="${escapeHtml(cleanName(order.name))}">${escapeHtml(cleanName(order.name))}</strong><small>${escapeHtml(order.gtin)} · ${escapeHtml(formatDate(order.productionDate))} — ${escapeHtml(formatDate(order.expirationDate))}</small></div>
    <div class="order-quantity"><strong>${escapeHtml(order.quantity)} шт.</strong></div>
    <div class="status-block ${escapeHtml(status.tone)}"><div class="status-line">${statusHtml(status)}</div>${order.waitingNote ? `<small>${escapeHtml(order.waitingNote)}</small>` : ''}<div class="progress-track" aria-label="Готовность ${escapeHtml(status.progress)}%"><span style="width:${Number(status.progress) || 0}%"></span></div></div>
    <div class="row-actions">${print}<button class="small-button" type="button" data-details="${escapeHtml(order.id)}">Подробнее</button></div>
  </article>`;
}

function renderDashboard() {
  const orders = portalOrders().filter(order => matchesIssueDate(order));
  const active = orders.filter(order => ['QUEUED', 'ORDER', 'CODES', 'UTILISATION', 'INTRODUCTION'].includes(order.publicStatus?.code));
  const ready = orders.filter(order => order.publicStatus?.code === 'READY');
  const attention = orders.filter(order => order.publicStatus?.code === 'ATTENTION');
  const todayCount = orders.reduce((sum, order) => sum + Number(order.quantity || 0), 0);
  $('#metricActive').textContent = active.length;
  $('#metricReady').textContent = ready.length;
  $('#metricAttention').textContent = attention.length;
  $('#metricToday').textContent = todayCount;
  const current = [...attention, ...active, ...ready].filter((order, index, list) => list.findIndex(item => item.id === order.id) === index);
  $('#activeOrders').innerHTML = current.length ? current.map(orderRow).join('') : '<div class="empty"><strong>За выбранные даты партий нет</strong><p>Измените период или создайте новую партию.</p></div>';
  $('#lastSync').textContent = state.lastOrderSync ? `Обновлено ${dateTimeFormat.format(state.lastOrderSync)}` : 'Обновляем данные…';
}

function syncHistoryControlsFromUrl() {
  const url = new URL(location.href);
  $('#statusFilter').value = url.searchParams.get('status') || 'all';
  $('#orderSearch').value = url.searchParams.get('q') || '';
  renderHistory();
}

function updateHistoryUrl() {
  const url = new URL(location.href);
  url.searchParams.set('view', 'history');
  const status = $('#statusFilter').value;
  const query = $('#orderSearch').value.trim();
  status === 'all' ? url.searchParams.delete('status') : url.searchParams.set('status', status);
  query ? url.searchParams.set('q', query) : url.searchParams.delete('q');
  history.replaceState({}, '', url);
  renderHistory();
}

function renderHistory() {
  const query = $('#orderSearch').value.trim().toLocaleLowerCase('ru-RU');
  const filter = $('#statusFilter').value;
  const filtered = portalOrders().filter(order => {
    const code = order.publicStatus?.code;
    const matchesFilter = filter === 'all' || (filter === 'active' && ['QUEUED', 'ORDER', 'CODES', 'UTILISATION', 'INTRODUCTION'].includes(code)) || (filter === 'ready' && code === 'READY') || (filter === 'attention' && code === 'ATTENTION') || (filter === 'archive' && code === 'ARCHIVE');
    const matchesQuery = !query || `${order.name} ${order.gtin} ${order.id}`.toLocaleLowerCase('ru-RU').includes(query);
    return matchesFilter && matchesQuery && matchesIssueDate(order);
  });
  $('#historyRows').innerHTML = filtered.map(order => {
    const status = order.publicStatus;
    const action = order.printAllowed ? `<a class="small-button print" href="/api/order/${encodeURIComponent(order.id)}/labels" target="_blank" rel="noopener">Печать</a>${pdfDownloadButton(order, 'PDF')}` : `<button class="small-button" type="button" data-details="${escapeHtml(order.id)}">Подробнее</button>`;
    return `<tr><td data-label="Партия"><div class="cell-title"><strong>${escapeHtml(cleanName(order.name))}</strong><small>${escapeHtml(order.gtin)}</small></div></td><td data-label="Создана">${escapeHtml(formatDateTime(order.createdAt))}</td><td data-label="Количество">${escapeHtml(order.quantity)} шт.</td><td data-label="Статус"><span class="table-status">${statusHtml(status)}</span></td><td data-label="Действие">${action}</td></tr>`;
  }).join('');
  $('#historyEmpty').hidden = filtered.length > 0;
  $('.table-wrap').hidden = filtered.length === 0;
}

function openDetails(orderId) {
  const order = state.orders.find(item => item.id === orderId);
  if (!order) return;
  state.detailsOrderId = orderId;
  const status = order.publicStatus;
  $('#detailsTitle').textContent = cleanName(order.name);
  const attention = status.code === 'ATTENTION' || order.waitingNote ? `<div class="attention-box"><strong>${order.waitingNote ? 'Ожидаем подключение' : 'Обработка приостановлена'}</strong><p>${escapeHtml(order.waitingNote || order.automationLastError || 'Требуется проверка администратором. Не создавайте повторный заказ.')}</p></div>` : '';
  const activity = (order.activity || []).length ? order.activity.map(item => `<li><strong>${escapeHtml(item.label)}</strong><time datetime="${new Date(item.at).toISOString()}">${escapeHtml(formatDateTime(item.at))}</time></li>`).join('') : '<li><strong>История для старой партии недоступна</strong></li>';
  const print = order.printAllowed ? `<a class="button primary" href="/api/order/${encodeURIComponent(order.id)}/labels" target="_blank" rel="noopener">Посмотреть коды</a><button class="button quiet" type="button" data-download-pdf="${escapeHtml(order.id)}" data-download-name="${escapeHtml(cleanName(order.name))}">Скачать PDF</button>` : '';
  $('#detailsBody').innerHTML = `${attention}<div class="details-summary">
    <div><span>Статус</span><strong>${escapeHtml(status.label)}</strong></div><div><span>Количество</span><strong>${escapeHtml(order.quantity)} шт.</strong></div>
    <div><span>GTIN</span><strong translate="no">${escapeHtml(order.gtin)}</strong></div><div><span>Номер заказа</span><strong translate="no">${escapeHtml(order.id)}</strong></div>
    <div><span>Произведено</span><strong>${escapeHtml(formatDate(order.productionDate))}</strong></div><div><span>Годен до</span><strong>${escapeHtml(formatDate(order.expirationDate))}</strong></div>
  </div><h3>Ход обработки</h3><ol class="activity-list">${activity}</ol><div class="details-actions">${print}<button class="button quiet" type="button" data-close-details>Закрыть</button></div>`;
  if (!$('#detailsDialog').open) $('#detailsDialog').showModal();
}

async function loadOrders({ quiet = false } = {}) {
  if (state.ordersLoading) return;
  state.ordersLoading = true;
  try {
    const orders = await request('GET', '/api/orders/summary');
    state.orders = Array.isArray(orders) ? orders : [];
    state.lastOrderSync = new Date();
    renderDashboard();
    renderHistory();
    if ($('#detailsDialog').open && state.detailsOrderId) openDetails(state.detailsOrderId);
  } catch (error) {
    $('#lastSync').textContent = 'Обновление не удалось. Показаны последние полученные данные.';
    if (!quiet) showToast(error.message, true);
  } finally { state.ordersLoading = false; }
}

function setSystemText(id, value, note) {
  $(`#${id}`).textContent = value;
  $(`#${id}Note`).textContent = note;
}

function renderSystem() {
  renderSignatureRecovery();
  const system = state.system;
  if (!system && !state.systemError) return;
  if (state.systemError) {
    $('#sidebarStatus').innerHTML = '<span class="health-dot bad"></span><span><strong>Нет свежих данных</strong><small>Проверяем связь с сайтом</small></span>';
    $('#systemBanner').className = 'system-banner problem';
    $('#systemBanner').innerHTML = `<span class="health-dot bad"></span><div><strong>Не удаётся обновить состояние</strong><p>${escapeHtml(state.systemError)}</p></div>`;
    for (const id of ['systemSigner', 'systemCertificate', 'systemWorker', 'systemToken', 'systemConnection', 'systemClock']) {
      if ($(`#${id}`)) setSystemText(id, 'Нет свежих данных', 'Повторная проверка произойдёт автоматически.');
    }
    return;
  }
  const signerOk = Boolean(system.laptop?.online && system.laptop?.csptest && system.laptop?.cert);
  const workerOk = Boolean(system.orderAutomation?.enabled);
  const bulkWorkerOk = Boolean(system.bulkOrderWorker?.enabled);
  const connection = system.connection;
  const overall = connection ? connection.code === 'ONLINE' : signerOk && workerOk && bulkWorkerOk;
  const title = connection?.label || (overall ? 'Система работает штатно' : 'Автоматическая обработка временно приостановлена');
  const note = connection?.note || (overall ? 'Новые статусы появятся без действий сотрудника.' : 'Проверьте компьютер электронной подписи. Партии продолжатся автоматически после восстановления связи.');
  const sidebar = $('#sidebarStatus');
  sidebar.innerHTML = `<span class="health-dot ${overall ? 'ok' : 'bad'}" aria-hidden="true"></span><span><strong>${escapeHtml(title)}</strong><small>${overall ? `${system.orderAutomation.activeCount || 0} в обработке` : 'Откройте раздел «Система»'}</small></span>`;
  const banner = $('#systemBanner');
  banner.className = `system-banner ${overall ? 'good' : 'problem'}`;
  banner.innerHTML = `<span class="health-dot ${overall ? 'ok' : 'bad'}" aria-hidden="true"></span><div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(note)}${connection?.lastSeenAt ? ` Последняя связь: ${escapeHtml(formatDateTime(connection.lastSeenAt))}.` : ''}</p></div>`;
  setSystemText('systemSigner', signerOk ? 'Проверена' : 'Ожидаем проверку', signerOk ? 'CryptoPro установлен, сертификат найден. Доступ к ключу проверяется при подписании.' : friendlyError(system.laptop?.error || 'Компьютер подписи не отвечает.'));
  if (system.signatureRecovery?.blocked) setSystemText('systemSigner', 'ЭЦП недоступна', 'Подключите носитель, проверьте PIN в CryptoPro и нажмите кнопку ниже.');
  else if (system.signatureRecovery?.checking) setSystemText('systemSigner', 'Проверяем подпись…', 'Проверка выполняется на офисном ПК. Очередь сохранена.');
  else if (connection?.online && system.signatureRecovery?.lastSuccessAt) setSystemText('systemSigner', 'Подпись успешно проверена', `Последняя успешная проверка: ${formatDateTime(system.signatureRecovery.lastSuccessAt)}. Перед выпуском проверим доступ снова.`);
  setSystemText('systemCertificate', system.laptop?.cert ? 'Действует' : 'Не найден', system.laptop?.certUntil ? `Действителен до ${formatDate(system.laptop.certUntil)}.` : 'Проверьте носитель и сертификат.');
  setSystemText('systemWorker', workerOk && bulkWorkerOk ? 'Подключена' : 'Ожидает ПК', `${system.orderAutomation?.activeCount || 0} партий в очереди и обработке. ${connection?.note || ''}`);
  if ($('#systemConnection')) setSystemText('systemConnection', title, connection?.lastSeenAt ? `Последний сигнал: ${formatDateTime(connection.lastSeenAt)}. ${note}` : note);
  if ($('#systemClock')) setSystemText('systemClock', connection?.online ? (Math.abs(connection.clockOffsetMs || 0) > 120000 ? 'Требуется синхронизация' : connection.version ? 'Время согласовано' : 'Ожидаем обновление ПК') : 'Нет свежих данных', connection?.version ? `Версия программы: ${connection.version}. Переподключение выполняется автоматически.` : 'Сведения появятся после подключения обновлённой офисной программы.');
  setSystemText('systemToken', system.token?.valid ? 'Авторизация активна' : 'Обновится автоматически', system.token?.valid ? 'Соединение с СУЗ готово.' : 'Токен будет получен перед следующей операцией.');
  updateOrderSummary();
}

function renderSignatureRecovery() {
  const target = $('#signatureNotice');
  if (!target) return;
  const recovery = state.system?.signatureRecovery;
  const connection = state.system?.connection;
  const pending = Boolean(recovery?.checking || ['QUEUED', 'CHECKING'].includes(recovery?.request?.state));
  const blocked = recovery?.blocked || connection?.code === 'SIGNER_UNAVAILABLE';
  const noFreshData = Boolean(state.systemError);
  target.hidden = !blocked && !pending;
  $('#signatureNoticeTitle').textContent = noFreshData ? 'Не удаётся проверить состояние ЭЦП' : pending ? 'Проверяем электронную подпись' : 'ЭЦП недоступна — проверьте флешку';
  $('#signatureNoticeText').textContent = noFreshData ? 'Связь с сайтом прервалась. Задания сохранены; дождитесь восстановления соединения.'
    : pending ? connection?.online ? 'Проверка выполняется на ПК ЧЗ и может занять до двух минут. Проверьте, не ждёт ли CryptoPro ввода PIN. После успеха очередь продолжится автоматически.' : 'Запрос сохранён. Проверим ЭЦП, когда офисный ПК подключится к сайту. Повторно нажимать кнопку не нужно.'
    : '1. Подключите флешку ЭЦП к офисному ПК. 2. Войдите в Windows и проверьте окно CryptoPro. 3. Нажмите кнопку ниже. Новые заказы создавать не нужно — все этапы сохранены.';
  $$('[data-signature-recheck]').forEach(button => {
    button.disabled = state.signatureSubmitting || pending || noFreshData || !recovery?.supported;
    button.textContent = pending || state.signatureSubmitting ? 'Проверяем ЭЦП…' : 'ЭЦП подключена — проверить и продолжить';
  });
}

async function recheckSignature() {
  if (state.signatureSubmitting) return;
  state.signatureSubmitting = true; renderSignatureRecovery();
  try {
    const result = await request('POST', '/api/signature/recheck', {});
    if (state.system) state.system.signatureRecovery = result.recovery;
    showToast('Запрос проверки сохранён. После успешной подписи работа продолжится автоматически.');
    await loadSystem({ quiet: true });
  } catch (error) { showToast(error.message, true); }
  finally { state.signatureSubmitting = false; renderSignatureRecovery(); }
}

async function loadSystem({ quiet = false } = {}) {
  if (state.systemLoading) return;
  state.systemLoading = true;
  try {
    state.system = await request('GET', '/api/status');
    state.systemError = null;
    state.systemCheckedAt = Date.now();
    renderSystem();
  } catch (error) {
    state.systemError = error.message;
    renderSystem();
    if (!quiet) showToast(error.message, true);
  } finally { state.systemLoading = false; }
}

function safeFileName(value) {
  return String(value || 'labels')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'labels';
}

async function downloadLabelsPdf(orderId, name) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
  const response = await fetch(`/api/order/${encodeURIComponent(orderId)}/labels-pdf`, { credentials: 'same-origin', signal: controller.signal });
  if (response.status === 401 || response.redirected) throw new Error('Сессия закончилась. Обновите страницу и войдите снова.');
  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(message || `PDF не скачался: ${response.status}`);
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error('Сервер вернул пустой PDF. Обновите страницу и попробуйте ещё раз.');
  if (await blob.slice(0, 5).text() !== '%PDF-') throw new Error('Сервер вернул другой файл вместо PDF. Сообщите администратору номер партии.');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${safeFileName(name)}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Скачивание не завершилось за минуту. Попробуйте ещё раз.');
    throw error;
  } finally { clearTimeout(timer); }
}

function bindEvents() {
  $$('[data-signature-recheck]').forEach(button => button.addEventListener('click', recheckSignature));
  $$('[data-date-period], [data-date-from], [data-date-to]').forEach(el => el.addEventListener('change', changeDateFilter));
  document.addEventListener('click', event => {
    const pdf = event.target.closest('[data-download-pdf]');
    if (pdf) {
      event.preventDefault();
      if (pdf.disabled) return;
      const label = pdf.textContent;
      pdf.disabled = true;
      pdf.textContent = 'Скачиваем…';
      downloadLabelsPdf(pdf.dataset.downloadPdf, pdf.dataset.downloadName)
        .then(() => showToast('PDF передан браузеру для сохранения.'))
        .catch(error => showToast(error.message, true))
        .finally(() => { pdf.disabled = false; pdf.textContent = label; });
      return;
    }
    const route = event.target.closest('[data-route]');
    if (route && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0) { event.preventDefault(); navigate(route.dataset.route); return; }
    const details = event.target.closest('[data-details]');
    if (details) openDetails(details.dataset.details);
    if (event.target.closest('[data-close-details]')) $('#detailsDialog').close();
    const productOption = event.target.closest('[data-product-gtin]');
    if (productOption) { selectComboboxProduct(productOption.dataset.productGtin); return; }
    if (!event.target.closest('#productCombobox')) closeProductMenu();
  });
  $('#menuButton').addEventListener('click', () => {
    const menu = $('#mobileNav');
    menu.hidden = !menu.hidden;
    $('#menuButton').setAttribute('aria-expanded', String(!menu.hidden));
  });
  $('#productSearch').addEventListener('input', handleProductSearch);
  $('#productSearch').addEventListener('focus', () => openProductMenu());
  $('#productSearch').addEventListener('click', () => { if (!state.productMenuOpen) openProductMenu(); });
  $('#productSearch').addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveProductHighlight(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveProductHighlight(-1); return; }
    if (event.key === 'Enter' && state.productMenuOpen) {
      event.preventDefault();
      const product = visibleProducts()[state.productActiveIndex];
      if (product) selectComboboxProduct(product.gtin);
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); closeProductMenu(); }
    if (event.key === 'Tab') closeProductMenu();
  });
  $('#productComboboxButton').addEventListener('click', () => {
    if (state.productMenuOpen) closeProductMenu();
    else { $('#productSearch').focus(); openProductMenu({ showAll: true }); }
  });
  $('#quantity').addEventListener('input', () => { state.draft = true; updateOrderSummary(); });
  $('#productionDate').addEventListener('change', () => { state.draft = true; });
  $('#expirationDate').addEventListener('change', () => { state.draft = true; });
  $('#twoYearsButton').addEventListener('click', () => {
    const production = $('#productionDate').value;
    if (!production) { showFormError({ error: 'Сначала укажите дату производства.', field: $('#productionDate') }); return; }
    $('#expirationDate').value = addYears(production, 2);
    state.draft = true;
  });
  $('#newOrderForm').addEventListener('submit', event => { event.preventDefault(); openConfirmation(); });
  $('#confirmButton').addEventListener('click', createOrder);
  $('#bulkProductSearch').addEventListener('input', renderBulkProducts);
  $('#bulkProductionDate').addEventListener('change', () => { state.bulkDraft = true; });
  $('#bulkExpirationDate').addEventListener('change', () => { state.bulkDraft = true; });
  $('#bulkOrderForm').addEventListener('submit', event => { event.preventDefault(); openBulkConfirmation(); });
  $('#bulkTwoYearsButton').addEventListener('click', () => {
    const production = $('#bulkProductionDate').value;
    if (!production) return showBulkError('Сначала укажите общую дату производства.', $('#bulkProductionDate'));
    $('#bulkExpirationDate').value = addYears(production, 2);
    state.bulkDraft = true;
  });
  $('#applyBulkDatesButton').addEventListener('click', applyBulkDates);
  $('#selectAllReadyButton').addEventListener('click', () => {
    for (const product of state.products) if (bulkEligible(product)) state.bulkItems[product.gtin].selected = true;
    state.bulkDraft = true;
    renderBulkProducts();
  });
  $('#clearBulkSelectionButton').addEventListener('click', () => {
    for (const item of Object.values(state.bulkItems)) item.selected = false;
    state.bulkDraft = true;
    renderBulkProducts();
  });
  $('#bulkProductRows').addEventListener('change', event => {
    const input = event.target.closest('[data-bulk-field]');
    if (!input) return;
    const item = state.bulkItems[input.dataset.gtin];
    if (!item) return;
    const field = input.dataset.bulkField;
    item[field] = field === 'selected' ? input.checked : field === 'quantity' ? Number(input.value) : input.value;
    state.bulkDraft = true;
    if (field === 'selected') renderBulkProducts(); else updateBulkSummary();
  });
  $('#reloadCatalogButton').addEventListener('click', async () => {
    const button = $('#reloadCatalogButton');
    button.disabled = true;
    button.textContent = 'Обновляем…';
    try { await loadProducts(); showToast('Каталог обновлён из Честного ЗНАКа.'); }
    finally { button.disabled = false; button.textContent = 'Обновить каталог ЧЗ'; }
  });
  $('#closeBulkConfirm').addEventListener('click', () => $('#bulkConfirmDialog').close());
  $('#cancelBulkConfirm').addEventListener('click', () => $('#bulkConfirmDialog').close());
  $('#confirmBulkButton').addEventListener('click', createBulkBatch);
  $('#refreshButton').addEventListener('click', () => loadOrders());
  $('#checkSystemButton').addEventListener('click', () => loadSystem());
  $('#orderSearch').addEventListener('input', updateHistoryUrl);
  $('#statusFilter').addEventListener('change', updateHistoryUrl);
  $('#closeDetails').addEventListener('click', () => $('#detailsDialog').close());
  window.addEventListener('popstate', renderRoute);
  window.addEventListener('offline', () => { state.systemError = 'На этом устройстве нет интернета. Ожидаем восстановление связи.'; renderSystem(); });
  const reconnect = () => { if (!document.hidden) { loadSystem({ quiet: true }); loadOrders({ quiet: true }); loadBulkBatches({ quiet: true }); } };
  window.addEventListener('online', reconnect);
  window.addEventListener('focus', reconnect);
  document.addEventListener('visibilitychange', reconnect);
  window.addEventListener('beforeunload', event => { if (hasDraft()) { event.preventDefault(); event.returnValue = ''; } });
}

async function init() {
  bindEvents();
  const today = new Date().toLocaleDateString('sv-SE');
  $('#productionDate').max = today;
  $('#bulkProductionDate').max = today;
  renderRoute();
  await Promise.all([loadProducts(), loadOrders(), loadBulkBatches(), loadSystem()]);
  setInterval(() => { loadOrders({ quiet: true }); loadBulkBatches({ quiet: true }); }, 4000);
  setInterval(() => loadSystem({ quiet: true }), 10000);
}

init();
