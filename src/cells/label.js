// Как называется ячейка на бумаге и в ответе агента.
//
// Одна функция на всех, потому что адрес, произнесённый Кладовщиком, и адрес,
// напечатанный в листе комплектации, обязаны совпадать буква в букву. Две
// копии этой логики разъедутся на первой же правке, и работник получит
// «01-10-015» в одном месте и «1.10.15» в другом.
function formatBlockLabel(rowNum, block) {
  // Если у ячейки есть собственное имя — оно и есть ответ. На стеллаже висит
  // «01-10-015», и назвать её «1.15.2» значит заставить работника переводить
  // наши координаты в то, что он видит глазами.
  if (block.label) return block.label;
  const rackPart = block.rack_start === block.rack_end
    ? block.rack_start : `${block.rack_start}–${block.rack_end}`;
  const tierPart = block.tier_start === block.tier_end
    ? block.tier_start : `${block.tier_start}–${block.tier_end}`;
  return `${rowNum}.${rackPart}.${tierPart}`;
}

module.exports = { formatBlockLabel };
