// Кладовщик — rule layer only. "решают правила, ИИ только объясняет":
// this module answers questions with plain DB queries; no LLM here.
// Natural-language explanation is a thin layer on top, added separately
// once there's an API key to call.

// Ищем и по справочнику, и по тому, что физически лежит в ячейках. Только по
// справочнику было мало: товар, приехавший накладной без карточки в 1С,
// существовал на полке, но на вопрос «где он?» Кладовщик отвечал «не найдено».
// На живой базе таких артикулов было двое из 633 — редко, но именно про такой
// товар и спрашивают, когда он потерялся.
const { kitInfo } = require('../kits/kits');
const { formatBlockLabel } = require('../cells/label');
const { loadStock, stockBySeller } = require('../sellers/stock');

// «Что лежит в 1.5.4?» (владелец 27.09.2026): Оркестратор искал адрес как
// артикул, находил ноль и отвечал, что по ячейке искать не умеет. Отдельным
// инструментом не делаем — каждый дорожает каждый вопрос; адрес «ряд.стеллаж.
// ярус» (cells/label.js) узнаём в том же поиске: 1.7.3 — ряд 1, стеллаж 7,
// ярус 3.
function parseCellAddress(query) {
  const m = String(query || '').trim().match(/^(\d{1,3})[.\-,/ ]+(\d{1,4})[.\-,/ ]+(\d{1,3})$/);
  return m ? { row: Number(m[1]), rack: Number(m[2]), tier: Number(m[3]) } : null;
}

// withId — отдать и id ячейки: поиску на карте склада надо на неё перейти.
// Агенту id не нужен — лишнее слово в каждом ответе стоит денег.
async function cellContents(client, warehouseId, { row, rack, tier }, { withId = false } = {}) {
  const asked = `${row}.${rack}.${tier}`;
  const block = (await client.query(
    `SELECT cb.id, wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
       FROM cell_blocks cb JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
      WHERE cb.warehouse_id = $1 AND wr.row_num = $2
        AND $3 BETWEEN cb.tier_start AND cb.tier_end AND $4 BETWEEN cb.rack_start AND cb.rack_end
      LIMIT 1`, [warehouseId, row, tier, rack])).rows[0];
  if (!block) return { cell: asked, exists: false, note: 'Такой ячейки на карте склада нет.' };
  const items = (await client.query(
    `SELECT cs.sku, c.name AS seller, cs.quality, SUM(cs.qty) AS qty,
            COALESCE((SELECT p.name FROM products p WHERE p.warehouse_id = cs.warehouse_id
                        AND p.company_id = cs.company_id AND p.sku = cs.sku LIMIT 1), cs.sku) AS name
       FROM cell_stock cs JOIN companies c ON c.id = cs.company_id
      WHERE cs.warehouse_id = $1 AND cs.cell_block_id = $2 AND cs.qty > 0
      GROUP BY cs.warehouse_id, cs.company_id, cs.sku, c.name, cs.quality
      ORDER BY name`, [warehouseId, block.id])).rows;
  const qualityName = { good: 'годный', defective: 'брак', packaging_defect: 'брак упаковки' };
  const label = formatBlockLabel(block.row_num, block);
  return {
    cell: label,
    ...(withId ? { cellBlockId: block.id } : {}),
    // Объединённая ячейка: спросили 1.5.4, а она 1.5.3–5 — говорим как есть.
    merged: label !== asked,
    exists: true,
    empty: items.length === 0,
    totalUnits: items.reduce((s, i) => s + Number(i.qty), 0),
    items: items.map((i) => ({ sku: i.sku, name: i.name, seller: i.seller, qty: Number(i.qty), state: qualityName[i.quality] || i.quality })),
  };
}

