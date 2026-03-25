/**
 * Fenix AI — Merkezi Hata Yönetimi
 * Tüm yakalanmamış hatalar buraya düşer.
 */

const logger = require('../utils/logger');

// Express error handling middleware (4 parametre şart)
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const message = err.message || 'Sunucu hatası';

  logger.error(message, {
    status,
    path: req.path,
    method: req.method,
    stack: err.stack,
    body: req.body ? JSON.stringify(req.body).substring(0, 200) : undefined
  });

  res.status(status).json({
    ok: false,
    error: message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack })
  });
}

// 404 handler
function notFoundHandler(req, res) {
  res.status(404).json({ ok: false, error: 'Endpoint bulunamadı: ' + req.path });
}

// Global unhandled rejection/exception yakalama
function setupGlobalHandlers() {
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', { reason: reason?.message || reason, stack: reason?.stack });
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception', { message: err.message, stack: err.stack });
    // Graceful shutdown — 1 saniye bekle, process'i kapat
    setTimeout(() => process.exit(1), 1000);
  });
}

module.exports = { errorHandler, notFoundHandler, setupGlobalHandlers };
