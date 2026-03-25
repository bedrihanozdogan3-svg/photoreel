/**
 * Fenix AI — Kimlik Doğrulama Middleware
 * JWT ve API Key ile HTTP + WebSocket auth.
 */

const { verifyToken } = require('../utils/jwt');
const logger = require('../utils/logger');

// HTTP middleware — API istekleri için
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const apiKey = req.headers['x-api-key'] || req.query.api_key;

  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (apiKey) {
    token = apiKey;
  }

  if (!token) {
    return res.status(401).json({ ok: false, error: 'Kimlik doğrulama gerekli' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ ok: false, error: 'Geçersiz veya süresi dolmuş token' });
  }

  req.user = decoded;
  next();
}

// Socket.io middleware — WebSocket bağlantıları için
function socketAuth(socket, next) {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;

  // Dev ortamında auth opsiyonel (geliştirme kolaylığı)
  if (!token && process.env.NODE_ENV !== 'production') {
    socket.user = { userId: 'dev-user', role: 'admin' };
    return next();
  }

  if (!token) {
    return next(new Error('Kimlik doğrulama gerekli'));
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return next(new Error('Geçersiz token'));
  }

  socket.user = decoded;
  next();
}

module.exports = { requireAuth, socketAuth };
