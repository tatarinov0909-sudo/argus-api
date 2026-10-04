# Тесты рецензии 03.10.2026 (ChatGPT)

Каждая находка R01–R26 — отдельный тест, падавший на версии `fd551a7`. После
починки 04.10.2026 проходят все, кроме:

- `vw-parallel-moves-mix-separate-warehouses-e2e.js`,
  `return-parallel-final-lines-stay-open-e2e.js`,
  `inventory-parallel-runs-duplicate-tasks-e2e.js` — ручная синхронизация
  транзакций ждала их на позднем шаге; после починки второй запрос ждёт
  раньше, и тест не может «поймать» гонку. Вместо них —
  `*-simple-e2e.js` (проверено: без починки падают, с ней проходят).
- `supply-disband-during-wb-handoff-orphans-e2e.js` (R11) — отложено до
  включения записи в WB, копия в `test/deferred/`.
- `owner-controls-violate-formatting-e2e.js` (R20, R21) — оформление
  кабинета руководителя отложено решением владельца.

Запуск: `bash <argus-handoff>/stand/runt.sh <суффикс> test/review/<файл>`;
экранным тестам нужна копия сайта стенда на 127.0.0.1:8099.
Тест отката миграций (`attack-2809/migrations-2809-roundtrip-e2e.js`)
запускать на отдельной базе: откат справедливо отказывается, если в базе
есть частично выполненные решения по браку.
