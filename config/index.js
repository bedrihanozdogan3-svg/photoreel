/**
 * Fenix AI — Merkezi Yapılandırma
 * Tüm ortam değişkenleri ve ayarlar buradan yönetilir.
 * Dev/prod ayrımı NODE_ENV ile yapılır.
 */

require('dotenv').config({ override: true });

const ENV = process.env.NODE_ENV || 'development';
const isProd = ENV === 'production';

const config = {
  env: ENV,
  isProd,

  // Server
  port: parseInt(process.env.PORT) || 3000,
  allowedOrigins: isProd
    ? ['https://photoreel-194617495310.europe-west1.run.app']
    : ['http://localhost:3000', 'https://photoreel-194617495310.europe-west1.run.app'],

  // API Keys
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',

  // Firestore
  firestoreProjectId: process.env.FIRESTORE_PROJECT_ID || 'photoreel-491017',

  // Cloud
  cloudUrl: process.env.CLOUD_URL || 'https://photoreel-194617495310.europe-west1.run.app',

  // Agent
  agentId: process.env.AGENT_ID || 'bedrihan-pc',
  agentReportInterval: parseInt(process.env.AGENT_REPORT_INTERVAL) || 10000,

  // Kota limitleri
  quota: {
    gemini: parseInt(process.env.QUOTA_GEMINI) || 1500,
    claude: parseInt(process.env.QUOTA_CLAUDE) || 500,
    cloudRun: parseInt(process.env.QUOTA_CLOUDRUN) || 2000000,
  },

  // Güvenlik
  jwtSecret: process.env.JWT_SECRET || (isProd ? null : require('crypto').randomBytes(32).toString('hex')),
  bodyLimit: process.env.BODY_LIMIT || '5mb',
  rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW) || 15 * 60 * 1000, // 15 dk
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX) || 500,

  // Loglama
  logLevel: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
};

// Zorunlu değişken kontrolü (sadece prod'da)
if (isProd) {
  const required = ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'JWT_SECRET'];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.error(`HATA: Zorunlu ortam değişkenleri eksik: ${missing.join(', ')}`);
    process.exit(1);
  }
}

module.exports = config;