async function findProducts(client, warehouseId, query, { withId = false } = {}) {
  const address = parseCellAddress(query);
  if (address) return cellContents(client, warehouseId, address, { withId });
  const products = await client.query(
    `WITH product_catalog AS (
       SELECT p.sku, p.company_id, p.name, p.category, p.weight_g,
              COALESCE(NULLIF(BTRIM(p.barcode), ''), mapped.barcode) AS barcode,
              p.reserved_qty, p.reserved_at, p.stock_qty_1c, p.stock_at
       FROM products p
       LEFT JOIN LATERAL (
         SELECT CASE WHEN COUNT(DISTINCT BTRIM(m.mp_barcode)) = 1
                     THEN MAX(BTRIM(m.mp_barcode)) END AS barcode
         FROM product_marketplace_skus m
         WHERE m.warehouse_id = p.warehouse_id
           AND m.company_id = p.company_id
           AND m.sku = p.sku
           AND m.marketplace = 'wb'
           AND NULLIF(BTRIM(m.mp_barcode), '') IS NOT NULL
       ) mapped ON true
       WHERE p.warehouse_id = $1 AND p.active
     )
     SELECT p.sku, p.company_id, p.name, p.category, p.weight_g, p.barcode,
            p.reserved_qty, p.reserved_at, p.stock_qty_1c, p.stock_at
     FROM product_catalog p
     WHERE p.sku ILIKE $2 OR p.name ILIKE $2 OR p.barcode ILIKE $2

     UNION

     -- То, что лежит в ячейках, но карточки не имеет. Имя берём из последней
     -- накладной, где этот артикул встречался, — иначе человек увидит голый код.
     SELECT cs.sku, cs.company_id, COALESCE(
              (SELECT ii.name FROM invoice_items ii
               WHERE ii.warehouse_id = cs.warehouse_id AND ii.sku = cs.sku
               ORDER BY ii.id DESC LIMIT 1), cs.sku) AS name,
            NULL AS category, NULL AS weight_g, NULL AS barcode,
            NULL AS reserved_qty, NULL AS reserved_at,
            NULL AS stock_qty_1c, NULL AS stock_at
     FROM cell_stock cs
     WHERE cs.warehouse_id = $1 AND cs.qty > 0
       AND NOT EXISTS (SELECT 1 FROM products p2
                       WHERE p2.warehouse_id = cs.warehouse_id AND p2.sku = cs.sku AND p2.active)
       AND (cs.sku ILIKE $2 OR EXISTS (
             SELECT 1 FROM invoice_items ii2
             WHERE ii2.warehouse_id = cs.warehouse_id AND ii2.sku = cs.sku AND ii2.name ILIKE $2))

     ORDER BY name LIMIT 20`,
    [warehouseId, `%${query}%`],
  );

  // «Всего», «Заказано», «В сборке», «В пути», «Доступно» — те же числа и та
  // же формула, что в кабинете продавца (sellers/stock.js). Раньше Кладовщик
  // считал «можно отгрузить» по ячейкам и не вычитал заказы: у 21 товара из 46
  // на стенде ответ в чате расходился с кабинетом (разбор 02.10.2026). Карте
  // склада (withId) хватает ячеек — её не замедляем.
  const cabinet = new Map();
  const sellers = new Map();
  if (!withId && products.rows.length) {
    const companyIds = [...new Set(products.rows.map((p) => p.company_id).filter(Boolean))];
    const source = (await client.query('SELECT stock_source FROM warehouses WHERE id = $1', [warehouseId]))
      .rows[0]?.stock_source === 'argus' ? 'argus' : '1c';
    for (const row of (await client.query('SELECT id, name FROM companies WHERE id = ANY($1::uuid[])', [companyIds])).rows) {
      sellers.set(row.id, row.name);
    }
    for (const companyId of companyIds) {
      for (const r of await loadStock(client, companyId, { source })) cabinet.set(`${companyId}\u0000${r.sku}`, r);
    }
  }

  const results = [];
  for (const p of products.rows) {
    // Только этого продавца: один артикул у двух продавцов — разный товар,
    // и агент отвечал суммой по обоим, обещая владельцу чужие штуки.
    // Суммируем по ячейке: приёмка кладёт по строке на каждое поступление, и
    // одна и та же ячейка возвращалась дважды — человек слышал «94 штуки и ещё
    // 9 там же», хотя ячейка одна и в ней 103.
    const stock = await client.query(
      `SELECT SUM(cs.qty) AS qty, cs.quality, wr.row_num, cb.label, cb.rack_start, cb.rack_end,
              cb.tier_start, cb.tier_end
       FROM cell_stock cs
       JOIN cell_blocks cb ON cb.id = cs.cell_block_id
       JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
       WHERE cs.warehouse_id = $1 AND cs.sku = $2
         AND ($3::uuid IS NULL OR cs.company_id = $3::uuid)
       GROUP BY cb.id, cs.quality, wr.row_num, cb.label, cb.rack_start, cb.rack_end,
                cb.tier_start, cb.tier_end
       ORDER BY wr.row_num, cb.rack_start, cb.tier_start`,
      [warehouseId, p.sku, p.company_id || null],
    );
    // Годное и брак считаем раздельно и говорим об этом вслух. Иначе на
    // вопрос «сколько можно отгрузить» ответ включал бы брак, лежащий на той
    // же полке, — то есть обещал бы клиенту товар, который ему не уедет.
    const qualityName = { good: 'годный', defective: 'брак', packaging_defect: 'брак упаковки' };
    const availableQty = stock.rows
      .filter((r) => r.quality === 'good')
      .reduce((sum, r) => sum + Number(r.qty), 0);
    const totalQty = stock.rows.reduce((sum, r) => sum + Number(r.qty), 0);
    // Набор на вопрос «сколько есть» отвечает дважды: сколько лежит готовым и
    // сколько можно собрать из компонентов. Без второго числа Кладовщик врёт
    // владельцу «ноль» ровно в тот момент, когда собрать можно двадцать.
    // Отдельным инструментом это делать нельзя — каждый инструмент дорожает
    // вопрос примерно на 2.7%; здесь это лишний запрос, а не лишний вызов модели.
    const kitOwner = await client.query(
      `SELECT DISTINCT company_id FROM product_kits
       WHERE warehouse_id = $1 AND kit_sku = $2 LIMIT 1`,
      [warehouseId, p.sku],
    );
    const kit = kitOwner.rows[0]
      ? await kitInfo(client, warehouseId, kitOwner.rows[0].company_id, p.sku)
      : null;

    // Адрес из 1С. Пока приёмка через Аргус не пошла, это ЕДИНСТВЕННЫЙ ответ
    // на вопрос «где лежит»: у владельца адресное хранение ведётся годами,
    // а наши ячейки наполняются только тем, что работник положил сам.
    const cells1c = await client.query(
      `SELECT cell_name, qty FROM product_cells_1c
       WHERE warehouse_id = $1 AND sku = $2
         AND ($3::uuid IS NULL OR company_id = $3::uuid)
       ORDER BY cell_name`,
      [warehouseId, p.sku, p.company_id || null],
    );

    const s = cabinet.get(`${p.company_id}\u0000${p.sku}`);
    results.push({
      sku: p.sku,
      // Продавец обязателен в ответе: один и тот же код у двух продавцов —
      // разный товар, и «60 штук» без имени продавца вводили бы в заблуждение.
      ...(withId ? { companyId: p.company_id || null } : { seller: sellers.get(p.company_id) || null }),
      name: p.name,
      ...(s ? {
        stock: {
          total: s.total, ordered: s.orderedNotInSupply, inAssembly: s.inAssembly,
          inTransit: s.inTransit, available: s.sellerAvailable,
          defect: s.defective + s.packagingDefect, shortage: s.shortage,
        },
      } : {}),
      category: p.category,
      weightG: p.weight_g,
      totalQty,
      availableQty,
      notForSaleQty: totalQty - availableQty,
      barcode: p.barcode || null,
      // Резерв 1С: сколько из этого уже обещано её заказам. НЕ вычитаем сами —
      // заказ, который мы сейчас собираем, вполне может быть тем самым, кто
      // этот резерв и поставил, и вычитание было бы двойным счётом. Показываем
      // рядом, чтобы решение принимал человек, а не арифметика вслепую.
      reservedQty: p.reserved_qty === null || p.reserved_qty === undefined
        ? null : Number(p.reserved_qty),
      reservedAt: p.reserved_at || null,
      // Сколько числится в 1С — отдельно от того, что разложено по ячейкам.
      // Расхождение между ними и есть самая полезная цифра: «в 1С 500,
      // в ячейках 480» означает, что двадцать штук где-то не там.
      stockIn1c: p.stock_qty_1c === null || p.stock_qty_1c === undefined
        ? null : Number(p.stock_qty_1c),
      stockAt: p.stock_at || null,
      kit: kit && {
        buildable: kit.buildable,
        limitedBy: kit.limitedBy,
        components: kit.components,
      },
      // Два ответа на «где лежит», и они намеренно раздельные: cells1c —
      // что говорит учёт владельца, locations — что Аргус видел своими
      // глазами. Схлопывать их в один список нельзя: разошлись — значит
      // товар переставили и не записали, и это нужно заметить, а не спрятать.
      cells1c: cells1c.rows.map((r) => ({
        cell: r.cell_name,
        qty: r.qty === null || r.qty === undefined ? null : Number(r.qty),
      })),
      locations: stock.rows.map((r) => ({
        row: r.row_num,
        label: formatBlockLabel(r.row_num, r),
        rackFrom: r.rack_start, rackTo: r.rack_end,
        tierFrom: r.tier_start, tierTo: r.tier_end,
        qty: Number(r.qty),
        state: qualityName[r.quality] || r.quality,
      })),
    });
  }
  return results;
}

