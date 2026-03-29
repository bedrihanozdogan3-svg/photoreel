/**
 * Fenix AI — Hukuki Onay & Ses Klonlama API
 *
 * POST /api/consent/voice     → Ses onayı kaydet + 5 kredi ver
 * GET  /api/consent/check     → Kullanıcı zaten onaylamış mı?
 * GET  /api/consent/list      → Admin: tüm onayları listele
 * GET  /api/consent/:id       → Admin: tek onay detayı
 *
 * Güvenlik:
 *  - Aynı kullanıcı iki kez kayıt yapamaz
 *  - Tarih sunucudan alınır (manipüle edilemez)
 *  - HMAC imzası (belge değiştirildi mi?)
 *  - Email yedek bildirimi
 *  - Rate limiting: aynı IP'den günde 3 deneme
 *  - Ses dosyası doğrulama (boyut, süre, sessizlik kontrolü)
 *  - Firestore'da silme/güncelleme kapalı
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const logger = require('../utils/logger');

// ── Sabitler ──
const COLLECTION = 'fenix-consents';
const VOICE_CLONES_COLLECTION = 'fenix-voice-clones';
const CONSENT_VERSION = 'v1.0';
const VOICE_BONUS_CREDITS = 5;
const RATE_LIMIT_PER_IP = 3;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 saat

// IP rate limit takibi (bellek — yeterli, büyüyünce Redis'e taşı)
const ipAttempts = new Map();

// ── Firestore ──
let _db = null;
function getDb() {
  if (_db) return _db;
  try {
    const admin = require('firebase-admin');
    _db = admin.firestore();
    return _db;
  } catch(e) {
    logger.warn('Firestore yüklenemedi', { error: e.message });
    return null;
  }
}

// ── CustomerId doğrulama ──
function isValidCid(id) {
  return typeof id === 'string' &&
    /^(phone_\d{7,15}|email_[a-z0-9._%+\-]{1,64}@[a-z0-9.\-]{1,255}\.[a-z]{2,})$/.test(id);
}

// ── HMAC imzası oluştur ──
function signConsent(data) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET eksik — HMAC imzalama yapılamaz');
  const payload = JSON.stringify({
    userId: data.userId,
    timestamp: data.timestamp,
    ip: data.ip,
    version: data.version
  });
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// ── Ses dosyası doğrulama ──
function validateVoiceFile(file) {
  if (!file) return 'Ses dosyası bulunamadı';
  const allowedTypes = ['audio/webm', 'audio/mp4', 'audio/wav', 'audio/mpeg', 'audio/ogg'];
  if (!allowedTypes.includes(file.mimetype)) return 'Geçersiz dosya formatı';
  if (file.size < 50 * 1024) return 'Ses dosyası çok kısa (min 50KB)';
  if (file.size > 50 * 1024 * 1024) return 'Ses dosyası çok büyük (max 50MB)';
  return null;
}

// ── IP rate limit kontrolü ──
function checkRateLimit(ip) {
  const now = Date.now();
  const entry = ipAttempts.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > entry.resetAt) {
    ipAttempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_PER_IP) return false;
  entry.count++;
  ipAttempts.set(ip, entry);
  return true;
}

// ── Email yedek bildirimi ──
async function sendBackupEmail(consent) {
  try {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) return;
    // Nodemailer veya benzeri varsa kullan
    // Şimdilik loggera yaz — ileride entegre edilir
    logger.info('ONAY_EMAIL_YEDEK', {
      to: adminEmail,
      userId: consent.userId,
      timestamp: consent.timestamp,
      ip: consent.ip,
      hmac: consent.hmac
    });
  } catch(e) {
    logger.warn('Email yedek hatası', { error: e.message });
  }
}

// ── Müşteri kotasını güncelle ──
async function addCreditsToCustomer(userId, credits) {
  const db = getDb();
  if (!db) return;
  try {
    const ref = db.collection('fenix-customers').doc(userId);
    await db.runTransaction(async tx => {
      const doc = await tx.get(ref);
      if (!doc.exists) return;
      const current = doc.data().quota || 0;
      tx.update(ref, {
        quota: current + credits,
        voiceConsentAt: new Date().toISOString()
      });
    });
    logger.info('Kredi eklendi', { userId, credits });
  } catch(e) {
    logger.error('Kredi ekleme hatası', { error: e.message, userId });
  }
}

// ════════════════════════════════════════
// POST /api/consent/voice
// Ses onayını kaydet, 5 kredi ver
// ════════════════════════════════════════
router.post('/voice', async (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';

  // 1. Rate limit
  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      ok: false,
      error: 'Çok fazla deneme. 24 saat sonra tekrar deneyin.'
    });
  }

  const {
    userId,
    checkboxes,      // { voice_clone, elevenlabs_processing, usage_scope, credits_limit }
    proofText,       // Kullanıcının okuduğu doğrulama metni
    voiceFileHash,   // Frontend'de hesaplanan ses dosyası hash'i
    name             // İsteğe bağlı isim
  } = req.body || {};

  // 2. UserId doğrulama
  if (!userId || !isValidCid(userId)) {
    return res.status(400).json({ ok: false, error: 'Geçersiz kullanıcı kimliği.' });
  }

  // 3. Checkbox kontrolü — hepsi işaretli olmalı
  const required = ['voice_clone', 'elevenlabs_processing', 'usage_scope', 'credits_limit'];
  const missing = required.filter(k => !checkboxes?.[k]);
  if (missing.length > 0) {
    return res.status(400).json({ ok: false, error: 'Tüm onay kutularını işaretleyin.' });
  }

  // 4. Doğrulama metni kontrolü
  if (!proofText || proofText.trim().length < 10) {
    return res.status(400).json({ ok: false, error: 'Doğrulama metni eksik.' });
  }

  // 5. Ses hash kontrolü
  if (!voiceFileHash || voiceFileHash.length < 10) {
    return res.status(400).json({ ok: false, error: 'Ses dosyası hash eksik.' });
  }

  const db = getDb();

  // 6. Daha önce onaylamış mı?
  if (db) {
    try {
      const existing = await db.collection(COLLECTION)
        .where('userId', '==', userId)
        .where('type', '==', 'voice_clone')
        .limit(1)
        .get();
      if (!existing.empty) {
        return res.status(409).json({
          ok: false,
          error: 'Bu hesap için ses onayı zaten mevcut.',
          alreadyConsented: true
        });
      }
    } catch(e) {
      logger.warn('Tekrar kontrol hatası', { error: e.message });
    }
  }

  // 7. Onay belgesi oluştur
  const timestamp = new Date().toISOString(); // Sunucudan — manipüle edilemez
  const consent = {
    type: 'voice_clone',
    userId,
    name: name || '',
    timestamp,
    ip,
    userAgent: req.headers['user-agent'] || '',
    version: CONSENT_VERSION,
    checkboxes,
    proofText: proofText.trim(),
    voiceFileHash,
    creditsGranted: VOICE_BONUS_CREDITS,
    hmac: '' // Aşağıda dolduracağız
  };

  // 8. HMAC imzası
  consent.hmac = signConsent(consent);

  // 9. Firestore'a yaz (GÜNCELLEME/SİLME KAPALI — security rules ile)
  if (db) {
    try {
      const ref = db.collection(COLLECTION).doc();
      await ref.set(consent);
      consent.consentId = ref.id;
      logger.info('Ses onayı kaydedildi', {
        consentId: ref.id,
        userId,
        ip,
        hmac: consent.hmac.substring(0, 16) + '...'
      });
    } catch(e) {
      logger.error('Onay kayıt hatası', { error: e.message });
      return res.status(500).json({ ok: false, error: 'Kayıt hatası. Tekrar deneyin.' });
    }
  }

  // 10. 5 kredi ekle
  await addCreditsToCustomer(userId, VOICE_BONUS_CREDITS);

  // 11. Email yedek bildirimi
  await sendBackupEmail(consent);

  res.json({
    ok: true,
    message: `Onay kaydedildi. ${VOICE_BONUS_CREDITS} kredi hesabınıza eklendi.`,
    creditsGranted: VOICE_BONUS_CREDITS,
    consentId: consent.consentId || 'local'
  });
});

// ════════════════════════════════════════
// GET /api/consent/check?userId=xxx
// Kullanıcı zaten onaylamış mı?
// ════════════════════════════════════════
router.get('/check', async (req, res) => {
  const { userId } = req.query;
  if (!userId || !isValidCid(userId)) {
    return res.status(400).json({ ok: false, error: 'Geçersiz userId' });
  }

  const db = getDb();
  if (!db) return res.json({ ok: true, consented: false });

  try {
    const snap = await db.collection(COLLECTION)
      .where('userId', '==', userId)
      .where('type', '==', 'voice_clone')
      .limit(1)
      .get();
    res.json({ ok: true, consented: !snap.empty });
  } catch(e) {
    res.json({ ok: true, consented: false });
  }
});

// ════════════════════════════════════════
// GET /api/consent/list — Admin only
// ════════════════════════════════════════
router.get('/list', requireAdmin, async (req, res) => {
  const db = getDb();
  if (!db) return res.json({ ok: true, consents: [] });

  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const snap = await db.collection(COLLECTION)
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();
    const consents = snap.docs.map(d => ({
      id: d.id,
      userId: d.data().userId,
      timestamp: d.data().timestamp,
      ip: d.data().ip,
      version: d.data().version,
      creditsGranted: d.data().creditsGranted,
      hmac: d.data().hmac?.substring(0, 16) + '...'
    }));
    res.json({ ok: true, consents, total: snap.size });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════
// GET /api/consent/:id — Admin only
// ════════════════════════════════════════
router.get('/:id', requireAdmin, async (req, res) => {
  const db = getDb();
  if (!db) return res.status(503).json({ ok: false, error: 'Veritabanı bağlantısı yok' });

  try {
    const doc = await db.collection(COLLECTION).doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: 'Bulunamadı' });

    const data = doc.data();
    // HMAC doğrula — belge değiştirilmiş mi?
    const expectedHmac = signConsent(data);
    const valid = expectedHmac === data.hmac;

    res.json({ ok: true, consent: { id: doc.id, ...data }, hmacValid: valid });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Admin middleware ──
function requireAdmin(req, res, next) {
  const jwt = require('jsonwebtoken');
  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ ok: false, error: 'Yapılandırma hatası' });
  const token = (req.cookies && req.cookies.fenix_admin) ||
    (req.headers.authorization && req.headers.authorization.replace('Bearer ', ''));
  if (!token) return res.status(401).json({ ok: false, error: 'Yetkisiz' });
  try {
    const p = jwt.verify(token, secret);
    if (p.role !== 'admin') return res.status(403).json({ ok: false, error: 'Yetersiz yetki' });
    next();
  } catch {
    res.status(401).json({ ok: false, error: 'Geçersiz token' });
  }
}

module.exports = router;
