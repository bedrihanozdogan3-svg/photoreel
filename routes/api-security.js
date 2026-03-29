/**
 * Fenix AI — Güvenlik Admin API
 * Admin panelden IP ban/unban, alarm görüntüleme, audit log.
 */

const express = require('express');
const router = express.Router();
const { banIP, unbanIP } = require('../middleware/auditLog');

// Firestore
let db = null;
function getDb() {
  if (!db) {
    try { const admin = require('firebase-admin'); db = admin.firestore(); } catch(e) {}
  }
  return db;
}

// Admin JWT kontrolü
function requireAdmin(req, res, next) {
  const jwt = require('jsonwebtoken');
  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ ok: false, error: 'Yapılandırma hatası.' });
  const cookie = req.cookies?.fenix_admin;
  const header = req.headers.authorization?.replace('Bearer ', '');
  const token = cookie || header;
  if (!token) return res.status(401).json({ ok: false, error: 'Yetkisiz.' });
  try {
    const p = jwt.verify(token, secret);
    if (p.role !== 'admin') return res.status(403).json({ ok: false, error: 'Yetersiz yetki.' });
    req.adminId = p.sub || 'admin';
    next();
  } catch { return res.status(401).json({ ok: false, error: 'Geçersiz token.' }); }
}

/**
 * GET /api/security/alarms
 * Çözümlenmemiş alarmları listeler.
 */
router.get('/alarms', requireAdmin, async (req, res) => {
  const firestore = getDb();
  if (!firestore) return res.json({ ok: true, alarms: [] });
  try {
    const snap = await firestore.collection('fenix-alarms')
      .where('resolved', '==', false)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    const alarms = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, count: alarms.length, alarms });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/security/alarms/:id/resolve
 * Alarmı çözümlendi olarak işaretle.
 */
router.post('/alarms/:id/resolve', requireAdmin, async (req, res) => {
  const firestore = getDb();
  if (!firestore) return res.json({ ok: true });
  try {
    await firestore.collection('fenix-alarms').doc(req.params.id).update({
      resolved: true,
      resolvedBy: req.adminId,
      resolvedAt: new Date().toISOString()
    });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/security/banned-ips
 * Banlı IP listesi.
 */
router.get('/banned-ips', requireAdmin, async (req, res) => {
  const firestore = getDb();
  if (!firestore) return res.json({ ok: true, ips: [] });
  try {
    const snap = await firestore.collection('fenix-banned-ips')
      .where('active', '==', true)
      .orderBy('bannedAt', 'desc')
      .get();
    const ips = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, count: ips.length, ips });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/security/ban
 * Body: { ip, reason }
 * IP'yi banla.
 */
router.post('/ban', requireAdmin, async (req, res) => {
  const { ip, reason = 'manuel' } = req.body || {};
  if (!ip) return res.status(400).json({ ok: false, error: 'IP gerekli.' });
  try {
    await banIP(ip, reason, req.adminId);
    res.json({ ok: true, message: `${ip} banlandı.` });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/security/unban
 * Body: { ip }
 * IP banını kaldır.
 */
router.post('/unban', requireAdmin, async (req, res) => {
  const { ip } = req.body || {};
  if (!ip) return res.status(400).json({ ok: false, error: 'IP gerekli.' });
  try {
    await unbanIP(ip, req.adminId);
    res.json({ ok: true, message: `${ip} ban kaldırıldı.` });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/security/audit-log
 * Query: ?limit=50&date=2026-03-30&customerId=xxx
 */
router.get('/audit-log', requireAdmin, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const { date, customerId } = req.query;
  const firestore = getDb();
  if (!firestore) return res.json({ ok: true, logs: [] });
  try {
    let q = firestore.collection('fenix-audit-log').orderBy('timestamp', 'desc').limit(limit);
    if (date) q = q.where('date', '==', date);
    if (customerId) q = q.where('customerId', '==', customerId);
    const snap = await q.get();
    const logs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, count: logs.length, logs });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
