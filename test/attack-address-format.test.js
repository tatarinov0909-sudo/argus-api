// К атаке 3: формат адреса ячейки после решения 24.09 («ряд.ярус.ячейка»)
// разошёлся не только с загрузкой остатков, но и с инструкцией ИИ-агенту:
// агенту по-прежнему сказано, что адрес — «ряд.стеллаж.ярус».
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { formatBlockLabel } = require('../src/cells/label');

test('инструкция агенту описывает адрес в том же порядке, что его печатает Аргус', () => {
  // Ряд 1, ярус 1, ячейка (стеллаж) 2.
  const label = formatBlockLabel(1, { rack_start: 2, rack_end: 2, tier_start: 1, tier_end: 1 });
  assert.equal(label, '1.1.2');
  const prompt = fs.readFileSync(path.join(__dirname, '../src/agents/orchestratorPrompt.js'), 'utf8');
  assert.ok(!/ряд\.стеллаж\.ярус/.test(prompt),
    'orchestratorPrompt.js велит агенту читать «1.1.2» как ряд.стеллаж.ярус — то есть как ярус 2 стеллажа 1');
});
