// Формат адреса ячейки — «ряд.стеллаж.ярус» (решение владельца 27.09.2026;
// до этого — «ряд.ярус.ячейка», решение 24.09). Инструкция ИИ-агенту обязана
// описывать адрес в том же порядке, в каком его печатает Аргус: иначе агент
// прочтёт «1.7.3» как ярус 7 стеллажа 3 и отправит работника не туда.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { formatBlockLabel } = require('../src/cells/label');
const { parseCellAddress } = require('../src/agents/kladovshchik');

test('адрес ячейки — ряд.стеллаж.ярус: 1.7.3 — ряд 1, стеллаж 7, ярус 3', () => {
  assert.equal(formatBlockLabel(1, { rack_start: 7, rack_end: 7, tier_start: 3, tier_end: 3 }), '1.7.3');
  // Объединённая ячейка: стеллажи 5–6, ярус 2.
  assert.equal(formatBlockLabel(2, { rack_start: 5, rack_end: 6, tier_start: 2, tier_end: 2 }), '2.5–6.2');
  // Кладовщик разбирает адрес обратно в том же порядке.
  assert.deepEqual(parseCellAddress('1.7.3'), { row: 1, rack: 7, tier: 3 });
  assert.deepEqual(parseCellAddress('2-120-4'), { row: 2, rack: 120, tier: 4 });
});

test('инструкция агенту описывает адрес в том же порядке, что его печатает Аргус', () => {
  const prompt = fs.readFileSync(path.join(__dirname, '../src/agents/orchestratorPrompt.js'), 'utf8');
  assert.ok(/ряд\.стеллаж\.ярус/.test(prompt), 'в инструкции агенту нет формата «ряд.стеллаж.ярус»');
  assert.ok(!/ряд\.ярус\.ячейка/.test(prompt),
    'orchestratorPrompt.js всё ещё велит читать адрес как ряд.ярус.ячейка — то есть «1.7.3» как ярус 7');
});
