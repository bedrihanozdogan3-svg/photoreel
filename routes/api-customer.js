/**
 * Fenix AI — Müşteri Kayıt & Quota API
 * Telefon, email veya API key bazlı 5 ücretsiz video kotası.
 * Firestore'da saklanır — localStorage temizlense bile quota korunur.
 */

const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');

// Firestore lazy load
let db = null;
function getDb() {
  if (!db) {
    try {
      const admin = require('firebase-admin');
      db = admin.firestore();
    } catch(e) {
      logger.warn('Firestore yüklenemedi, bellek modu', { error: e.message });
    }
  }
  return db;
}

// Bellek fallback (Firestore yoksa)
const memStore = {};

const FREE_QUOTA = 5;
const COLLECTION = 'fenix-customers';

// Paket hiyerarşisi: her paket altındakileri kapsar
const PKG_TIERS = ['free','reels','pro','360','ses','full'];
// Hangi kartlar hangi minimum paketi gerektiriyor
const PKG_REQUIRED = { free:'free', reels:'reels', pro:'pro', '360':'360', ses:'ses', otonom:'full' };

// CustomerId format doğrulama — path traversal ve injection engeli
function isValidCustomerId(id) {
  return typeof id === 'string' && /^(phone_\d{7,15}|email_[a-z0-9._%+\-]{1,64}@[a-z0-9.\-]{1,255}\.[a-z]{2,})$/.test(id);
}

// Admin kontrolü (list/stats için)
function requireAdminLocal(req, res, next) {
  const jwt = require('jsonwebtoken');
  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ ok: false, error: 'Yapılandırma hatası.' });
  const cookie = req.cookies && req.cookies.fenix_admin;
  const header = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
  const token = cookie || header;
  if (!token) return res.status(401).json({ ok: false, error: 'Yetkisiz.' });
  try {
    const p = jwt.verify(token, secret);
    if (p.role !== 'admin') return res.status(403).json({ ok: false, error: 'Yetersiz yetki.' });
    next();
  } catch { return res.status(401).json({ ok: false, error: 'Geçersiz token.' }); }
}

/**
 * Müşteri kimliğini normalize et.
 * Telefon: +90... → sadece rakamlar
 * Email: küçük harf, trim
 */
function normalizeId(type, value) {
  if (type === 'phone') return 'phone_' + value.replace(/\D/g, '');
  if (type === 'email') return 'email_' + value.toLowerCase().trim();
  return null;
}

/**
 * POST /api/customer/register
 * Body: { phone?, email?, name? }
 * Müşteriyi kaydeder veya mevcut kaydı getirir.
 * Aynı telefon/email → aynı quota (sıfırlanmaz)
 */
router.post('/register', async (req, res) => {
  const { phone, email, name } = req.body || {};

  if (!phone && !email) {
    return res.status(400).json({ ok: false, error: 'Telefon veya email gerekli.' });
  }

  // Primary key: telefon önce, yoksa email
  const idType = phone ? 'phone' : 'email';
  const idValue = phone || email;
  const customerId = normalizeId(idType, idValue);

  if (!customerId) {
    return res.status(400).json({ ok: false, error: 'Geçersiz kimlik.' });
  }

  try {
    const firestore = getDb();

    if (firestore) {
      // Firestore'dan bak
      const ref = firestore.collection(COLLECTION).doc(customerId);
      const snap = await ref.get();

      if (snap.exists) {
        // Kayıtlı müşteri — quota'yı döndür
        const data = snap.data();
        const used = data.used || 0;
        const remaining = Math.max(0, FREE_QUOTA - used);
        const pkg = data.pkg || 'free';

        logger.info('Müşteri giriş yaptı', { customerId, used, remaining, pkg });
        return res.json({
          ok: true,
          customerId,
          remaining,
          used,
          total: FREE_QUOTA,
          isNew: false,
          name: data.name || '',
          pkg
        });
      } else {
        // Yeni müşteri — kayıt oluştur
        const newCustomer = {
          customerId,
          idType,
          idValue,
          name: name || '',
          used: 0,
          total: FREE_QUOTA,
          pkg: 'free',
          createdAt: new Date().toISOString(),
          lastUsedAt: null
        };
        await ref.set(newCustomer);

        logger.info('Yeni müşteri kaydedildi', { customerId });
        return res.json({
          ok: true,
          customerId,
          remaining: FREE_QUOTA,
          used: 0,
          total: FREE_QUOTA,
          isNew: true,
          name: name || '',
          pkg: 'free'
        });
      }
    } else {
      // Bellek fallback
      if (!memStore[customerId]) {
        memStore[customerId] = { used: 0, name: name || '', pkg: 'free', createdAt: Date.now() };
      }
      const used = memStore[customerId].used;
      const remaining = Math.max(0, FREE_QUOTA - used);
      return res.json({
        ok: true, customerId, remaining, used, total: FREE_QUOTA,
        isNew: used === 0, name: memStore[customerId].name,
        pkg: memStore[customerId].pkg || 'free'
      });
    }
  } catch (e) {
    logger.error('Müşteri kayıt hatası', { error: e.message, customerId });
    res.status(500).json({ ok: false, error: 'Sunucu hatası.' });
  }
});

