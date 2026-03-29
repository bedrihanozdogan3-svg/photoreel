/**
 * Fenix AI — Audit Log Middleware
 * Her API çağrısını Firestore'a yazar.
 * Admin panelden kim ne yaptı görülebilir.
 */

let db = null;
function getDb() {
  if (!db) {
    try {
      const admin = require('firebase-admin');
      db = admin.firestore();
    } catch(e) { db = null; }
  }
  return db;
}

// IP ban listesi — Firestore'dan yüklenir, bellekte tutulur
const bannedIPs = new Set();
let banListLoaded = false;

async function loadBanList() {
  const firestore = getDb();
  if (!firestore || banListLoaded) return;
  try {
    const snap = await firestore.collection('fenix-banned-ips').where('active', '==', true).get();
    snap.forEach(doc => bannedIPs.add(doc.id));
    banListLoaded = true;
  } catch(e) {}
}

// IP'yi normalize et (proxy başlıklarına bak)
function getIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

/**
 * Middleware: IP ban kontrolü
 * Banlı IP → 403 döner
 */
async function ipBanCheck(req, res, next) {
  await loadBanList();
  const ip = getIP(req);
  if (bannedIPs.has(ip)) {
    return res.status(403).json({ ok: false, error: 'Erişim engellendi.' });
  }
  req.clientIP = ip;
  next();
}

/**
 * Middleware: Audit log yazar
 * Route handler'dan sonra çağrılmak üzere response'u wrap eder.
 */
function auditLogger(action) {
  return async (req, res, next) => {
    const originalJson = res.json.bind(res);
    const ip = req.clientIP || getIP(req);
    const customerId = req.body?.customerId || req.body?.userId || req.query?.cid || 'anonymous';
    const startTime = Date.now();

    // Response'u yakala
    res.json = function(data) {
      const duration = Date.now() - startTime;
      const result = data?.ok === false ? 'blocked' : 'ok';

      // Async olarak Firestore'a yaz (response'u geciktirme)
      writeLog({ action, ip, customerId, result, statusCode: res.statusCode, duration, error: data?.error }).catch(() => {});

      // Şüpheli davranış kontrolü
      if (result === 'blocked' && data?.error?.includes('rate')) {
        checkSuspicious(ip, customerId).catch(() => {});
      }

      return originalJson(data);
    };

    next();
  };
}

async function writeLog({ action, ip, customerId, result, statusCode, duration, error }) {
  const firestore = getDb();
  if (!firestore) return;
  try {
    await firestore.collection('fenix-audit-log').add({
      action,
      ip,
      customerId,
      result,
      statusCode: statusCode || 200,
      duration,
      error: error || null,
      timestamp: new Date().toISOString(),
      date: new Date().toISOString().slice(0, 10)
    });
  } catch(e) {}
}

// Aynı IP'den şüpheli aktivite tespiti
const ipActivityMap = new Map(); // ip → { count, customerIds: Set, firstSeen }

async function checkSuspicious(ip, customerId) {
  const now = Date.now();
  let rec = ipActivityMap.get(ip);
  if (!rec || now - rec.firstSeen > 60_000) {
    rec = { count: 0, customerIds: new Set(), firstSeen: now };
    ipActivityMap.set(ip, rec);
  }
  rec.count++;
  rec.customerIds.add(customerId);

  const firestore = getDb();
  if (!firestore) return;

  // Kural 1: 1 dakikada 50+ istek → otomatik ban
  if (rec.count >= 50) {
    await autoBan(ip, 'rate_abuse', `1 dakikada ${rec.count} istek`);
    return;
  }

  // Kural 2: Aynı IP'den 5+ farklı customerId → admin alarmı
  if (rec.customerIds.size >= 5) {
    await createAlarm(ip, 'multi_account', `${rec.customerIds.size} farklı hesap`, [...rec.customerIds]);
  }
}

async function autoBan(ip, reason, detail) {
  bannedIPs.add(ip); // Bellekte hemen ekle
  const firestore = getDb();
  if (!firestore) return;
  try {
    await firestore.collection('fenix-banned-ips').doc(ip).set({
      ip,
      reason,
      detail,
      active: true,
      auto: true,
      bannedAt: new Date().toISOString()
    });
    await createAlarm(ip, 'auto_ban', detail, []);
    // Anlık tablet bildirimi
    emitSecurityAlert('auto_ban', ip, detail);
  } catch(e) {}
}

async function createAlarm(ip, type, detail, customerIds) {
  const firestore = getDb();
  if (!firestore) return;
  try {
    await firestore.collection('fenix-alarms').add({
      ip,
      type,
      detail,
      customerIds,
      resolved: false,
      createdAt: new Date().toISOString()
    });
    // Anlık tablet bildirimi
    emitSecurityAlert(type, ip, detail);
  } catch(e) {}
}

// Socket.io ile güvenlik uyarısı gönder
function emitSecurityAlert(type, ip, detail) {
  if (!global.io) return;
  const LABELS = {
    auto_ban: '⛔ OTOMATİK BAN',
    multi_account: '👥 ÇOKLU HESAP',
    brute_force: '🔨 KABA KUVVET',
    unknown_device: '📱 BİLİNMEYEN CİHAZ',
    rate_abuse: '⚡ AŞIRI İSTEK'
  };
  global.io.emit('security_alert', {
    type,
    label: LABELS[type] || '⚠️ GÜVENLİK',
    ip: ip || 'bilinmiyor',
    detail: detail || '',
    severity: (type === 'auto_ban' || type === 'unknown_device') ? 'critical' : 'warning',
    ts: new Date().toISOString()
  });
}

/**
 * IP ban ekle/kaldır (admin panelden çağrılır)
 */
async function banIP(ip, reason, adminId) {
  bannedIPs.add(ip);
  const firestore = getDb();
  if (firestore) {
    await firestore.collection('fenix-banned-ips').doc(ip).set({
      ip, reason, active: true, auto: false,
      bannedBy: adminId, bannedAt: new Date().toISOString()
    });
  }
}

async function unbanIP(ip, adminId) {
  bannedIPs.delete(ip);
  const firestore = getDb();
  if (firestore) {
    await firestore.collection('fenix-banned-ips').doc(ip).update({
      active: false, unbannedBy: adminId, unbannedAt: new Date().toISOString()
    });
  }
}

module.exports = { ipBanCheck, auditLogger, banIP, unbanIP, getIP, emitSecurityAlert };
