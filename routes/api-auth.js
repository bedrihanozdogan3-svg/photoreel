/**
 * Fenix AI — Auth API Routes
 * Email tabanlı kayıt, giriş, profil ve kota kontrolü.
 * + Admin giriş (ADMIN_USER / ADMIN_PASS env var)
 */

const express = require('express');
const router = express.Router();
const authService = require('../services/auth-service');
const { requireAuth } = require('../middlewares/auth');
const logger = require('../utils/logger');
const jwt = require('jsonwebtoken');

/**
 * POST /api/auth/admin
 * Body: { username, password }
 * Sadece env'deki ADMIN_USER / ADMIN_PASS ile giriş — httpOnly cookie döner.
 */
router.post('/admin', (req, res) => {
  const { username, password } = req.body || {};
  const ADMIN_USER = process.env.ADMIN_USER;
  const ADMIN_PASS = process.env.ADMIN_PASS;

  if (!ADMIN_USER || !ADMIN_PASS) {
    return res.status(503).json({ ok: false, error: 'Admin kimlik bilgileri tanımlı değil.' });
  }
  if (username !== ADMIN_USER || password !== ADMIN_PASS) {
    logger.warn('Admin giriş başarısız', { username });
    return res.status(401).json({ ok: false, error: 'Hatalı kullanıcı adı veya şifre.' });
  }

  const token = jwt.sign(
    { role: 'admin', user: ADMIN_USER },
    process.env.JWT_SECRET || 'fenix-dev-secret',
    { expiresIn: '30d' }
  );

  // httpOnly cookie — JS ile okunamaz, güvenli
  res.cookie('fenix_admin', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 30 * 24 * 3600 * 1000 // 30 gün
  });

  logger.info('Admin girişi başarılı', { user: ADMIN_USER });
  res.json({ ok: true, token }); // token'ı da döndür (localStorage için)
});

/**
 * POST /api/auth/admin/logout
 * Cookie'yi siler.
 */
router.post('/admin/logout', (req, res) => {
  res.clearCookie('fenix_admin');
  res.json({ ok: true });
});

/**
 * GET /api/auth/admin/check
 * Token geçerli mi kontrol et — giris.html auto-login için kullanır.
 */
router.get('/admin/check', (req, res) => {
  const jwtSecret = process.env.JWT_SECRET || 'fenix-dev-secret';
  const cookie = req.cookies && req.cookies.fenix_admin;
  const header = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
  const token = cookie || header;
  if (!token) return res.status(401).json({ ok: false });
  try {
    const payload = jwt.verify(token, jwtSecret);
    if (payload.role !== 'admin') return res.status(401).json({ ok: false });
    res.json({ ok: true, user: payload.user });
  } catch {
    res.status(401).json({ ok: false });
  }
});

/**
 * POST /api/auth/register
 * Body: { email, name }
 * Yeni kullanıcı oluşturur, API key döner.
 */
router.post('/register', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email || !name) {
      return res.status(400).json({ ok: false, error: 'email ve name alanları gerekli' });
    }
    if (!authService.validateEmail(email)) {
      return res.status(400).json({ ok: false, error: 'Geçerli bir email adresi girin' });
    }

    const result = await authService.registerUser(email, name);
    logger.info('Yeni kullanıcı kaydı', { email, userId: result.userId });
    res.json({ ok: true, ...result });
  } catch (e) {
    const status = e.message.includes('zaten var') ? 409 : 400;
    res.status(status).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/auth/login
 * Body: { email }
 * Kullanıcıyı bulur, profil + API key döner.
 */
router.post('/login', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ ok: false, error: 'email alanı gerekli' });
    }
    if (!authService.validateEmail(email)) {
      return res.status(400).json({ ok: false, error: 'Geçerli bir email adresi girin' });
    }

    const result = await authService.loginUser(email);
    logger.info('Kullanıcı girişi', { email, userId: result.userId });
    res.json({ ok: true, ...result });
  } catch (e) {
    const status = e.message.includes('bulunamadı') ? 404 : 400;
    res.status(status).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/auth/profile
 * Header: x-api-key
 * Kullanıcı profilini kota bilgisiyle döner.
 */
router.get('/profile', requireAuth, async (req, res) => {
  try {
    const profile = await authService.getUserProfile(req.user.userId);
    if (!profile) {
      return res.status(404).json({ ok: false, error: 'Profil bulunamadı' });
    }
    res.json({
      ok: true,
      userId: profile.userId,
      email: profile.email,
      name: profile.name,
      plan: profile.plan,
      quota: profile.quota,
      createdAt: profile.createdAt,
      lastLoginAt: profile.lastLoginAt
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/auth/check-quota
 * Header: x-api-key
 * Kullanıcının daha fazla video oluşturup oluşturamayacağını kontrol eder.
 */
router.post('/check-quota', requireAuth, async (req, res) => {
  try {
    const profile = await authService.getUserProfile(req.user.userId);
    if (!profile) {
      return res.status(404).json({ ok: false, error: 'Kullanıcı bulunamadı' });
    }

    const quota = profile.quota || { free: 5, used: 0, plan: 'free' };
    const remaining = quota.free - quota.used;
    const canCreate = remaining > 0;

    res.json({
      ok: true,
      canCreate,
      remaining,
      quota
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
