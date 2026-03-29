/**
 * Fenix AI — Kalıcı Görev Kuyruğu (Firestore)
 *
 * Telefon kapansa, sunucu yeniden başlasa bile işler devam eder.
 * Tüm işler Firestore "fenix-jobs" koleksiyonunda saklanır.
 *
 * API geriye dönük uyumlu — eski kod değişmeden çalışır.
 * Her görev: { id, type, payload, userId, status, result, progress, createdAt, completedAt }
 */

const logger = require('../utils/logger');
const EventEmitter = require('events');

const COLLECTION = 'fenix-jobs';
const CLEANUP_AFTER_MS = 24 * 60 * 60 * 1000; // 24 saat sonra temizle

// Firestore lazy load
let _db = null;
function getDb() {
  if (_db) return _db;
  try {
    const admin = require('firebase-admin');
    _db = admin.firestore();
    return _db;
  } catch(e) {
    logger.warn('Firestore yüklenemedi, bellek modu aktif', { error: e.message });
    return null;
  }
}

class QueueService extends EventEmitter {
  constructor() {
    super();
    this.localJobs = new Map(); // Firestore yoksa fallback
    this.processing = false;
    this.concurrency = 2;
    this.activeCount = 0;
    this.handlers = {};
    // Başlangıçta yarım kalan işleri devam ettir
    this._resumePending();
  }

  // İş tipi için handler kaydet
  registerHandler(type, handler) {
    this.handlers[type] = handler;
    logger.info('Kuyruk handler kaydedildi', { type });
  }

  // Kuyruğa iş ekle
  async enqueue(type, payload, userId = null) {
    const id = Date.now().toString() + '-' + Math.random().toString(36).slice(2, 8);
    const job = {
      id,
      type,
      payload,
      userId,
      status: 'pending',
      result: null,
      error: null,
      progress: 0,
      createdAt: new Date().toISOString(),
      completedAt: null
    };

    await this._save(job);
    logger.info('Görev kuyruğa eklendi', { jobId: id, type, userId });
    this.emit('job:created', job);
    this._processNext();
    return { jobId: id };
  }

  // Görev durumunu sorgula
  async getJob(jobId) {
    const db = getDb();
    if (db) {
      try {
        const doc = await db.collection(COLLECTION).doc(jobId).get();
        if (doc.exists) return { id: doc.id, ...doc.data() };
      } catch(e) { /* fallback */ }
    }
    return this.localJobs.get(jobId) || null;
  }