// formatBlockLabel переехала в ../cells/label — её же печатает лист комплектации.

// Подсказка ячейки при приёмке — чистое правило, без ИИ: сначала предложить
// ячейку, где этот SKU уже лежит (не размазывать один товар по складу),
// потом — просто свободную. Про габариты (влезет/не влезет) правила пока
// нет — у товаров почти всегда пустые размеры (см. argus_1c_sync_status),
// добавится само, когда данные появятся.
async function suggestCells(client, warehouseId, sku, companyId = null, limit = 3, opts = {}) {
  const options = [];
  // Склад продавца (02.10.2026): известен — подсказка не смешивает товар со
  // складом «хранить отдельно» и ведёт в зону склада, пока в ней есть пустая
  // ячейка; зона заполнена — рядом. Закреплённые за складами ячейки другим
  // не предлагаем.
  const separate = require('../vwarehouses/separate');
  const vwKnown = opts.vw !== undefined;
  const vw = opts.vw || null;
  const lay = companyId ? await separate.layout(client, companyId) : null;
  const zone = vwKnown && vw && lay ? lay.zone.get(vw) : null;

  // 1. Тот же артикул. Не размазывать один товар по складу — работник идёт за
  //    ним в одно место, а не собирает по всему залу. Когда продавец известен —
  //    только его товар: тот же код у другого продавца — другой товар, и
  //    класть к нему значит смешать чужое (проверка 25.09.2026).
  const sameSku = await client.query(
    `SELECT DISTINCT cb.id, wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
     FROM cell_stock cs
     JOIN cell_blocks cb ON cb.id = cs.cell_block_id
     JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
     WHERE cs.warehouse_id = $1 AND cs.sku = $2 AND cs.quality = 'good'
       AND ($4::uuid IS NULL OR cs.company_id = $4)
     ORDER BY wr.row_num, cb.rack_start, cb.tier_start
     LIMIT $3`,
    [warehouseId, sku, limit, companyId || null],
  );
  for (const b of sameSku.rows) {
    if (lay && lay.any && (vwKnown || lay.zone.size)
        && await separate.conflict(client, { cellBlockId: b.id, companyId, vw, quality: 'good' }, lay)) continue;
    options.push({ blockId: b.id, label: formatBlockLabel(b.row_num, b), reason: 'same_sku' });
  }

  // 1½. Зона склада: пустые ячейки зоны. Пока они есть — только туда.
  if (zone && zone.size && options.length < limit) {
    const inZone = (await client.query(
      `SELECT cb.id, wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
         FROM cell_blocks cb JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
        WHERE cb.id = ANY($1::uuid[]) AND cb.id <> ALL($3::uuid[])
          AND NOT EXISTS (SELECT 1 FROM cell_stock cs WHERE cs.cell_block_id = cb.id AND cs.qty > 0)
        ORDER BY wr.row_num, cb.rack_start, cb.tier_start LIMIT $2`,
      [[...zone], limit - options.length, options.map((o) => o.blockId)])).rows;
    for (const b of inZone) options.push({ blockId: b.id, label: formatBlockLabel(b.row_num, b), reason: 'vw_zone' });
    if (inZone.length) return options;
  }
  const zoneFull = !!(zone && zone.size);

  // 2. Свободная ячейка ТАМ, ГДЕ УЖЕ ЛЕЖИТ ТОВАР ЭТОГО ПРОДАВЦА.
  //
  //    Аргус приходит на склад, который год работал по своему порядку: у
  //    продавцов сложились свои ряды, и часто по причинам, которых в базе нет.
  //    Поэтому сначала повторяем чужой порядок и только потом предлагаем свой.
  //    Ряды считаем по тому, где у этого продавца больше всего занятых ячеек, —
  //    это и есть его зона, как её видит склад, а не как её придумали мы.
  if (companyId && options.length < limit) {
    const nearCompany = await client.query(
      `WITH company_rows AS (
         SELECT wr.id AS row_id, COUNT(DISTINCT cs.cell_block_id) AS cells
         FROM cell_stock cs
         JOIN cell_blocks cb ON cb.id = cs.cell_block_id
         JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
         WHERE cs.warehouse_id = $1 AND cs.company_id = $2
         GROUP BY wr.id
       )
       SELECT cb.id, wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
       FROM cell_blocks cb
       JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
       JOIN company_rows crw ON crw.row_id = wr.id
       WHERE cb.warehouse_id = $1 AND cb.state = 'empty' AND NOT cb.defect_zone AND cb.reserved_vw_id IS NULL
         AND cb.id <> ALL($4::uuid[])
       ORDER BY crw.cells DESC, wr.row_num, cb.rack_start, cb.tier_start
       LIMIT $3`,
      [warehouseId, companyId, limit - options.length, options.map((o) => o.blockId)],
    );
    for (const b of nearCompany.rows) {
      options.push({ blockId: b.id, label: formatBlockLabel(b.row_num, b), reason: zoneFull ? 'zone_full' : 'near_company' });
    }
  }

  // 3. Просто свободная. Запасной вариант: новый товар нового продавца, или
  //    склад, который начинает с нуля и своего порядка ещё не нажил.
  //    «Ячейки брака» (их отмечает руководитель) годному не предлагаем — ни
  //    здесь, ни в шаге 2: туда кладут брак (владелец 02.10.2026).
  if (options.length < limit) {
    const empty = await client.query(
      `SELECT cb.id, wr.row_num, cb.rack_start, cb.rack_end, cb.tier_start, cb.tier_end
       FROM cell_blocks cb
       JOIN warehouse_rows wr ON wr.id = cb.warehouse_row_id
       WHERE cb.warehouse_id = $1 AND cb.state = 'empty' AND NOT cb.defect_zone AND cb.reserved_vw_id IS NULL
         AND cb.id <> ALL($3::uuid[])
       ORDER BY wr.row_num, cb.rack_start, cb.tier_start
       LIMIT $2`,
      [warehouseId, limit - options.length, options.map((o) => o.blockId)],
    );
    for (const b of empty.rows) {
      options.push({ blockId: b.id, label: formatBlockLabel(b.row_num, b), reason: zoneFull ? 'zone_full' : 'empty' });
    }
  }

  return options;
}

