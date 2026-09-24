// Юридическое лицо склада — «Хранитель» в актах приёмки на хранение и
// отгрузки с хранения (владелец 24.09.2026). У каждого склада своё: в код
// его не вписываем.
exports.up = (pgm) => {
  pgm.sql('ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS legal_name TEXT');
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE warehouses DROP COLUMN IF EXISTS legal_name');
};