/**
 * POST /api/customer/use-quota
 * Body: { customerId }
 * Video üretildiğinde çağrılır — quota 1 azaltır.
 * Kota 0 ise reddeder.
 */
router.post('/use-quota', async (req, res) => {
  const { customerId } = req.body || {};
  if (!customerId) return res.status(400).json({ ok: false, error: 'customerId gerekli.' });

  try {
    const firestore = getDb();

    if (firestore) {
      const ref = firestore.collection(COLLECTION).doc(customerId);

      // Firestore transaction — race condition engeli (eş zamanlı isteklerde quota aşımı önlenir)
      let newRemaining;
      let newUsed;
      try {
        await firestore.runTransaction(async (t) => {
          const snap = await t.get(ref);
          if (!snap.exists) throw Object.assign(new Error('Müşteri bulunamadı.'), { status: 404 });
          const data = snap.data();
          const used = data.used || 0;
          const remaining = Math.max(0, FREE_QUOTA - used);
          if (remaining <= 0) throw Object.assign(new Error('Ücretsiz video hakkınız doldu.'), { status: 403, remaining: 0 });
          t.update(ref, { used: used + 1, lastUsedAt: new Date().toISOString() });
          newUsed = used + 1;
          newRemaining = remaining - 1;
        });
      } catch (txErr) {
        return res.status(txErr.status || 500).json({ ok: false, error: txErr.message, remaining: txErr.remaining ?? undefined });
      }

      logger.info('Quota kullanıldı', { customerId, used: newUsed, remaining: newRemaining });
      return res.json({ ok: true, remaining: newRemaining, used: newUsed, total: FREE_QUOTA });

    } else {
      // Bellek fallback
      if (!memStore[customerId]) {
        return res.status(404).json({ ok: false, error: 'Müşteri bulunamadı.' });
      }
      const used = memStore[customerId].used;
      if (used >= FREE_QUOTA) {
        return res.status(403).json({ ok: false, error: 'Ücretsiz video hakkınız doldu.', remaining: 0 });
      }
      memStore[customerId].used++;
      return res.json({ ok: true, remaining: FREE_QUOTA - memStore[customerId].used, used: memStore[customerId].used, total: FREE_QUOTA });
    }
  } catch (e) {
    logger.error('Quota kullanım hatası', { error: e.message });
    res.status(500).json({ ok: false, error: 'Sunucu hatası.' });
  }
});

/**
 * GET /api/customer/quota/:customerId
 * Mevcut quota durumunu döndürür.
 */
