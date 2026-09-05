const express = require('express');
const cors = require('cors');
const pinoHttp = require('pino-http');

const { errorHandler } = require('./middleware/errorHandler');

const authRoutes = require('./auth/routes');
const warehouseRoutes = require('./warehouses/routes');
const staffRoutes = require('./staff/routes');
const sellerRoutes = require('./sellers/routes');
const cellRoutes = require('./cells/routes');
const dropzoneRoutes = require('./dropzones/routes');
const productRoutes = require('./products/routes');
const invoiceRoutes = require('./invoices/routes');
const receivingRoutes = require('./receiving/routes');
const shippingRoutes = require('./shipping/routes');
const kitRoutes = require('./kits/routes');
const marketplaceRoutes = require('./marketplaces/routes');
const leadRoutes = require('./leads/routes');
const returnRoutes = require('./returns/routes');
const journalRoutes = require('./journal/routes');
const syncRoutes = require('./sync/routes');
const agentRoutes = require('./agents/routes');
const alertRoutes = require('./alerts/routes');

function createApp() {
  const app = express();

  // За nginx req.ip иначе показывает адрес прокси — один и тот же у всех.
  // Ограничение частоты по такому «адресу» отсекало бы сразу весь интернет
  // после пятой заявки. Один прокси, поэтому доверяем ровно одному хопу.
  app.set('trust proxy', 1);

  app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true }));
  // Default body-parser limit is 100kb — a 500-record 1C sync batch
  // (companies/products/invoices) routinely exceeds that.
  app.use(express.json({ limit: '5mb' }));
  app.use(pinoHttp({ level: process.env.LOG_LEVEL || 'info' }));

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.use('/api/auth', authRoutes);
  app.use('/api/warehouses', warehouseRoutes);
  app.use('/api/staff', staffRoutes);
  app.use('/api/sellers', sellerRoutes);
  app.use('/api/cells', cellRoutes);
  app.use('/api/dropzones', dropzoneRoutes);
  app.use('/api/products', productRoutes);
  app.use('/api/invoices', invoiceRoutes);
  app.use('/api/receiving', receivingRoutes);
  app.use('/api/shipping', shippingRoutes);
  app.use('/api/kits', kitRoutes);
  app.use('/api/marketplaces', marketplaceRoutes);
  // Единственная ручка без авторизации: заявка с лендинга.
  app.use('/api/leads', leadRoutes);
  app.use('/api/returns', returnRoutes);
  app.use('/api/journal', journalRoutes);
  app.use('/api/sync', syncRoutes);
  app.use('/api/agents', agentRoutes);
  app.use('/api/alerts', alertRoutes);

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
