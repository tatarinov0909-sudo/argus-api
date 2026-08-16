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
const journalRoutes = require('./journal/routes');
const syncRoutes = require('./sync/routes');

function createApp() {
  const app = express();

  app.use(cors({ origin: process.env.CORS_ORIGIN?.split(',') ?? true }));
  app.use(express.json());
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
  app.use('/api/journal', journalRoutes);
  app.use('/api/sync', syncRoutes);

  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
