'use strict';

const { prepareInventoryExport } = require('../../src/sellers/export');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const uuid = value => typeof value === 'string' && UUID.test(value);
const hash = value => typeof value === 'string' && HASH.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.trim() === value && !CONTROL.test(value);
const quantity = value => Number.isSafeInteger(value) && value >= 0;
const keys = (value, required) => object(value) && Object.keys(value).length === required.length && required.every(key => Object.hasOwn(value, key));
const targetKeys = ['databaseId', 'organizationId', 'warehouseId'];
const validTarget = value => keys(value, targetKeys) && targetKeys.every(key => text(value[key]));
const sameTarget = (a, b) => targetKeys.every(key => a[key] === b[key]);

// Accept the UTC representation emitted by Argus; reject date rollover and local time.
function utcTime(value) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return NaN;
  const time = Date.parse(value);
  const canonical = `${match[1]}.${(match[2] || '').padEnd(3, '0')}Z`;
  return Number.isFinite(time) && new Date(time).toISOString() === canonical ? time : NaN;
}

function validateSnapshot(snapshot) {
  const issues = [];
  const add = (code, path, message) => issues.push({ code, path, message });
  if (!keys(snapshot, ['format', 'schemaVersion', 'seller', 'warehouse', 'quantityMode', 'missingItems', 'primaryMeasure', 'items', 'snapshotId', 'generatedAt'])) {
    return [{ code: 'invalid_structure', path: '$', message: 'Неверный состав полей снимка v1' }];
  }
  if (snapshot.format !== 'argus.inventory' || snapshot.schemaVersion !== 1) add('unsupported_format', '$', 'Поддерживается только argus.inventory v1');
  if (!keys(snapshot.seller, ['id', 'name']) || !uuid(snapshot.seller.id) || !text(snapshot.seller.name)) add('invalid_seller', 'seller', 'Неверный идентификатор или название продавца');
  if (!keys(snapshot.warehouse, ['id']) || !uuid(snapshot.warehouse.id)) add('invalid_warehouse', 'warehouse', 'Неверный идентификатор склада');
  if (snapshot.quantityMode !== 'absolute' || snapshot.missingItems !== 'unchanged' || snapshot.primaryMeasure !== 'available') add('unsupported_semantics', '$', 'Нужны абсолютные доступные остатки без обнуления отсутствующих строк');
  if (!hash(snapshot.snapshotId)) add('invalid_snapshot_id', 'snapshotId', 'Неверный идентификатор снимка');
  const generatedAt = utcTime(snapshot.generatedAt);
  if (!Number.isFinite(generatedAt)) add('invalid_time', 'generatedAt', 'Нужна корректная дата UTC');
  if (!Array.isArray(snapshot.items) || !snapshot.items.length) {
    add('empty_items', 'items', 'В снимке нет товаров');
    return issues;
  }
  const skus = new Set();
  const barcodes = new Set();
  snapshot.items.forEach((item, index) => {
    const path = `items[${index}]`;
    if (!keys(item, ['sku', 'barcode', 'name', 'unit', 'onHand', 'inAssembly', 'available', 'stockObservedAt'])) {
      add('invalid_item', path, 'Неверный состав полей товара');
      return;
    }
    for (const field of ['sku', 'barcode', 'name']) if (!text(item[field])) add('invalid_text', `${path}.${field}`, 'Нужна непустая строка без служебных символов и крайних пробелов');
    for (const [value, set, field] of [[item.sku, skus, 'sku'], [item.barcode, barcodes, 'barcode']]) {
      if (set.has(value)) add('duplicate_item', `${path}.${field}`, 'Идентификатор повторяется в снимке');
      set.add(value);
    }
    if (item.unit !== 'pcs') add('unsupported_unit', `${path}.unit`, 'Поддерживаются только штуки без пересчёта упаковок');
    if (![item.onHand, item.inAssembly, item.available].every(quantity)) add('invalid_quantity', path, 'Количество должно быть целым неотрицательным безопасным числом');
    else if (item.available !== Math.max(0, item.onHand - item.inAssembly)) add('invalid_availability', path, 'Доступное количество не соответствует остатку и сборке');
    if (item.stockObservedAt !== null) {
      const observedAt = utcTime(item.stockObservedAt);
      if (!Number.isFinite(observedAt) || observedAt > generatedAt) add('invalid_stock_time', `${path}.stockObservedAt`, 'Дата наблюдения некорректна или позже формирования снимка');
    }
  });
  if (!issues.length) {
    // Use the exporter's canonical ordering and hash contract, never raw JSON text.
    const rows = snapshot.items.map(item => ({ ...item, stockKnown: true, ordered: item.inAssembly, countedAt: item.stockObservedAt }));
    const expected = prepareInventoryExport(rows, {
      seller: { id: snapshot.seller.id, name: snapshot.seller.name }, warehouse: { id: snapshot.warehouse.id },
    }, snapshot.generatedAt).snapshot.snapshotId;
    if (expected !== snapshot.snapshotId) add('content_mismatch', 'snapshotId', 'Содержимое не соответствует идентификатору снимка');
  }
  return issues;
}