// Запись подсказки в момент выдачи. Пересчитать её потом нельзя — склад к тому
// времени уже другой, — а без неё не узнать, соглашаются с ней или обходят.
async function recordSuggestion(client, warehouseId, { sku, companyId, workerKeyId, options }) {
  const result = await client.query(
    `INSERT INTO cell_suggestions (warehouse_id, company_id, sku, options, worker_key_id)
     VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
    [warehouseId, companyId || null, sku, JSON.stringify(options), workerKeyId || null],
  );
  return result.rows[0].id;
}

// Чем кончилось: какую ячейку работник выбрал на самом деле. Тихо ничего не
// делает, если ссылки на подсказку нет, — приёмка не должна падать из-за того,
// что у работника открыт старый экран.
async function recordSuggestionOutcome(client, warehouseId, suggestionId, chosenCellBlockId) {
  if (!suggestionId) return;
  await client.query(
    `UPDATE cell_suggestions
     SET chosen_cell_block_id = $3, decided_at = now()
     WHERE id = $1 AND warehouse_id = $2 AND decided_at IS NULL`,
    [suggestionId, warehouseId, chosenCellBlockId || null],
  );
}

// ---------------------------------------------------------------------------
// Ниже — остальная работа Кладовщика, которую он давно делает руками работника,
// но о которой до сих пор нельзя было его спросить. Всё те же правила и тот же
// SQL: агент не считает и не решает, он только пересказывает посчитанное.
// ---------------------------------------------------------------------------

const DIRECTION_LABEL = { in: 'приёмка', out: 'отгрузка', return: 'возврат' };
const STATUS_LABEL = {
  open: 'не начата',
  in_progress: 'в работе',
  completed: 'завершена',
  ready: 'собран',
  shipped: 'отгружен',
};

function invoiceStatusLabel(row) {
  // Заказ WB, который менеджер ещё не положил в поставку, — не «не начатая
  // отгрузка»: склад его и не должен начинать.
  if (row.status === 'open' && row.direction === 'out' && row.source !== '1c' && !row.supply_id && !row.mp_closed_at) {
    return 'заказан на WB, в поставку ещё не взят';
  }
  if (row.status === 'shipped') return row.mp_close_reason === 'canceled'
    ? 'отгружен со склада; позднее отменён на WB' : STATUS_LABEL.shipped;
  if (row.mp_stock_returned_at) return 'отменён на WB; товар возвращён в ячейки';
  if (row.mp_closed_at) return row.mp_close_reason === 'canceled'
    ? 'отменён на WB' : 'передан в доставку на WB; физическую отгрузку проверяет склад';
  return STATUS_LABEL[row.status] || row.status;
}

// «Что сейчас в работе», «какие возвраты приехали», «что вчера приняли».
// Незакрытые документы идут первыми: незавершённая работа важнее истории.
async function listInvoices(client, warehouseId, { direction, status, limit = 20 } = {}) {
  const result = await client.query(
    `SELECT i.number, i.direction, i.status, i.created_at, i.mp_closed_at, i.mp_close_reason, i.mp_stock_returned_at, c.name AS company_name,
            i.source, i.supply_id, (SELECT s.number FROM supplies s WHERE s.id = i.supply_id) AS supply_number,
            COUNT(ii.id)::int AS item_count
     FROM invoices i
     JOIN companies c ON c.id = i.company_id AND c.archived_at IS NULL
     LEFT JOIN invoice_items ii ON ii.invoice_id = i.id
     WHERE i.warehouse_id = $1
       AND ($2::invoice_direction IS NULL OR i.direction = $2::invoice_direction)
       AND ($3::invoice_status IS NULL OR i.status = $3::invoice_status)
       AND ($3::invoice_status IS NULL OR $3::invoice_status = 'shipped' OR i.mp_closed_at IS NULL)
       -- «Заказ поставщику» из 1С — заказ, а не привоз (как в списке грузчика).
       AND i.source_document_type IS DISTINCT FROM 'supplier_order'
     GROUP BY i.id, i.number, i.direction, i.status, i.created_at, c.name
     ORDER BY (i.status IN ('completed', 'shipped') OR i.mp_closed_at IS NOT NULL) ASC, i.created_at DESC
     LIMIT $4`,
    [warehouseId, direction || null, status || null, Math.min(limit, 50)],
  );
  return result.rows.map((r) => ({
    number: r.number,
    kind: DIRECTION_LABEL[r.direction] || r.direction,
    status: invoiceStatusLabel(r),
    company: r.company_name,
    ...(r.supply_number ? { supply: r.supply_number } : {}),
    itemCount: r.item_count,
    createdAt: r.created_at,
  }));
}

// «Что в накладной такой-то» — человек называет номер, не идентификатор.
// Для каждого направления показываем то, что для него имеет смысл: у приёмки
// принятое количество, у отгрузки собранное, у возврата — разбор по состоянию.
async function invoiceDetails(client, warehouseId, number) {
  const inv = await client.query(
    `SELECT i.id, i.number, i.direction, i.status, i.created_at, i.mp_closed_at, i.mp_close_reason, i.mp_stock_returned_at, c.name AS company_name,
            i.source, i.supply_id
     FROM invoices i JOIN companies c ON c.id = i.company_id AND c.archived_at IS NULL
     WHERE i.warehouse_id = $1 AND upper(i.number) = upper($2)
     ORDER BY i.created_at DESC LIMIT 1`,
    [warehouseId, number],
  );
  if (!inv.rows[0]) return null;
  const doc = inv.rows[0];

  const items = await client.query(
    `SELECT ii.id, ii.name, ii.sku, ii.declared_qty,
            (SELECT SUM(rr.accepted_qty) FROM receiving_records rr WHERE rr.invoice_item_id = ii.id) AS accepted,
            (SELECT SUM(sr.picked_qty) FROM shipping_records sr WHERE sr.invoice_item_id = ii.id) AS picked,
            (SELECT json_agg(json_build_object('bucket', ret.quality_bucket, 'qty', ret.qty,
                                               'defectNote', ret.defect_note))
               FROM return_records ret WHERE ret.invoice_item_id = ii.id) AS buckets
     FROM invoice_items ii
     WHERE ii.invoice_id = $1
     ORDER BY ii.name`,
    [doc.id],
  );

  const bucketLabel = { good: 'хороший', defective: 'брак', packaging_defect: 'брак упаковки' };
  return {
    number: doc.number,
    kind: DIRECTION_LABEL[doc.direction] || doc.direction,
    status: invoiceStatusLabel(doc),
    company: doc.company_name,
    items: items.rows.map((it) => {
      const row = { name: it.name, sku: it.sku, declaredQty: Number(it.declared_qty) };
      if (doc.direction === 'in') row.acceptedQty = it.accepted === null ? null : Number(it.accepted);
      if (doc.direction === 'out') row.pickedQty = it.picked === null ? null : Number(it.picked);
      if (doc.direction === 'return') {
        row.sorted = (it.buckets || []).map((b) => ({
          state: bucketLabel[b.bucket] || b.bucket,
          qty: Number(b.qty),
          // Причина брака — то, ради чего продавец вообще смотрит в возврат:
          // по ней он решает, вернуть товар себе или утилизировать.
          defect: b.defectNote || null,
        }));
      }
      return row;
    }),
  };
}

// Что склад ждёт сделать — как это видит грузчик в своих списках (одно
// правило для утренней сводки, чата и экрана грузчика, разбор 02.10.2026):
// сборка — заказы, которые менеджер положил в поставку, и отгрузки из 1С,
// а не все заказы WB; приёмка — привозы, без «заказов поставщику» из 1С
// (это заказ, а не привоз); возвраты — неразобранные; задания склада брака.
async function workQueue(client, warehouseId) {
  const r = await client.query(
    `SELECT
       (SELECT COUNT(DISTINCT i.supply_id)::int FROM invoices i JOIN supplies s ON s.id = i.supply_id
         WHERE i.warehouse_id = $1 AND s.status = 'collecting' AND i.direction = 'out'
           AND i.status IN ('open', 'in_progress') AND i.mp_closed_at IS NULL) AS supplies_to_pick,
       (SELECT COUNT(*)::int FROM invoices i JOIN supplies s ON s.id = i.supply_id
         WHERE i.warehouse_id = $1 AND s.status = 'collecting' AND i.direction = 'out'
           AND i.status IN ('open', 'in_progress') AND i.mp_closed_at IS NULL) AS orders_to_pick,
       (SELECT COUNT(*)::int FROM invoices i
         WHERE i.warehouse_id = $1 AND i.direction = 'out' AND i.source = '1c' AND i.supply_id IS NULL
           AND i.status IN ('open', 'in_progress') AND i.mp_closed_at IS NULL) AS onec_to_pick,
       (SELECT COUNT(*)::int FROM supplies s WHERE s.warehouse_id = $1 AND s.status = 'ready') AS supplies_ready,
       (SELECT COUNT(*)::int FROM invoices i
         WHERE i.warehouse_id = $1 AND i.direction = 'in' AND i.status IN ('open', 'in_progress')
           AND i.source_document_type IS DISTINCT FROM 'supplier_order') AS to_receive,
       (SELECT COUNT(*)::int FROM invoices i
         WHERE i.warehouse_id = $1 AND i.direction = 'in' AND i.status IN ('open', 'in_progress')
           AND i.source_document_type IS DISTINCT FROM 'supplier_order' AND i.arrived_at IS NOT NULL) AS arrived,
       (SELECT COUNT(*)::int FROM invoices i
         WHERE i.warehouse_id = $1 AND i.direction = 'return' AND i.status IN ('open', 'in_progress')) AS to_sort,
       (SELECT COUNT(*)::int FROM defect_decisions d
         WHERE d.warehouse_id = $1 AND d.status = 'pending') AS defect_tasks`,
    [warehouseId],
  );
  const w = r.rows[0];
  return {
    suppliesToPick: w.supplies_to_pick, ordersToPick: w.orders_to_pick, onecToPick: w.onec_to_pick,
    suppliesReady: w.supplies_ready, toReceive: w.to_receive, arrived: w.arrived,
    returnsToSort: w.to_sort, defectTasks: w.defect_tasks,
  };
}

// «Насколько склад полон», «сколько свободных ячеек», «сколько всего брака».
// Один запрос на каждую цифру — считает база, не агент.
async function warehouseSummary(client, warehouseId) {
  const cells = await client.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE state = 'occupied')::int AS occupied
     FROM cell_blocks WHERE warehouse_id = $1`,
    [warehouseId],
  );
  const stock = await client.query(
    `SELECT COUNT(DISTINCT sku)::int AS skus, COALESCE(SUM(qty), 0) AS units
     FROM cell_stock WHERE warehouse_id = $1`,
    [warehouseId],
  );
  // Сколько лежит В КАКОМ состоянии — это про сейчас, в отличие от разбора
  // возвратов ниже, который про историю. Владельцу нужны обе цифры: «сколько
  // брака приехало за всё время» и «сколько брака занимает полки прямо
  // сейчас» — это разные вопросы.
  const byQuality = await client.query(
    `SELECT quality, COALESCE(SUM(qty), 0) AS qty
     FROM cell_stock WHERE warehouse_id = $1 AND qty > 0
     GROUP BY quality`,
    [warehouseId],
  );
  const returns = await client.query(
    `SELECT quality_bucket, COALESCE(SUM(qty), 0) AS qty
     FROM return_records WHERE warehouse_id = $1
     GROUP BY quality_bucket`,
    [warehouseId],
  );
  // «Незакрытых документов 1358» ничего не говорило: туда попадали все
  // заказы WB и заказы поставщику из 1С. Теперь — работа, как у грузчика.
  const work = await workQueue(client, warehouseId);

  const bucketLabel = { good: 'хороший', defective: 'брак', packaging_defect: 'брак упаковки' };
  const c = cells.rows[0];
  return {
    cellsTotal: c.total,
    cellsOccupied: c.occupied,
    cellsFree: c.total - c.occupied,
    averageFillOfOccupiedPct: null,
    capacityKnown: false,
    capacityNote: 'Вместимость ячеек не задана. Число занятых ячеек не показывает заполненность по объёму или весу.',
    distinctSkus: stock.rows[0].skus,
    totalUnits: Number(stock.rows[0].units),
    onShelvesByState: byQuality.rows.map((r) => ({
      state: bucketLabel[r.quality] || r.quality, qty: Number(r.qty),
    })),
    work,
    returned: returns.rows.map((r) => ({
      state: bucketLabel[r.quality_bucket] || r.quality_bucket, qty: Number(r.qty),
    })),
  };
}

