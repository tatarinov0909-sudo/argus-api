require('dotenv').config();
const { createApp } = require('./app');
const alerts = require('./alerts/runner');
const marketplaces = require('./marketplaces/runner');
const leadNotifications = require('./leads/runner');

const app = createApp();
const port = process.env.PORT || 3000;
// Только локальный адрес. Открытый порт 3000 отвечал в интернет напрямую:
// в обход nginx, а значит и в обход HTTPS — токен сотрудника уходил бы
// открытым текстом. Наружу API смотрит только через nginx.
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => {
  console.log(`argus-api listening on ${host}:${port}`);
  // Сторож живёт в процессе приложения: меньше отдельных деталей, которые
  // могут тихо умереть по одной. Ходит ли он — видно по last_run_at.
  alerts.start();
  // Опрос площадок — только чтение: заказы забираем, ничего не меняем.
  marketplaces.start();
  leadNotifications.start();
});
