exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- All previous percentages came from the fixed 500-unit assumption.
    -- The application has no capacity input and never saved measured values.
    -- Remove only this derived metric, leaving stock and layout untouched.
    ALTER TABLE cell_blocks ALTER COLUMN fill_pct DROP NOT NULL;
    ALTER TABLE cell_blocks ALTER COLUMN fill_pct DROP DEFAULT;
    UPDATE cell_blocks SET fill_pct=NULL WHERE fill_pct IS NOT NULL;
  `);
};

exports.down = () => {
  throw new Error('Measured capacity was never recorded; the fictitious 500-unit percentages cannot be restored.');
};
