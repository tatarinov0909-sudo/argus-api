const { readStockCalculation } = require('./stockCalculation');

// Последняя принятая пачка каждого этапа. Не журнал payload и не доказательство
// успешного полного запуска: номенклатура и остатки могут идти многими пачками.
async function recordBatch(client, req, records, results) {
  const { warehouseId, integrationKeyId } = req.auth;
  const stage = req.path.split('/').pop();
  const version = req.get('X-Argus-Module-Version');
  const mode = req.get('X-Argus-Run-Mode');
  const context = stage === 'stock'
    ? readStockCalculation(req.body?.stockCalculation, records.length)
    : { status: null, calculation: null };
  const summary = {};
  for (const row of results) {
    summary[row.status] = (summary[row.status] || 0) + 1;
    if (row.warning) summary.warnings = (summary.warnings || 0) + 1;
  }
  await client.query(`INSERT INTO integration_sync_state
    (warehouse_id, integration_key_id, stage, module_version, run_mode, record_count, summary,
      stock_calculation, stock_calculation_status)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
    ON CONFLICT (warehouse_id, integration_key_id, stage) DO UPDATE SET
      received_at = now(), module_version = EXCLUDED.module_version,
      run_mode = EXCLUDED.run_mode, record_count = EXCLUDED.record_count, summary = EXCLUDED.summary,
      stock_calculation = EXCLUDED.stock_calculation,
      stock_calculation_status = EXCLUDED.stock_calculation_status`,
  [warehouseId, integrationKeyId, stage,
    typeof version === 'string' && /^[\d.\-# ]{1,40}$/.test(version) ? version : null,
    ['automatic', 'manual'].includes(mode) ? mode : null, records.length, JSON.stringify(summary),
    context.calculation ? JSON.stringify(context.calculation) : null, context.status]);
  return summary;
}

module.exports = { recordBatch };
