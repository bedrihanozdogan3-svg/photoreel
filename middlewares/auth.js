/**
 * Fenix AI — Kimlik Doğrulama Middleware
 * JWT, API Key ile HTTP + WebSocket auth.
 * optionalAuth: varsa kullanıcı ekler, yoksa devam eder.
 * requireAuth: geçerli API key/JWT yoksa 401 döner.
 */

const { verifyToken } = require('../utils/jwt');
const authService = require('../services/auth-service');
const logger = require('../utils/logger');

/**
 * API key ile kullanıcı çözümle (ortak mantık)
 * Önce x-api-key header, sonra Bearer token, sonra query param bakar.
 */
async function resolveUser(req) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  const authHeader = req.headers.authorization;

  // 1) API key ile kullanıcı bul (yeni auth-service)
  if (apiKey) {
    try {
      const user = await authService.getUserByApiKey(apiKey);
      if (user) return user;
    } catch (e) {
      logger.error('API key çözümleme hatası', { error: e.message });
    }
  }

  // 2) Bearer JWT token fallback (eski sistem uyumluluğu)
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    // Önce JWT olarak dene
    const decoded = verifyToken(token);
    if (decoded) return decoded;
    // JWT değilse API key olarak dene
    try {
      const user = await authService.getUserByApiKey(token);
      if (user) return user;
    } catch (e) {
      logger.error('Bearer token çözümleme hatası', { error: e.message });
    }
  }

  return null;
}

/**
 * optionalAuth — API key varsa req.user atar, yoksa devam eder
 */
async function optionalAuth(req, res, next) {
  try {
    req.user = await resolveUser(req);
  } catch (e) {
    logger.error('optionalAuth hatası', { error: e.message });
    req.user = null;
  }
  next();
}

/**
 * requireAuth — geçerli kimlik yoksa 401 döner
 */
async function requireAuth(req, res, next) {
  try {
    const user = await resolveUser(req);
    if (!user) {
      return res.status(401).json({ ok: false, error: 'Kimlik doğrulama gerekli' });
    }
    req.user = user;
    next();
  } catch (e) {
    logger.error('requireAuth hatası', { error: e.message });
    return res.status(401).json({ ok: false, error: 'Kimlik doğrulama hatası' });
  }
}

// Socket.io middleware — WebSocket bağlantıları için (JWT + API key)
async function socketAuth(socket, next) {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  const apiKey = socket.handshake.auth?.apiKey || socket.handshake.query?.api_key;

  // Dev ortamında auth opsiyonel (geliştirme kolaylığı)
  if (!token && !apiKey && process.env.NODE_ENV !== 'production') {
    socket.user = { userId: 'dev-user', role: 'admin' };
    return next();
  }

  // JWT token dene
  if (token) {
    const decoded = verifyToken(token);
    if (decoded) { socket.user = decoded; return next(); }
    // JWT değilse API key olarak dene
    try {
      const user = await authService.getUserByApiKey(token);
      if (user) { socket.user = user; return next(); }
    } catch(e) {}
  }

  // API key dene
  if (apiKey) {
    try {
      const user = await authService.getUserByApiKey(apiKey);
      if (user) { socket.user = user; return next(); }
    } catch(e) {}
  }

  return next(new Error('Kimlik doğrulama gerekli'));
}

module.exports = { optionalAuth, requireAuth, socketAuth };
