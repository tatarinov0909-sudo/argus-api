// Sender-declared context for the last stock batch, not an audit of 1C or proof
// that every batch arrived. Never use these fields to recalculate quantities.
const FIXED_FIELDS = {
  schemaVersion: 1,
  timeBasis: '1c_local',
  balanceMode: 'current_totals',
  warehouseScope: 'all_in_register',
  productCodePrefix: 'PB',
  excludeDeleted: true,
  excludeGroups: true,
  quantityField: 'КоличествоОстаток',
  quantityUnit: 'register_unit',
  quantityConversion: 'none',
};

function isLocalTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) return false;
  // UTC is used only for calendar validation, never assigned to the source time.
  const date = new Date(value + 'Z');
  return Number.isFinite(date.getTime()) && date.toISOString() === value + '.000Z';
}

function readStockCalculation(value, recordCount) {
  if (value === undefined || value === null) return { status: 'not_provided', calculation: null };
  const invalid = { status: 'invalid', calculation: null };
  if (typeof value !== 'object' || Array.isArray(value)) return invalid;
  if (Object.entries(FIXED_FIELDS).some(([key, expected]) => value[key] !== expected)) return invalid;
  if (typeof value.snapshotId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.snapshotId)) return invalid;
  if (typeof value.registerName !== 'string' || !/^[\p{L}_][\p{L}\p{N}_]{0,127}$/u.test(value.registerName)) return invalid;
  if (!isLocalTimestamp(value.calculatedStartedAt) || !isLocalTimestamp(value.calculatedFinishedAt)
      || value.calculatedFinishedAt < value.calculatedStartedAt) return invalid;
  const { totalRecords, batchIndex, batchCount } = value;
  if (![totalRecords, batchIndex, batchCount].every(n => Number.isSafeInteger(n) && n > 0)) return invalid;
  if (batchCount !== Math.ceil(totalRecords / 500) || batchIndex > batchCount
      || recordCount !== Math.min(500, totalRecords - (batchIndex - 1) * 500)) return invalid;
  // Explicit allowlist: drop unknown fields instead of storing arbitrary payload
  // or connection details that a future module might accidentally attach.
  return { status: 'accepted', calculation: {
    ...FIXED_FIELDS,
    snapshotId: value.snapshotId.toLowerCase(),
    calculatedStartedAt: value.calculatedStartedAt,
    calculatedFinishedAt: value.calculatedFinishedAt,
    registerName: value.registerName,
    totalRecords, batchIndex, batchCount,
  } };
}

module.exports = { readStockCalculation };