// Pure preview: no filesystem, database, network, 1C writes, or journal mutation.
function planInventoryImport(snapshot, context, now = new Date().toISOString()) {
  const issues = validateSnapshot(snapshot);
  const result = (status, changes = [], unchangedCount = 0) => ({
    mode: 'dry-run', status, writesPerformed: false, issues, changes, unchangedCount,
    snapshotId: snapshot?.snapshotId || null,
  });
  if (issues.length) return result('blocked');
  const add = (code, message, barcode) => issues.push({ code, message, ...(barcode === undefined ? {} : { barcode }) });
  const binding = context?.binding;
  const policy = context?.policy;
  const nowTime = utcTime(now);
  if (!object(binding) || !uuid(binding.sellerId) || !uuid(binding.warehouseId) || !validTarget(binding.target) || binding.purpose !== 'salesAvailability') {
    add('invalid_binding', 'Нужна явная связь продавца и склада Аргуса с базой, организацией и складом назначения для наличия в продаже');
  } else if (binding.sellerId !== snapshot.seller.id || binding.warehouseId !== snapshot.warehouse.id) {
    add('source_mismatch', 'Снимок относится к другому продавцу или складу Аргуса');
  }
  if (!object(policy) || !['maxFileAgeMs', 'maxStockAgeMs', 'maxCatalogAgeMs'].every(key => Number.isSafeInteger(policy[key]) && policy[key] > 0) || !Number.isFinite(nowTime)) {
    add('invalid_policy', 'Нужны текущая дата UTC и допустимый возраст файла, складских наблюдений и каталога в миллисекундах');
  }
  if (!Array.isArray(context?.journal)) add('invalid_journal', 'Нужен журнал применённых снимков; для первого подключения передайте пустой список');
  if (issues.length) return result('blocked');

  const journal = context.journal;
  if (journal.some(entry => !object(entry) || !uuid(entry.sellerId) || !uuid(entry.warehouseId) || !validTarget(entry.target) || !hash(entry.snapshotId) || !Number.isFinite(utcTime(entry.generatedAt)))) {
    add('invalid_journal', 'Журнал содержит некорректную запись');
    return result('blocked');
  }
  const previous = journal.filter(entry => entry.sellerId === binding.sellerId && entry.warehouseId === binding.warehouseId && sameTarget(entry.target, binding.target));
  if (previous.some(entry => entry.snapshotId === snapshot.snapshotId)) return result('already_applied');
  const generatedAt = utcTime(snapshot.generatedAt);
  if (previous.some(entry => utcTime(entry.generatedAt) >= generatedAt)) add('stale_snapshot', 'Уже применён другой снимок с такой же или более поздней датой');
  if (generatedAt > nowTime || nowTime - generatedAt > policy.maxFileAgeMs) add('expired_snapshot', 'Дата снимка в будущем или превышен допустимый возраст файла');
  for (const item of snapshot.items) {
    const observedAt = utcTime(item.stockObservedAt);
    if (!Number.isFinite(observedAt) || nowTime - observedAt > policy.maxStockAgeMs) add('unconfirmed_freshness', 'Нет достаточно свежего наблюдения складского остатка', item.barcode);
  }

  const catalog = context.catalog;
  if (!object(catalog) || !validTarget(catalog.target) || !sameTarget(catalog.target, binding.target) || !Array.isArray(catalog.items)) {
    add('catalog_scope_mismatch', 'Каталог должен относиться к выбранной базе, организации и складу назначения');
    return result('blocked');
  }
  const catalogTime = utcTime(catalog.observedAt);
  if (!Number.isFinite(catalogTime) || catalogTime > nowTime || nowTime - catalogTime > policy.maxCatalogAgeMs) add('stale_catalog', 'Каталог назначения устарел или не имеет корректной даты');
  const byBarcode = new Map();
  for (const item of catalog.items) {
    if (!object(item) || !text(item.barcode) || !text(item.productId) || !(item.characteristicId === null || text(item.characteristicId)) || !text(item.unit) || !quantity(item.available)) {
      add('invalid_catalog_item', 'Некорректная строка каталога назначения');
      continue;
    }
    const matches = byBarcode.get(item.barcode) || [];
    matches.push(item);
    byBarcode.set(item.barcode, matches);
  }
  const changes = [];
  const targets = new Set();
  let unchangedCount = 0;
  for (const item of snapshot.items) {
    const matches = byBarcode.get(item.barcode) || [];
    if (matches.length !== 1) {
      add(matches.length ? 'ambiguous_barcode' : 'unmatched_barcode', matches.length ? 'Штрихкод соответствует нескольким позициям назначения' : 'Штрихкод не найден в каталоге назначения', item.barcode);
      continue;
    }
    const target = matches[0];
    const targetKey = JSON.stringify([target.productId, target.characteristicId, target.unit]);
    if (targets.has(targetKey)) add('duplicate_target', 'Несколько строк снимка указывают на одну позицию назначения', item.barcode);
    targets.add(targetKey);
    if (target.unit !== 'pcs') add('unit_mismatch', 'Единица назначения отличается от штуки; автоматический пересчёт запрещён', item.barcode);
    if (target.available === item.available) unchangedCount++;
    else changes.push({
      operation: 'setSalesAvailability', barcode: item.barcode, sku: item.sku,
      target: { ...binding.target, productId: target.productId, characteristicId: target.characteristicId, unit: 'pcs' },
      before: target.available, after: item.available,
      source: { onHand: item.onHand, inAssembly: item.inAssembly, available: item.available, stockObservedAt: item.stockObservedAt },
    });
  }
  // No partial executable plan: a single problem blocks all changes.
  return issues.length ? result('blocked') : result('ready_for_adapter', changes, unchangedCount);
}

module.exports = { validateSnapshot, planInventoryImport };
