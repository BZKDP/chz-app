'use strict';

const cfg = require('./config');
const db = require('./db');
const trueapi = require('./trueapi');

function normalizeProduct(info, meta, existing = {}) {
  const registeredName = String(info?.name || info?.productName || existing.registeredName || existing.name || meta.gtin).trim();
  return Object.assign(existing, {
    gtin: String(meta.gtin),
    name: registeredName,
    registeredName,
    fullName: info?.fullName || null,
    brand: info?.brand || null,
    packageType: info?.packageType || null,
    productGroup: info?.productGroup || cfg.productGroup,
    innerUnitCount: info?.innerUnitCount != null ? info.innerUnitCount : null,
    isSet: Boolean(meta.isSet || info?.isSet),
    isKit: Boolean(meta.isKit || info?.isKit),
    goodStatus: meta.goodStatus || info?.goodStatus || null,
    signed: info?.goodSignedFlag === true,
    markReady: info?.goodMarkFlag === true,
    turnReady: info?.goodTurnFlag === true,
    tnVedCode10: info?.tnVedCode10 || null,
    stateRegistrationCertificate: info?.stateRegistrationCertificate || null,
    source: 'Честный ЗНАК',
    catalogSyncedAt: Date.now(),
    templateId: 30
  });
}

function localProducts() {
  return db.get().products
    .filter(product => !product.productGroup || product.productGroup === cfg.productGroup)
    .map(product => Object.assign({}, product, {
      registeredName: product.registeredName || product.name,
      eligible: !product.bulkExcluded && !product.isSet && !product.isKit && product.signed === true && product.markReady === true && product.turnReady === true
    }));
}

async function syncOfficialCatalog() {
  const gtinResult = await trueapi.productGtins(cfg.productGroup, { limit: 10000 });
  if (!gtinResult.ok) return { ok: false, error: gtinResult.error, source: 'cache', products: localProducts() };
  const metaRows = Array.isArray(gtinResult.results) ? gtinResult.results : [];
  const gtins = metaRows.map(row => String(row.gtin || '')).filter(gtin => /^\d{14}$/.test(gtin));
  if (!gtins.length) return { ok: false, error: 'Честный ЗНАК вернул пустой каталог БАД', source: 'cache', products: localProducts() };
  const infoResult = await trueapi.productInfo(gtins);
  if (!infoResult.ok) return { ok: false, error: infoResult.error, source: 'cache', products: localProducts() };
  const infoByGtin = new Map((infoResult.results || []).map(row => [String(row.gtin), row]));
  const data = db.get();
  const synced = [];
  for (const meta of metaRows) {
    const gtin = String(meta.gtin || '');
    if (!/^\d{14}$/.test(gtin)) continue;
    let product = data.products.find(row => row.gtin === gtin);
    if (!product) {
      product = { id: `p_chz_${gtin}` };
      data.products.push(product);
    }
    normalizeProduct(infoByGtin.get(gtin), Object.assign({}, meta, { gtin }), product);
    synced.push(product);
  }
  db.save();
  return {
    ok: true,
    source: 'Честный ЗНАК',
    syncedAt: Date.now(),
    products: synced.map(product => Object.assign({}, product, {
      eligible: !product.bulkExcluded && !product.isSet && !product.isKit && product.signed && product.markReady && product.turnReady
    }))
  };
}

module.exports = { syncOfficialCatalog, localProducts, normalizeProduct };
