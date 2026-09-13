exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE integration_sync_state
      ADD COLUMN stock_calculation JSONB,
      ADD COLUMN stock_calculation_status TEXT
        CHECK (stock_calculation_status IN ('accepted', 'invalid', 'not_provided'));
    COMMENT ON COLUMN integration_sync_state.stock_calculation IS
      'Условия расчёта, заявленные модулем для последней пачки остатков. Время локальное 1С без часового пояса; полноту обмена не подтверждает.';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE integration_sync_state
    DROP COLUMN stock_calculation, DROP COLUMN stock_calculation_status;`);
};
