# Проверка остатков и скорости — ход работы (01–02.10)

Если начинаешь заново — читай этот файл и продолжай с места остановки.
Запуск теста: `bash /c/Users/tatar/Desktop/argus-handoff/stand/runt.sh <суффикс> test/attack-stock-0110/<файл>`

Лог: argus-handoff/stand/logs/runt/<имя>.log.

## Сделано (всё записано в REPORT.md)
- Код прочитан: src/sellers/stock.js, routes.js, export.js, marketplaces/statuses.js, sync.js, sellerWarehouses.js,
  mapping.js, reconciliation.js, supplies/service.js, sync/service.js, cells/fill.js; сайт: seller-cabinet.js, cabinet_main.js.
- Общие шаги: _flow.js (склад, приход, 1С, обмен WB, поставка, отбор, отгрузка); объём для замеров: _perf.js (generate_series).
- Находки (тест падает, код 1):
  1. transit-never-clears-e2e.js — «В пути» не уменьшается после приёмки WB.
  2. onec-shipped-after-snapshot-e2e.js — учёт 1С: после отгрузки «Доступно» завышено до нового числа 1С.
  3. wb-checkbox-brings-back-closed-orders-e2e.js — галочка «наш» возвращает 1200 закрытых заказов, «Доступно» 0.
  4. perf-stock-screen-e2e.js — /api/sellers/stock 29–30 с (3000 товаров); на базе замеров 130 с (12 000 товаров).
  5. perf-warehouse-map-e2e.js — карта склада /api/cells/rows 26,7 с.
  6. export-ignores-argus-accounting-e2e.js — /export/1c при учёте в Аргусе отказывает (422).
  7. wb-stock-lost-after-late-mapping-e2e.js — «На WB» приписан артикулу WB, у товара пусто.
- Сверка (должна проходить): ok-counting-sanity-e2e.js — 11/11.
- Замеры на базе argus_seller_test_perf0110 (10 складов, 500 продавцов, 1,5 млн заказов): perf-measure-0110.txt;
  обмен 1С 26 700 товаров — 14 с (в порядке). База замеров УДАЛЕНА 02.10.
- REPORT.md: итог, 7 находок, таблица скорости, «в порядке», «нужно решение владельца», «замечено без теста».

## Финальный прогон (02.10)
- runt.sh all, все 8 файлов: 7 находок падают (нарушения, код 1), сверка 11/11 проходит. Работа закончена.

## Не сделано (если будет время)
- Экранные тесты (Playwright) — не делал: числа экрана берутся из API без пересчёта, сверял по коду.
- Колонка «По 1С» у владельца при учёте в Аргусе — без теста (в REPORT, «замечено»).
- Наборы (kits) и их составляющие в «Доступно» — не проверял.