  // Kullanıcının görevlerini getir
  async getUserJobs(userId) {
    const db = getDb();
    if (db) {
      try {
        const snap = await db.collection(COLLECTION)
          .where('userId', '==', userId)
          .orderBy('createdAt', 'desc')
          .limit(100)
          .get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
      } catch(e) { /* fallback */ }
    }
    return Array.from(this.localJobs.values())
      .filter(j => j.userId === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  // İlerleme güncelle
  async updateProgress(jobId, progress) {
    const pct = Math.min(100, Math.max(0, progress));
    const db = getDb();
    if (db) {
      try {
        await db.collection(COLLECTION).doc(jobId).update({ progress: pct });
      } catch(e) { /* ignore */ }
    }
    const local = this.localJobs.get(jobId);
    if (local) local.progress = pct;
    this.emit('job:progress', { id: jobId, progress: pct });
  }

  // İşi iptal et
  async cancelJob(jobId) {
    const job = await this.getJob(jobId);
    if (!job || job.status === 'processing') return false;
    await this._update(jobId, { status: 'cancelled', completedAt: new Date().toISOString() });
    this.emit('job:cancelled', job);
    return true;
  }

  // İstatistikler
  async getStats() {
    const db = getDb();
    if (db) {
      try {
        const snap = await db.collection(COLLECTION).get();
        const counts = { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 };
        snap.docs.forEach(d => {
          const s = d.data().status;
          if (counts[s] !== undefined) counts[s]++;
        });
        return { ...counts, total: snap.size };
      } catch(e) { /* fallback */ }
    }
    let pending = 0, processing = 0, completed = 0, failed = 0;
    for (const job of this.localJobs.values()) {
      if (job.status === 'pending') pending++;
      else if (job.status === 'processing') processing++;
      else if (job.status === 'completed') completed++;
      else if (job.status === 'failed') failed++;
    }
    return { pending, processing, completed, failed, total: this.localJobs.size };
  }

  // ── ÖZEL METODLAR ──

  async _save(job) {
    const db = getDb();
    if (db) {
      try {
        await db.collection(COLLECTION).doc(job.id).set(job);
        return;
      } catch(e) { logger.warn('Firestore kayıt hatası, belleğe yazılıyor', { error: e.message }); }
    }
    this.localJobs.set(job.id, job);
  }

  async _update(jobId, updates) {
    const db = getDb();
    if (db) {
      try {
        await db.collection(COLLECTION).doc(jobId).update(updates);
        return;
      } catch(e) { /* fallback */ }
    }
    const job = this.localJobs.get(jobId);
    if (job) Object.assign(job, updates);
  }

  async _processNext() {
    if (this.activeCount >= this.concurrency) return;

    // Bekleyen iş bul
    let nextJob = null;
    const db = getDb();
    if (db) {
      try {
        const snap = await db.collection(COLLECTION)
          .where('status', '==', 'pending')
          .orderBy('createdAt', 'asc')
          .limit(1)
          .get();
        if (!snap.empty) nextJob = { id: snap.docs[0].id, ...snap.docs[0].data() };
      } catch(e) { /* fallback */ }
    }
    if (!nextJob) {
      for (const job of this.localJobs.values()) {
        if (job.status === 'pending') { nextJob = job; break; }
      }
    }
    if (!nextJob) return;

    const handler = this.handlers[nextJob.type];
    if (!handler) {
      await this._update(nextJob.id, { status: 'failed', error: 'Handler bulunamadı: ' + nextJob.type });
      logger.error('Kuyruk handler bulunamadı', { type: nextJob.type });
      return;
    }

    this.activeCount++;
    await this._update(nextJob.id, { status: 'processing', progress: 0 });
    this.emit('job:started', nextJob);

    try {
      logger.info('Görev işleniyor', { jobId: nextJob.id, type: nextJob.type });
      const result = await handler(nextJob.payload, (p) => this.updateProgress(nextJob.id, p));
      await this._update(nextJob.id, {
        status: 'completed',
        result,
        progress: 100,
        completedAt: new Date().toISOString()
      });
      logger.info('Görev tamamlandı', { jobId: nextJob.id });
      this.emit('job:completed', { ...nextJob, status: 'completed', result });
    } catch(err) {
      await this._update(nextJob.id, {
        status: 'failed',
        error: err.message,
        completedAt: new Date().toISOString()
      });
      logger.error('Görev başarısız', { jobId: nextJob.id, error: err.message });
      this.emit('job:failed', { ...nextJob, status: 'failed', error: err.message });
    } finally {
      this.activeCount--;
      this._processNext();
    }
  }

  // Sunucu başlayınca yarım kalan "processing" işleri pending'e çek
  async _resumePending() {
    const db = getDb();
    if (!db) return;
    try {
      const snap = await db.collection(COLLECTION)
        .where('status', '==', 'processing')
        .get();
      if (snap.empty) return;
      const batch = db.batch();
      snap.docs.forEach(d => batch.update(d.ref, { status: 'pending', progress: 0 }));
      await batch.commit();
      logger.info(`${snap.size} yarım kalan görev yeniden kuyruğa alındı`);
      // Kuyruğu başlat
      setTimeout(() => this._processNext(), 2000);
    } catch(e) {
      logger.warn('Resume hatası', { error: e.message });
    }
  }
}

const queue = new QueueService();
module.exports = queue;
