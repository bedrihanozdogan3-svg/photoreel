/**
 * Fenix AI — Asenkron Görev Kuyruğu
 * Uzun süren işlemleri (AI, render, video) arka plana atar.
 * Bilgisayar kapalıyken bile cloud'da çalışır.
 *
 * Başlangıç: Bellek tabanlı kuyruk (ileride Redis/Pub-Sub'a geçiş kolay)
 * Her görev: { id, type, payload, status, result, createdAt, completedAt }
 */

const logger = require('../utils/logger');
const EventEmitter = require('events');

class QueueService extends EventEmitter {
  constructor() {
    super();
    this.jobs = new Map();
    this.processing = false;
    this.concurrency = 2; // Aynı anda kaç iş
    this.activeCount = 0;
    this.handlers = {};
  }

  // İş tipi için handler kaydet
  registerHandler(type, handler) {
    this.handlers[type] = handler;
    logger.info('Kuyruk handler kaydedildi', { type });
  }

  // Kuyruğa iş ekle
  async enqueue(type, payload, userId = null) {
    const job = {
      id: Date.now().toString() + '-' + Math.random().toString(36).slice(2, 8),
      type,
      payload,
      userId,
      status: 'pending', // pending → processing → completed / failed
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      completedAt: null,
      progress: 0
    };

    this.jobs.set(job.id, job);
    logger.info('Görev kuyruğa eklendi', { jobId: job.id, type, userId });
    this.emit('job:created', job);

    // Otomatik işlemeyi başlat
    this._processNext();

    return { jobId: job.id };
  }

  // Görev durumunu sorgula
  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  // Kullanıcının görevlerini getir
  getUserJobs(userId) {
    const jobs = [];
    for (const job of this.jobs.values()) {
      if (job.userId === userId) jobs.push(job);
    }
    return jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  // İlerleme güncelle
  updateProgress(jobId, progress) {
    const job = this.jobs.get(jobId);
    if (job) {
      job.progress = Math.min(100, Math.max(0, progress));
      this.emit('job:progress', job);
    }
  }

  // Kuyruktaki bekleyen işleri çalıştır
  async _processNext() {
    if (this.activeCount >= this.concurrency) return;

    // Bekleyen iş bul
    let nextJob = null;
    for (const job of this.jobs.values()) {
      if (job.status === 'pending') { nextJob = job; break; }
    }

    if (!nextJob) return;

    const handler = this.handlers[nextJob.type];
    if (!handler) {
      nextJob.status = 'failed';
      nextJob.error = 'Handler bulunamadı: ' + nextJob.type;
      logger.error('Kuyruk handler bulunamadı', { type: nextJob.type });
      return;
    }

    this.activeCount++;
    nextJob.status = 'processing';
    nextJob.progress = 0;
    this.emit('job:started', nextJob);

    try {
      logger.info('Görev işleniyor', { jobId: nextJob.id, type: nextJob.type });
      const result = await handler(nextJob.payload, (progress) => this.updateProgress(nextJob.id, progress));
      nextJob.status = 'completed';
      nextJob.result = result;
      nextJob.completedAt = new Date().toISOString();
      nextJob.progress = 100;
      logger.info('Görev tamamlandı', { jobId: nextJob.id, type: nextJob.type });
      this.emit('job:completed', nextJob);
    } catch (err) {
      nextJob.status = 'failed';
      nextJob.error = err.message;
      nextJob.completedAt = new Date().toISOString();
      logger.error('Görev başarısız', { jobId: nextJob.id, type: nextJob.type, error: err.message });
      this.emit('job:failed', nextJob);
    } finally {
      this.activeCount--;
      // Eski görevleri temizle (1 saatten eski tamamlanan/başarısız)
      this._cleanup();
      // Sonraki işi başlat
      this._processNext();
    }
  }

  _cleanup() {
    const cutoff = Date.now() - 3600000;
    for (const [id, job] of this.jobs) {
      if ((job.status === 'completed' || job.status === 'failed') && new Date(job.completedAt).getTime() < cutoff) {
        this.jobs.delete(id);
      }
    }
  }

  getStats() {
    let pending = 0, processing = 0, completed = 0, failed = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'pending') pending++;
      else if (job.status === 'processing') processing++;
      else if (job.status === 'completed') completed++;
      else if (job.status === 'failed') failed++;
    }
    return { pending, processing, completed, failed, total: this.jobs.size };
  }
}

// Singleton
const queue = new QueueService();

module.exports = queue;