router.get('/quota/:customerId', async (req, res) => {
  const { customerId } = req.params;
  if (!isValidCustomerId(customerId)) {
    return res.status(400).json({ ok: false, error: 'Geçersiz müşteri kimliği.' });
  }

  try {
    const firestore = getDb();

    if (firestore) {
      const snap = await firestore.collection(COLLECTION).doc(customerId).get();
      if (!snap.exists) return res.status(404).json({ ok: false, error: 'Bulunamadı.' });
      const data = snap.data();
      const used = data.used || 0;
      return res.json({ ok: true, remaining: Math.max(0, FREE_QUOTA - used), used, total: FREE_QUOTA });
    } else {
      const rec = memStore[customerId];
      if (!rec) return res.status(404).json({ ok: false, error: 'Bulunamadı.' });
      return res.json({ ok: true, remaining: Math.max(0, FREE_QUOTA - rec.used), used: rec.used, total: FREE_QUOTA });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/customer/set-pkg
 * Body: { customerId, pkg }
 * Admin: müşteriye paket atar.
 */
router.post('/set-pkg', requireAdminLocal, async (req, res) => {
  const { customerId, pkg } = req.body || {};
  if (!customerId || !PKG_TIERS.includes(pkg)) {
    return res.status(400).json({ ok: false, error: 'Geçersiz customerId veya pkg.' });
  }
  try {
    const firestore = getDb();
    if (firestore) {
      const ref = firestore.collection(COLLECTION).doc(customerId);
      const snap = await ref.get();
      if (!snap.exists) return res.status(404).json({ ok: false, error: 'Müşteri bulunamadı.' });
      await ref.update({ pkg, pkgUpdatedAt: new Date().toISOString() });
    } else {
      if (!memStore[customerId]) return res.status(404).json({ ok: false, error: 'Müşteri bulunamadı.' });
      memStore[customerId].pkg = pkg;
    }
    logger.info('Müşteri paketi güncellendi', { customerId, pkg });
    return res.json({ ok: true, customerId, pkg });
  } catch (e) {
    logger.error('set-pkg hatası', { error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/customer/list
 * Tüm müşterileri listeler (admin panel için).
 * Query: ?limit=50&status=all|active|full
 */
router.get('/list', requireAdminLocal, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const status = req.query.status || 'all'; // all | active | full

  try {
    const firestore = getDb();

    if (firestore) {
      let query = firestore.collection(COLLECTION).orderBy('createdAt', 'desc').limit(limit);
      const snap = await query.get();
      const customers = [];

      snap.forEach(doc => {
        const d = doc.data();
        const used = d.used || 0;
        const remaining = Math.max(0, FREE_QUOTA - used);

        // Filtrele
        if (status === 'active' && remaining === 0) return;
        if (status === 'full' && remaining > 0) return;

        customers.push({
          customerId: doc.id,
          idType: d.idType || 'unknown',
          idValue: d.idValue || '',
          name: d.name || '',
          used,
          remaining,
          total: FREE_QUOTA,
          isFull: remaining === 0,
          createdAt: d.createdAt || '',
          lastUsedAt: d.lastUsedAt || null
        });
      });

      return res.json({ ok: true, count: customers.length, customers });

    } else {
      // Bellek fallback
      const customers = Object.entries(memStore).map(([id, rec]) => ({
        customerId: id,
        idType: id.startsWith('phone_') ? 'phone' : 'email',
        idValue: id.replace(/^(phone_|email_)/, ''),
        name: rec.name || '',
        used: rec.used,
        remaining: Math.max(0, FREE_QUOTA - rec.used),
        total: FREE_QUOTA,
        isFull: rec.used >= FREE_QUOTA,
        createdAt: new Date(rec.createdAt).toISOString(),
        lastUsedAt: null
      }));
      return res.json({ ok: true, count: customers.length, customers });
    }
  } catch (e) {
    logger.error('Müşteri listesi hatası', { error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/customer/stats
 * Toplam müşteri sayısı, kota durumu, gelir özeti.
 */
router.get('/stats', requireAdminLocal, async (req, res) => {
  try {
    const firestore = getDb();

    if (firestore) {
      const snap = await firestore.collection(COLLECTION).get();
      let total = 0;
      let totalUsed = 0;
      let fullCount = 0;
      let activeCount = 0;
      let newToday = 0;
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

      snap.forEach(doc => {
        const d = doc.data();
        const used = d.used || 0;
        const remaining = Math.max(0, FREE_QUOTA - used);
        total++;
        totalUsed += used;
        if (remaining === 0) fullCount++;
        else activeCount++;
        if (d.createdAt && d.createdAt.startsWith(today)) newToday++;
      });

      return res.json({
        ok: true,
        total,
        totalUsed,
        fullCount,
        activeCount,
        newToday,
        totalFreeVideos: total * FREE_QUOTA,
        usedFreeVideos: totalUsed,
        conversionRate: total > 0 ? Math.round((fullCount / total) * 100) : 0
      });

    } else {
      // Bellek fallback
      const recs = Object.values(memStore);
      const total = recs.length;
      const totalUsed = recs.reduce((s, r) => s + r.used, 0);
      const fullCount = recs.filter(r => r.used >= FREE_QUOTA).length;
      return res.json({
        ok: true,
        total,
        totalUsed,
        fullCount,
        activeCount: total - fullCount,
        newToday: 0,
        totalFreeVideos: total * FREE_QUOTA,
        usedFreeVideos: totalUsed,
        conversionRate: total > 0 ? Math.round((fullCount / total) * 100) : 0
      });
    }
  } catch (e) {
    logger.error('Stats hatası', { error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
