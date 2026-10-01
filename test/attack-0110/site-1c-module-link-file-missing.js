// «Подключение 1С без разработчика» (хендофф 30.09-2, п. 5): на экране
// «Подключение 1С» две кнопки ведут на argus-sync-1c-10.3.zip («Скачать модуль
// и инструкцию»). Такого файла нет ни в репозитории сайта (argus-product), ни
// на стенде (http://127.0.0.1:8099/argus-sync-1c-10.3.zip → 404). По хендоффу
// на рабочем сайте файл лежит — значит, положен руками мимо git, и любая
// выкладка «как в git» или новый сервер его потеряют: владелец нового
// фулфилмента нажмёт «Скачать» и получит 404, то есть без разработчика 1С
// не подключит.
//
// Ожидаемо: всё, на что ссылаются страницы сайта, лежит в репозитории сайта.
const fs = require('node:fs');
const path = require('node:path');

const SITE = path.resolve(__dirname, '../../../argus-product');
let bad = 0;
for (const page of ['cabinet_main.html', 'cabinet_main.js', 'loader.html', 'client_access.html', 'login.html']) {
  const text = fs.readFileSync(path.join(SITE, page), 'utf8');
  const links = [...text.matchAll(/href="([^"#?:]+\.(?:zip|epf|pdf|docx?|xlsx?|txt|bsl))"/g)].map((m) => m[1]);
  for (const link of new Set(links)) {
    const exists = fs.existsSync(path.join(SITE, link));
    console.log(`  ${exists ? 'ok  ' : 'FAIL'}  ${page} → ${link}`
      + (exists ? '' : '\n        ожидалось: файл есть в argus-product\n        получили:  файла нет (на стенде — 404)'));
    if (!exists) bad += 1;
  }
}
console.log(`\nСсылки на файлы сайта: ${bad} битых`);
if (bad) process.exitCode = 1;
