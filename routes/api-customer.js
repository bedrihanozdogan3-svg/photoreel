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

        logger.info('Müşteri giriş yaptı', { customerId, used, remaining });
        return res.json({
          ok: true,
          customerId,
          remaining,
          used,
          total: FREE_QUOTA,
          isNew: false,
          name: data.name || ''
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
          name: name || ''
        });
      }
    } else {
      // Bellek fallback
      if (!memStore[customerId]) {
        memStore[customerId] = { used: 0, name: name || '', createdAt: Date.now() };
      }
      const used = memStore[customerId].used;
      const remaining = Math.max(0, FREE_QUOTA - used);
      return res.json({
        ok: true, customerId, remaining, used, total: FREE_QUOTA,
        isNew: used === 0, name: memStore[customerId].name
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
      const snap = await ref.get();

      if (!snap.exists) {
        return res.status(404).json({ ok: false, error: 'Müşteri bulunamadı.' });
      }

      const data = snap.data();
      const used = data.used || 0;
      const remaining = Math.max(0, FREE_QUOTA - used);

      if (remaining <= 0) {
        return res.status(403).json({
          ok: false,
          error: 'Ücretsiz video hakkınız doldu.',
          remaining: 0
        });
      }

      // Quota kullan
      await ref.update({
        used: used + 1,
        lastUsedAt: new Date().toISOString()
      });

      const newRemaining = remaining - 1;
      logger.info('Quota kullanıldı', { customerId, used: used + 1, remaining: newRemaining });

      return res.json({ ok: true, remaining: newRemaining, used: used + 1, total: FREE_QUOTA });

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
 * GET /api/customer/list
 * Tüm müşterileri listeler (admin panel için).
 * Query: ?limit=50&status=all|active|full
 */
router.get('/list', async (req, res) => {
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
router.get('/stats', async (req, res) => {
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
