/**
 * Fenix AI — Auth API Routes
 * Email tabanlı kayıt, giriş, profil ve kota kontrolü.
 */

const express = require('express');
const router = express.Router();
const authService = require('../services/auth-service');
const { requireAuth } = require('../middlewares/auth');
const logger = require('../utils/logger');

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
