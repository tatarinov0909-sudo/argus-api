require('dotenv').config();
const { createApp } = require('./app');
const alerts = require('./alerts/runner');

const app = createApp();
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`argus-api listening on :${port}`);
  // Сторож живёт в процессе приложения: меньше отдельных деталей, которые
  // могут тихо умереть по одной. Ходит ли он — видно по last_run_at.
  alerts.start();
});
