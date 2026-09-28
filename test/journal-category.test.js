// Категории журнала (задание 28.09.2026, п. 3): одно правило на сервере.
// Строки — те, что на самом деле пишут модули (см. createEntry по src/).
const test = require('node:test');
const assert = require('node:assert/strict');
const { categoryOf, CATEGORIES } = require('../src/journal/category');

const cases = [
  // Приходы: привоз продавца, машина, документы, акт, переписка.
  ['оформил привоз', { entity_type: 'invoice', invoice_direction: 'in', actor_type: 'seller' }, 'inbound'],
  ['отменил привоз (без invoice_id)', { entity_type: 'invoice', entity_direction: 'in', actor_type: 'owner' }, 'inbound'],
  ['переписка по приходу', { entity_type: 'invoice_comment', invoice_direction: 'in', actor_type: 'seller' }, 'inbound'],
  // Работа грузчиков.
  ['принял позицию', { entity_type: 'invoice_item', actor_type: 'worker', work_key: 'in:1', invoice_direction: 'in' }, 'labor'],
  ['закончил приёмку', { entity_type: 'receiving_session', actor_type: 'worker', work_key: 'in:1' }, 'labor'],
  ['собрал поставку', { entity_type: 'supply_assembly', actor_type: 'worker', work_key: 'supply:1' }, 'labor'],
  ['бумажный лист', { entity_type: 'paper_pick', actor_type: 'worker', work_key: 'supply:1' }, 'labor'],
  ['пауза в сборке', { entity_type: 'worker_pause', actor_type: 'worker', work_key: 'supply:1' }, 'labor'],
  ['записка о товаре', { entity_type: 'item_note', actor_type: 'worker', work_key: 'in:1' }, 'labor'],
  ['разобрал возврат', { entity_type: 'invoice_item', actor_type: 'worker', invoice_direction: 'return' }, 'labor'],
  ['ответ руководителя на расхождение', { entity_type: 'invoice_item', actor_type: 'owner', work_key: 'in:1' }, 'labor'],
  // Поставки — то, что делают менеджеры.
  ['составлена поставка', { entity_type: 'supply', actor_type: 'manager' }, 'supplies'],
  ['поставка разобрана сама', { entity_type: 'supply', actor_type: 'system' }, 'supplies'],
  // Заказы с маркетплейсов.
  ['статус заказа от WB', { agent: 'Обмен с WB', entity_type: 'invoice', invoice_direction: 'out' }, 'orders'],
  ['сверка заказов WB', { agent: 'Сверка заказов WB', entity_type: 'invoice', invoice_direction: 'out' }, 'orders'],
  ['заказ отгружен владельцем', { entity_type: 'invoice', invoice_direction: 'out', actor_type: 'owner' }, 'orders'],
  // Обмен с WB.
  ['поставка создана на WB', { agent: 'Обмен с WB', entity_type: 'supply', actor_type: 'system' }, 'wb'],
  // Обмен с 1С — по агенту, когда обмен начнёт писать в журнал.
  ['обмен с 1С', { agent: 'Обмен с 1С', entity_type: 'company' }, 'onec'],
  // Склад и ячейки.
  ['перестановка', { entity_type: 'cell_block', actor_type: 'worker' }, 'cells'],
  ['загрузка остатков', { entity_type: 'company', actor_type: 'owner' }, 'cells'],
  ['движение в истории ячейки', { entity_type: 'stock_operation', actor_type: 'worker' }, 'cells'],
  // Сотрудники.
  ['пауза вне работы', { entity_type: 'worker_pause', actor_type: 'worker' }, 'staff'],
  // Всё прочее — Кладовщик.
  ['заведён товар', { entity_type: 'product', actor_type: 'manager' }, 'agent'],
  ['новая, неизвестная запись', { entity_type: 'something_new' }, 'agent'],
];

test('категория журнала — по полям записи', () => {
  const keys = new Set(CATEGORIES.map(([k]) => k));
  assert.equal(keys.size, 10);
  for (const [label, row, want] of cases) {
    assert.equal(categoryOf({ agent: 'Кладовщик', ...row }), want, label);
    assert.ok(keys.has(want), label);
  }
});