// «Что ждёт моего решения» — расхождения, записки грузчиков, «нет товара».
// Журнал только на чтение: подтверждать и откатывать можно в кабинете, где
// видно всю карточку, а не одной фразой в чате. Журнал ничего не стирает:
// ответ — новая запись со ссылкой на исходную, а исходная навсегда
// «pending». Поэтому ждущая — та, на которую никто не ответил (как в
// напоминании alerts/rules.js); раньше чат показывал и решённое.
async function listDiscrepancies(client, warehouseId, { limit = 15 } = {}) {
  const result = await client.query(
    `SELECT je.action_text, je.created_at, je.agent
     FROM journal_entries je
     WHERE je.warehouse_id = $1 AND je.status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM journal_entries a WHERE a.related_entry_id = je.id)
     ORDER BY je.created_at DESC
     LIMIT $2`,
    [warehouseId, Math.min(limit, 50)],
  );
  return result.rows.map((r) => ({
    what: r.action_text, agent: r.agent, at: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Поставки и «что на складе сейчас» (разбор Кладовщика 02.10.2026, вариант
// владельца «а»): четыре новых умения в двух инструментах, чтобы вопрос не
// подорожал. Считают те же функции, что экраны: список и состав поставки —
// supplies/service.js, ход сборки и приёмки — work/sessions.js, склад брака —
// defects/service.js. Свой SQL здесь только там, где готового нет.
// ---------------------------------------------------------------------------

const ASSEMBLY_MODE = { app: 'в приложении', paper: 'по бумажному листу' };

// Кто ведёт работу по документу и где она сейчас.
function workView(st, unit) {
  if (!st) return {};
  const a = st.assembly;
  const live = a && (a.status === 'active' || a.status === 'paused');
  return {
    ...(live ? {
      who: a.workerName,
      status: a.status === 'paused' ? 'на паузе' : 'идёт',
      ...(a.status === 'paused' && a.pauseReason ? { pauseReason: a.pauseReason } : {}),
      ...(a.mode && ASSEMBLY_MODE[a.mode] && unit === 'шт.' ? { how: ASSEMBLY_MODE[a.mode] } : {}),
      workedMinutes: Math.round(a.workMs / 60000),
    } : {}),
    ...(st.total ? { done: `${st.taken} из ${st.total} ${unit}` } : {}),
    ...(st.lastComment ? { comment: st.lastComment.text } : {}),
  };
}

// «Что с поставкой ПС-…», «что сейчас собирают», «что готово к отгрузке».
async function suppliesInfo(client, warehouseId, number) {
  const supplies = require('../supplies/service');
  const assembly = require('../shipping/assembly');
  const wanted = String(number || '').trim();
  if (wanted) {
    const row = (await client.query(
      'SELECT id FROM supplies WHERE warehouse_id = $1 AND upper(number) = upper($2) LIMIT 1',
      [warehouseId, wanted])).rows[0];
    if (!row) return null;
    const c = await supplies.contents(client, warehouseId, row.id, { showShortages: true });
    const st = (await assembly.statesFor(client, warehouseId, [row.id])).get(row.id);
    const s = c.supply;
    return {
      number: s.number,
      seller: s.companyName,
      status: s.statusName,
      destination: s.destination || null,
      shipDate: s.shipDate || null,
      orders: c.totals.orders,
      units: c.totals.units,
      assembly: workView(st, 'шт.'),
      // Что ещё взять со склада — по обходу, из каких ячеек и сколько.
      toTake: c.picking.map((p) => ({
        sku: p.sku,
        name: p.name,
        left: p.qty,
        cells: p.cells.filter((x) => x.take > 0).map((x) => ({ cell: x.label, take: x.take })),
        ...(p.available < p.qty ? { notInCells: p.qty - p.available } : {}),
      })),
      // «Нет товара» от грузчика, руководитель ещё не решил.
      notFound: c.shortages.map((x) => x.text),
    };
  }
  const rows = await supplies.list(client, warehouseId, { showShortages: true, recentOnly: true });
  const order = { collecting: 0, ready: 1, shipped: 2 };
  rows.sort((a, b) => order[a.status] - order[b.status] || new Date(b.created_at) - new Date(a.created_at));
  const shown = rows.filter((r) => r.status !== 'shipped').concat(rows.filter((r) => r.status === 'shipped').slice(0, 5)).slice(0, 25);
  const states = await assembly.statesFor(client, warehouseId, shown.filter((r) => r.status === 'collecting').map((r) => r.id));
  return {
    collecting: rows.filter((r) => r.status === 'collecting').length,
    ready: rows.filter((r) => r.status === 'ready').length,
    shippedLast2Weeks: rows.filter((r) => r.status === 'shipped').length,
    supplies: shown.map((r) => ({
      number: r.number,
      seller: r.company_name,
      status: r.statusName,
      destination: r.destination || null,
      shipDate: r.ship_date || null,
      orders: r.orders,
      ordersPicked: r.picked,
      ...(r.missing ? { notFoundMarks: r.missing } : {}),
      ...(r.stockShort ? { ordersWithoutStock: r.stockShort } : {}),
      ...(r.status === 'collecting' ? { assembly: workView(states.get(r.id), 'шт.') } : {}),
      ...(r.status === 'ready' && r.ready_at ? { readyAt: r.ready_at } : {}),
      ...(r.status === 'shipped' && r.shipped_at ? { shippedAt: r.shipped_at } : {}),
    })),
  };
}

// «Кто что делает», «что привезут сегодня», «сколько брака ждёт решения».
async function workNow(client, warehouseId) {
  const assembly = require('../shipping/assembly');
  const receiving = require('../receiving/session');
  const defects = require('../defects/service');
  const { zoneOf, todayIn } = require('../warehouses/time');
  const today = todayIn(await zoneOf(client, warehouseId));

  // Люди: живые заходы — идёт или на паузе.
  const live = (await client.query(
    `SELECT w.kind, w.supply_id, w.invoice_id, s.number AS supply_number, i.number AS invoice_number
       FROM work_sessions w
       LEFT JOIN supplies s ON s.id = w.supply_id
       LEFT JOIN invoices i ON i.id = w.invoice_id
      WHERE w.warehouse_id = $1 AND w.status IN ('active', 'paused')
      ORDER BY w.started_at`, [warehouseId])).rows;

  // Привозы: открытые приходы, кроме «заказов поставщику» из 1С — это заказ,
  // а не машина (как в списке грузчика).
  const arrivals = (await client.query(
    `SELECT i.id, i.number, c.name AS seller, i.source_document_type, i.external_id, i.status,
            left(i.source_document_date::text, 10) AS planned_date,
            to_char(i.planned_from, 'HH24:MI') AS slot_from, to_char(i.planned_to, 'HH24:MI') AS slot_to,
            i.carrier, i.vehicle, i.boxes, i.pallets, i.arrived_at
       FROM invoices i JOIN companies c ON c.id = i.company_id AND c.archived_at IS NULL
      WHERE i.warehouse_id = $1 AND i.direction = 'in' AND i.status IN ('open', 'in_progress')
        AND i.source_document_type IS DISTINCT FROM 'supplier_order'
      ORDER BY (i.arrived_at IS NULL), i.source_document_date NULLS LAST, i.created_at
      LIMIT 20`, [warehouseId])).rows;

  const asm = await assembly.statesFor(client, warehouseId, live.filter((r) => r.kind === 'assembly').map((r) => r.supply_id));
  const rec = await receiving.statesFor(client, warehouseId,
    live.filter((r) => r.kind === 'receiving').map((r) => r.invoice_id).concat(arrivals.map((a) => a.id)));

  const day = (d) => d.split('-').reverse().slice(0, 2).join('.');
  const arrivalState = (a, work) => {
    if (work.who) return 'принимается';
    if (a.status === 'in_progress') return 'приёмка начата';
    if (a.arrived_at) return 'машина приехала, приёмку не начали';
    if (!a.planned_date) return 'ждёт приёмки';
    if (a.planned_date < today) return `ждали ${day(a.planned_date)}, машина не приехала`;
    if (a.planned_date === today) return 'ждём сегодня';
    return `ждём ${day(a.planned_date)}`;
  };

  const vw = await vwReminders(client, warehouseId);
  const tasks = (await client.query(
    `SELECT action, count(*)::int AS n, SUM(qty)::int AS units FROM defect_decisions
      WHERE warehouse_id = $1 AND status = 'pending' GROUP BY action ORDER BY action`, [warehouseId])).rows;
  const TASK = { return_to_seller: 'выдать продавцу', dispose: 'утилизировать', repack: 'перепаковать', markdown: 'переклеить на уценку' };

  return {
    today,
    people: live.map((r) => {
      const st = r.kind === 'assembly' ? asm.get(r.supply_id) : rec.get(r.invoice_id);
      return {
        doing: r.kind === 'assembly' ? `сборка поставки ${r.supply_number}` : `приёмка прихода ${r.invoice_number}`,
        ...workView(st, r.kind === 'assembly' ? 'шт.' : 'позиций'),
      };
    }),
    arrivals: arrivals.map((a) => {
      const work = workView(rec.get(a.id), 'позиций');
      return {
        number: a.number,
        seller: a.seller,
        from: a.source_document_type === 'seller_inbound' ? 'привоз продавца' : a.external_id ? 'приход из 1С' : 'заведён вручную',
        state: arrivalState(a, work),
        ...(a.planned_date ? { plannedDate: a.planned_date } : {}),
        ...(a.slot_from || a.slot_to ? { unloadWindow: [a.slot_from, a.slot_to].filter(Boolean).join('–') } : {}),
        ...(a.carrier ? { carrier: a.carrier } : {}),
        ...(a.vehicle ? { vehicle: a.vehicle } : {}),
        ...(a.boxes ? { boxes: a.boxes } : {}),
        ...(a.pallets ? { pallets: a.pallets } : {}),
        ...(a.arrived_at ? { arrivedAt: a.arrived_at } : {}),
        ...(work.who ? { receiving: work } : work.done ? { done: work.done } : {}),
      };
    }),
    // Склад брака: сколько брака у каждого продавца ещё никто не решил и
    // какие решения ждут грузчика.
    defect: {
      waitingDecision: (await defects.waitingBySeller(client, warehouseId)).map((w) => ({
        seller: w.seller, qty: w.qty, since: w.since,
      })),
      tasks: tasks.map((t) => ({ action: TASK[t.action] || t.action, count: t.n, units: t.units })),
    },
    ...(vw ? { sellerWarehouses: vw } : {}),
  };
}

// Склады продавцов — что ждёт (владелец 02.10.2026): заявки продавцов на
// перенос, переносы и решения, которые ждут продавца, заполненные зоны с
// привозом, задания «переложить». null — руководитель выключил напоминания
// или ждать нечего.
async function vwReminders(client, warehouseId) {
  const on = (await client.query('SELECT vw_reminders FROM warehouses WHERE id = $1', [warehouseId])).rows[0];
  if (!on || on.vw_reminders === false) return null;
  const separate = require('../vwarehouses/separate');
  const requests = (await client.query(
    `SELECT t.number, c.name AS seller, t.name, t.qty, t.requested_at FROM vw_transfers t JOIN companies c ON c.id = t.company_id
      WHERE t.warehouse_id = $1 AND t.status = 'requested' ORDER BY t.requested_at LIMIT 10`, [warehouseId])).rows;
  const n = (await client.query(
    `SELECT (SELECT count(*)::int FROM vw_transfers WHERE warehouse_id = $1 AND status = 'waiting_seller') AS consent,
            (SELECT count(*)::int FROM vw_decisions WHERE warehouse_id = $1 AND status = 'pending') AS decisions,
            (SELECT count(*)::int FROM vw_move_tasks WHERE warehouse_id = $1 AND status = 'open') AS move_tasks`,
    [warehouseId])).rows[0];
  const zones = await separate.fullZones(client, warehouseId);
  const incoming = zones.length ? (await client.query(
    `SELECT ii.virtual_warehouse_id AS vw, SUM(ii.declared_qty)::int AS qty, MIN(left(i.source_document_date::text, 10)) AS day
       FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
      WHERE i.warehouse_id = $1 AND i.direction = 'in' AND i.status = 'open' AND ii.virtual_warehouse_id = ANY($2::uuid[])
      GROUP BY 1`, [warehouseId, zones.map((z) => z.id)])).rows : [];
  const out = {
    sellerRequests: requests.map((r) => ({ number: r.number, seller: r.seller, product: r.name, qty: Number(r.qty), since: r.requested_at })),
    waitingSellerConsent: n.consent,
    waitingSellerDecision: n.decisions,
    moveTasks: n.move_tasks,
    fullZones: zones.map((z) => {
      const inc = incoming.find((x) => x.vw === z.id);
      return { seller: z.seller, warehouse: z.name, cells: z.cells, ...(inc ? { incoming: inc.qty, incomingDay: inc.day } : {}) };
    }),
  };
  const empty = !out.sellerRequests.length && !out.waitingSellerConsent && !out.waitingSellerDecision && !out.moveTasks && !out.fullZones.length;
  return empty ? null : out;
}

// «Сколько у Слим Тим», «у кого не хватает товара под заказы» — остатки
// продавцов теми же числами, что в их кабинетах и в сводке владельца
// «Остатки продавцов» (02.10.2026). Без имени — сводка по всем; с именем —
// итог продавца и товары, которым остатка не хватает под заказы.
async function sellerStock(client, warehouseId, seller) {
  const all = await stockBySeller(client, warehouseId);
  const brief = (s) => ({
    seller: s.name, products: s.productCount, total: s.total, ordered: s.ordered, inAssembly: s.inAssembly,
    inTransit: s.inTransit, available: s.available, defect: s.defect, shortageProducts: s.shortageCount,
    ...(s.unknownCount ? { withoutStockNumber: s.unknownCount } : {}),
    ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
  });
  const wanted = String(seller || '').trim().toLowerCase();
  if (!wanted) return { sellers: all.sellers.map(brief) };
  const found = all.sellers.filter((s) => s.name.toLowerCase().includes(wanted));
  if (found.length !== 1) {
    return { notFound: !found.length, choose: (found.length ? found : all.sellers).map((s) => s.name) };
  }
  const s = found[0];
  const rows = (await loadStock(client, s.companyId, { source: all.source })).filter((r) => r.listed);
  // Склады продавца (02.10.2026): итог по каждому и товары, что лежат не на
  // «Основном».
  const split = rows.filter((r) => r.byWarehouse);
  const warehouses = split.length ? split[0].byWarehouse.map((w, k) => ({
    warehouse: w.name,
    onHand: split.reduce((n, r) => n + Number(r.byWarehouse[k].onHand || 0), 0),
    inAssembly: split.reduce((n, r) => n + Number(r.byWarehouse[k].inAssembly || 0), 0),
    available: split.reduce((n, r) => n + Number(r.byWarehouse[k].available || 0), 0),
    defect: split.reduce((n, r) => n + Number(r.byWarehouse[k].defect || 0), 0),
  })) : null;
  return {
    ...brief(s),
    ...(warehouses ? {
      warehouses,
      productsByWarehouse: split.filter((r) => r.byWarehouse.some((w) => w.id && w.onHand)).slice(0, 30).map((r) => ({
        sku: r.sku, name: r.name,
        split: Object.fromEntries(r.byWarehouse.filter((w) => w.onHand).map((w) => [w.name, w.onHand])),
      })),
    } : {}),
    shortages: rows.filter((r) => r.shortage).slice(0, 20).map((r) => ({
      sku: r.sku, name: r.name, total: r.total, ordered: r.orderedNotInSupply, inAssembly: r.inAssembly,
    })),
    defectProducts: rows.filter((r) => r.defective + r.packagingDefect > 0).slice(0, 10).map((r) => ({
      sku: r.sku, name: r.name, defect: r.defective + r.packagingDefect,
    })),
  };
}

// Единственное место, где имя инструмента превращается в вызов. Модель называет
// имя и аргументы, а что выполнится — решает эта таблица: имя не из списка
// просто не выполняется. Транзакцию открывает вызывающий (см. routes.js) —
// здесь только раздача, чтобы одно и то же поведение проверялось тестами и
// работало на проде.
const DIRECTIONS = new Set(['in', 'out', 'return']);
const STATUSES = new Set(['open', 'in_progress', 'completed', 'ready', 'shipped']);
// Значения приходят от языковой модели. Чужое слово в поле-перечислении
// роняло запрос пятисоткой — проверяем по списку и просто игнорируем лишнее.
const oneOf = (set, value) => (set.has(value) ? value : undefined);

function runTool(client, warehouseId, name, args = {}) {
  switch (name) {
    case 'find_products':
      return findProducts(client, warehouseId, String(args.query || ''));
    case 'list_invoices':
      return listInvoices(client, warehouseId, {
        direction: oneOf(DIRECTIONS, args.direction), status: oneOf(STATUSES, args.status),
      });
    case 'invoice_details':
      return invoiceDetails(client, warehouseId, String(args.number || ''));
    case 'warehouse_summary':
      return warehouseSummary(client, warehouseId);
    case 'supplies':
      return suppliesInfo(client, warehouseId, args.number);
    case 'work_now':
      return workNow(client, warehouseId);
    case 'seller_stock':
      return sellerStock(client, warehouseId, args.seller);
    case 'list_discrepancies':
      return listDiscrepancies(client, warehouseId, {});
    default:
      return Promise.resolve({ error: 'неизвестный инструмент' });
  }
}

module.exports = {
  parseCellAddress, cellContents,
  findProducts, suggestCells, listInvoices, invoiceDetails, warehouseSummary, workQueue, vwReminders,
  listDiscrepancies, suppliesInfo, workNow, sellerStock, runTool, recordSuggestion, recordSuggestionOutcome,
};
