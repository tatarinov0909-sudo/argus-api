/* eslint-disable camelcase */

exports.shorthands = undefined;

// Минус в «Складе» гасится следующим приходом (проверка 07.10.2026, Н5).
//
// При выключенном адресном хранении сборка сверх учёта записывает минус
// отдельной строкой, а приход — отдельной строкой с плюсом. Сверка с файлом,
// сборка и раскладка по складам продавца смотрят строки с плюсом — и видели
// больше, чем есть: файл совпадал с Аргусом, а сверка снимала товар, минус
// оставался навсегда.
//
// Правило: у товара в «Складе» (одна ячейка general) не бывает одновременно
// строки с минусом и строки с плюсом — такие строки сводятся в одну, в ту,
// которую только что записали. Ключ — продавец, артикул, качество и склад
// продавца: товар разных складов продавца не смешивается.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE FUNCTION cell_stock_net_general() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
    DECLARE
      total numeric;
    BEGIN
      IF pg_trigger_depth() > 1 OR NEW.qty = 0 THEN RETURN NULL; END IF;
      IF NOT EXISTS (SELECT 1 FROM cell_blocks cb WHERE cb.id = NEW.cell_block_id AND cb.general) THEN RETURN NULL; END IF;
      IF NOT EXISTS (SELECT 1 FROM cell_stock cs
                      WHERE cs.cell_block_id = NEW.cell_block_id AND cs.id <> NEW.id
                        AND cs.company_id IS NOT DISTINCT FROM NEW.company_id AND cs.sku = NEW.sku
                        AND cs.quality = NEW.quality
                        AND cs.virtual_warehouse_id IS NOT DISTINCT FROM NEW.virtual_warehouse_id
                        AND sign(cs.qty) = -sign(NEW.qty)) THEN
        RETURN NULL;
      END IF;
      SELECT sum(cs.qty) INTO total FROM cell_stock cs
       WHERE cs.cell_block_id = NEW.cell_block_id
         AND cs.company_id IS NOT DISTINCT FROM NEW.company_id AND cs.sku = NEW.sku AND cs.quality = NEW.quality
         AND cs.virtual_warehouse_id IS NOT DISTINCT FROM NEW.virtual_warehouse_id;
      DELETE FROM cell_stock cs
       WHERE cs.cell_block_id = NEW.cell_block_id AND cs.id <> NEW.id
         AND cs.company_id IS NOT DISTINCT FROM NEW.company_id AND cs.sku = NEW.sku AND cs.quality = NEW.quality
         AND cs.virtual_warehouse_id IS NOT DISTINCT FROM NEW.virtual_warehouse_id;
      IF total = 0 THEN
        DELETE FROM cell_stock WHERE id = NEW.id;
      ELSE
        UPDATE cell_stock SET qty = total, updated_at = now() WHERE id = NEW.id;
      END IF;
      RETURN NULL;
    END;
    $$;
    CREATE TRIGGER cell_stock_net_general AFTER INSERT OR UPDATE OF qty, cell_block_id ON cell_stock
      FOR EACH ROW EXECUTE FUNCTION cell_stock_net_general();

    -- Разово: свести то, что уже накопилось.
    WITH keys AS (
      SELECT cs.cell_block_id, cs.company_id, cs.sku, cs.quality, cs.virtual_warehouse_id,
             min(cs.id::text)::uuid AS keep, sum(cs.qty) AS total
        FROM cell_stock cs JOIN cell_blocks cb ON cb.id = cs.cell_block_id AND cb.general
       GROUP BY 1, 2, 3, 4, 5
      HAVING bool_or(cs.qty < 0) AND bool_or(cs.qty > 0)
    ), dropped AS (
      DELETE FROM cell_stock cs USING keys k
       WHERE cs.cell_block_id = k.cell_block_id AND cs.company_id IS NOT DISTINCT FROM k.company_id
         AND cs.sku = k.sku AND cs.quality = k.quality
         AND cs.virtual_warehouse_id IS NOT DISTINCT FROM k.virtual_warehouse_id
         AND (cs.id <> k.keep OR k.total = 0)
      RETURNING cs.id
    )
    UPDATE cell_stock cs SET qty = k.total, updated_at = now()
      FROM keys k WHERE cs.id = k.keep AND k.total <> 0;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS cell_stock_net_general ON cell_stock;
    DROP FUNCTION IF EXISTS cell_stock_net_general();
  `);
};
