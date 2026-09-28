// Категория записи журнала (задание 28.09.2026, п. 3): у каждой записи —
// вид, по которому кабинет рисует значок, цвет и подпись и по которому
// фильтрует ленту. Определяется здесь, одним правилом для всех складов, по
// полям записи — не по тексту: текст записи меняется, поля — нет.
//
// Порядок — порядок чипов фильтра в кабинете.
const CATEGORIES = [
  ['inbound', 'Приходы'],          // привоз продавца, машина, документы, акт приёмки
  ['labor', 'Сборка'],             // работа грузчиков руками: приёмка, сборка, возврат, «нет товара», записки
  ['supplies', 'Поставки'],        // что делают менеджеры: составлена, разобрана, уехала
  ['orders', 'Заказы с маркетплейсов'],
  ['wb', 'Обмен с WB'],
  ['onec', 'Обмен с 1С'],
  ['docs', 'Акты и документы'],
  ['cells', 'Склад и ячейки'],     // перестановка, загрузка и сверка остатков, укладки
  ['staff', 'Сотрудники'],         // ключи, вход, паузы вне работы
  ['agent', 'Кладовщик'],          // сообщения агента и всё, что не подошло выше
];

const WORK_TYPES = new Set(['receiving_session', 'supply_assembly', 'paper_pick', 'item_note']);
const CELL_TYPES = new Set(['cell_block', 'company', 'stock_operation', 'receiving_placement', 'inventory']);
const STAFF_TYPES = new Set(['worker_pause', 'staff_key']);
const DOC_TYPES = new Set(['act', 'document']);

// e — строка listEntries: agent, entity_type, actor_type, work_key,
// invoice_direction (документ записи) и entity_direction (документ, на
// который запись ссылается как на сущность: «отменил привоз» без invoice_id).
function categoryOf(e) {
  const type = e.entity_type;
  if (e.agent === 'Обмен с 1С') return 'onec';
  if (e.agent === 'Обмен с WB' || e.agent === 'Сверка заказов WB') return type === 'supply' ? 'wb' : 'orders';
  // Сам приход (машина приехала, документы, переписка) — «Приходы», кто бы
  // ни нажал: «машину» у ворот отмечает и грузчик (проверка 28.09.2026).
  const inbound = (e.invoice_direction || e.entity_direction) === 'in';
  if ((type === 'invoice' || type === 'invoice_comment') && inbound) return 'inbound';
  // Всё, что входит в работу грузчика (приход, поставка, возврат, заказ), —
  // одной категорией с самой работой: в ленте это одна строка.
  if (e.work_key || WORK_TYPES.has(type)) return 'labor';
  if (type === 'invoice_item' && e.actor_type === 'worker') return 'labor';
  if (CELL_TYPES.has(type)) return 'cells';
  if (STAFF_TYPES.has(type)) return 'staff';
  if (DOC_TYPES.has(type)) return 'docs';
  if (type === 'supply') return 'supplies';
  if (type === 'invoice' || type === 'invoice_comment') {
    return (e.invoice_direction || e.entity_direction) === 'in' ? 'inbound' : 'orders';
  }
  return 'agent';
}

module.exports = { CATEGORIES, categoryOf };
