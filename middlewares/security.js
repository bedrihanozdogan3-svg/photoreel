/**
 * Fenix AI — Güvenlik Middleware Paketi
 * Prompt injection, brute force, audit log, RBAC
 */

const logger = require('../utils/logger');
const rateLimit = require('express-rate-limit');

// === PROMPT INJECTION KORUMASI ===

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(previous|above|all)\s+(instructions?|rules?|prompts?)/i,
  /disregard\s+(all|previous|your)\s+(instructions?|rules?)/i,
  /you\s+are\s+now\s+(a|an|my)/i,
  /forget\s+(everything|all|your)\s+(instructions?|rules?|training)/i,
  /new\s+instructions?:\s*/i,
  /system\s*:\s*/i,
  /\[SYSTEM\]/i,
  /act\s+as\s+(if|a|an|my)/i,
  /pretend\s+(you|to\s+be)/i,
  /override\s+(safety|security|rules?|instructions?)/i,
  /jailbreak/i,
  /DAN\s*mode/i,
  /developer\s*mode/i,
  /bypass\s+(filter|security|safety)/i,
  /kuralları\s*(yok\s*say|görmezden\s*gel|unut|değiştir)/i,
  /talimatları\s*(unut|sil|değiştir|yok\s*say)/i,
  /sen\s+artık\s+(bir|benim)/i,
  /sistem\s*:\s*/i,
];

function detectPromptInjection(text) {
  if (typeof text !== 'string') return false;
  return PROMPT_INJECTION_PATTERNS.some(p => p.test(text));
}

// AI'ya gönderilecek metinleri kontrol eden middleware
function promptInjectionGuard(req, res, next) {
  const text = req.body?.text || req.body?.topic || '';
  if (detectPromptInjection(text)) {
    logger.warn('Prompt injection tespit edildi', {
      path: req.path,
      ip: req.ip,
      text: text.substring(0, 100)
    });
    return res.status(403).json({
      ok: false,
      error: 'Güvenlik: Bu mesaj güvenlik kurallarını ihlal ediyor'
    });
  }
  next();
}

// === BRUTE FORCE KORUMASI ===

// Auth endpoint için özel limiter (5 deneme / 15 dk)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { ok: false, error: 'Çok fazla giriş denemesi. 15 dakika bekleyin.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip + ':auth'
});

// Başarısız giriş sayacı (hesap kilitleme)
const failedAttempts = new Map();
const MAX_FAILED = 10;
const LOCKOUT_DURATION = 30 * 60 * 1000; // 30 dakika

function bruteForceCheck(req, res, next) {
  const key = req.ip;
  const record = failedAttempts.get(key);

  if (record && record.locked && Date.now() < record.lockedUntil) {
    const remaining = Math.ceil((record.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({
      ok: false,
      error: `Hesap kilitlendi. ${remaining} dakika sonra tekrar deneyin.`
    });
  }

  next();
}

function recordFailedAttempt(ip) {
  const record = failedAttempts.get(ip) || { count: 0, locked: false, lockedUntil: 0 };
  record.count++;
  if (record.count >= MAX_FAILED) {
    record.locked = true;
    record.lockedUntil = Date.now() + LOCKOUT_DURATION;
    logger.warn('Hesap kilitlendi — brute force', { ip, attempts: record.count });
  }
  failedAttempts.set(ip, record);
}

function clearFailedAttempts(ip) {
  failedAttempts.delete(ip);
}

// Eski kayıtları temizle (1 saatte bir)
setInterval(() => {
  const cutoff = Date.now();
  for (const [ip, record] of failedAttempts) {
    if (record.lockedUntil && cutoff > record.lockedUntil + 3600000) {
      failedAttempts.delete(ip);
    }
  }
}, 3600000);

// === AUDIT LOG ===

function auditLog(action, details = {}) {
  return (req, res, next) => {
    const entry = {
      action,
      userId: req.user?.userId || 'anonymous',
      ip: req.ip,
      method: req.method,
      path: req.path,
      timestamp: new Date().toISOString(),
      ...details
    };

    // Response tamamlandığında status code'u da logla
    const originalEnd = res.end;
    res.end = function(...args) {
      entry.statusCode = res.statusCode;
      logger.info('AUDIT', entry);
      originalEnd.apply(res, args);
    };

    next();
  };
}

// === RBAC (Rol Bazlı Erişim Kontrolü) ===

const ROLES = {
  admin: ['read', 'write', 'delete', 'manage_users', 'manage_system', 'use_tools'],
  user: ['read', 'write', 'use_tools'],
  viewer: ['read']
};

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const userRole = req.user?.role || 'viewer';
    if (!allowedRoles.includes(userRole)) {
      logger.warn('Yetkisiz erişim denemesi', {
        userId: req.user?.userId,
        role: userRole,
        requiredRoles: allowedRoles,
        path: req.path
      });
      return res.status(403).json({ ok: false, error: 'Yetkiniz yok' });
    }
    next();
  };
}

function requirePermission(permission) {
  return (req, res, next) => {
    const userRole = req.user?.role || 'viewer';
    const permissions = ROLES[userRole] || [];
    if (!permissions.includes(permission)) {
      return res.status(403).json({ ok: false, error: `Bu işlem için '${permission}' yetkisi gerekli` });
    }
    next();
  };
}

module.exports = {
  // Prompt injection
  detectPromptInjection,
  promptInjectionGuard,
  // Brute force
  authLimiter,
  bruteForceCheck,
  recordFailedAttempt,
  clearFailedAttempts,
  // Audit
  auditLog,
  // RBAC
  ROLES,
  requireRole,
  requirePermission
};
