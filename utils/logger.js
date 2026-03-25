/**
 * Fenix AI — Merkezi Loglama (Winston)
 * Tüm loglar buradan geçer. Production'da Cloud Logging'e gider.
 */

const winston = require('winston');
const config = require('../config');

const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'fenix-ai' },
  transports: [
    new winston.transports.Console({
      format: config.isProd
        ? winston.format.json()
        : winston.format.combine(
            winston.format.colorize(),
            winston.format.printf(({ timestamp, level, message, ...meta }) => {
              const metaStr = Object.keys(meta).length > 0 ? ' ' + JSON.stringify(meta) : '';
              return `${timestamp} [${level}]: ${message}${metaStr}`;
            })
          )
    })
  ]
});

module.exports = logger;
