const { createHash } = require('node:crypto');

function sellerQuantities(row) {
  return {
    known: row.totalKnown ?? row.stockKnown,
    total: row.total ?? row.onHand,
    reserved: row.inAssembly ?? row.reserved ?? row.ordered,
    available: row.sellerAvailable ?? row.available,
    observedAt: row.totalUpdatedAt ?? row.countedAt,
  };
}

// Versioned interchange contract, not native 1C document serialization.
// Keep availability separate from physical inventory and preserve barcodes as text.
function prepareInventoryExport(rows, identity, generatedAt = new Date().toISOString()) {
  const issues = [];
  const barcodes = new Map();
  for (const row of rows) {
    const quantity = sellerQuantities(row);
    const add = (code, message) => issues.push({ sku: row.sku, barcode: row.barcode || null, name: row.name, code, message });
    if (!quantity.known || quantity.total == null || quantity.available == null) add('unknown_stock', 'Количество товара ещё не получено');
    if (typeof row.barcode !== 'string' || !row.barcode.trim()) add('missing_barcode', 'Не указан штрихкод');
    else if (/[\u0000-\u001f\u007f]/.test(row.barcode)) add('invalid_barcode', 'Штрихкод содержит служебные символы');
    else {
      const barcode = row.barcode.trim();
      if (barcodes.has(barcode)) add('duplicate_barcode', 'Этот штрихкод указан у нескольких товаров');
      else barcodes.set(barcode, row.sku);
    }
    if (quantity.known && [quantity.total, quantity.reserved, quantity.available].some(n => !Number.isSafeInteger(n) || n < 0)) {
      add('invalid_quantity', 'Для выгрузки в штуках требуется целое неотрицательное количество');
    }
  }
  if (!rows.length) issues.push({ code: 'empty', message: 'Нет товаров для выгрузки', sku: null, name: null });
  const readiness = { ready: issues.length === 0, productCount: rows.length, problemProducts: new Set(issues.map(x=>x.sku)).size, issues };
  if (!readiness.ready) return { readiness, snapshot: null };
  const items = rows.map(r => {
    const quantity = sellerQuantities(r);
    return { sku: r.sku, barcode: r.barcode.trim(), name: r.name,
      unit: 'pcs', onHand: quantity.total, inAssembly: quantity.reserved, available: quantity.available,
      stockObservedAt: quantity.observedAt ? new Date(quantity.observedAt).toISOString() : null,
    };
  }).sort((a,b)=>a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);
  const content = { format: 'argus.inventory', schemaVersion: 1, ...identity,
    quantityMode: 'absolute', missingItems: 'unchanged', primaryMeasure: 'available', items };
  const snapshotId = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  return { readiness, snapshot: { ...content, snapshotId, generatedAt } };
}

module.exports = { prepareInventoryExport };
