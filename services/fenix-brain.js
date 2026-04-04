/**
 * Fenix AI — Beyin Servisi
 * Usta-Çırak-Mimar modelinin merkezi karar motoru.
 *
 * 4 modül:
 * 1. Orkestrasyon — Claude/Gemini görev dağıtımı
 * 2. Shadow Learning — Usta hareketlerini kaydet
 * 3. Otonom Optimizasyon — Metriklerden otomatik ayar
 * 4. Self-Heal — Hata kök neden analizi + otomatik düzeltme
 */

const logger = require('../utils/logger');
const { getBreaker } = require('../utils/circuit-breaker');

// ═══ FIRESTORE KALICILIK ═══
let _db = null;
function getDb() {
  if (_db) return _db;
  try {
    const admin = require('firebase-admin');
    _db = admin.firestore();
    return _db;
  } catch(e) { return null; }
}

// Skill verilerini Firestore'a kaydet
let skillsDirty = false;
async function flushSkills() {
  if (!skillsDirty) return;
  skillsDirty = false;
  const db = getDb();
  if (!db) return;
  try {
    await db.collection('system').doc('fenix-skills').set({
      skills: taskSkills,
      shadowCount: shadowLog.length,
      updatedAt: new Date().toISOString()
    });
    logger.debug('Fenix skills Firestore\'a kaydedildi');
  } catch(e) {
    skillsDirty = true; // Başarısız olunca tekrar dene
    logger.warn('Skills kayıt hatası', { error: e.message });
  }
}
// Her 10 saniyede kaydet (eskiden 30 — hafıza uçma riski azaltıldı)
setInterval(flushSkills, 10000);
// SIGTERM gelince (Cloud Run kapanınca) önce kaydet
process.once('SIGTERM', async () => {
  logger.info('🛑 SIGTERM alındı — Fenix hafızası kaydediliyor...');
  skillsDirty = true;
  await flushSkills().catch(() => {});
  logger.info('✅ Fenix hafızası kaydedildi, kapanıyor.');
});
process.once('SIGINT', async () => {
  skillsDirty = true;
  await flushSkills().catch(() => {});
});

// Başlangıçta Firestore'dan yükle
(async () => {
  const db = getDb();
  if (!db) return;
  try {
    const doc = await db.collection('system').doc('fenix-skills').get();
    if (doc.exists) {
      const data = doc.data();
      if (data.skills) Object.assign(taskSkills, data.skills);
      logger.info('Fenix skills Firestore\'dan yüklendi', { taskTypes: Object.keys(taskSkills).length });
    }
  } catch(e) { logger.warn('Fenix skills yüklenemedi', { error: e.message }); }
})();

// ═══════════════════════════════════════════════════════
// 1. ORKESTRASYON — Usta-Çırak Görev Akışı
// ═══════════════════════════════════════════════════════

const SKILL_LEVELS = {
  APPRENTICE: 'apprentice',  // Fenix henüz öğreniyor
  JOURNEYMAN: 'journeyman',  // Fenix bazen başarılı
  MASTER: 'master'            // Fenix tek başına yapabiliyor
};

// Her görev tipi için Fenix'in yetkinlik seviyesi
const taskSkills = {};

function getSkillLevel(taskType) {
  return taskSkills[taskType]?.level || SKILL_LEVELS.APPRENTICE;
}

function getSkillScore(taskType) {
  return taskSkills[taskType]?.score || 0;
}

/**
 * Görev yönlendirme — kim yapacak?
 * Çırak yapabiliyorsa çırak, yapamıyorsa usta devralır
 */
function routeTask(taskType, complexity = 'normal') {
  const skill = getSkillLevel(taskType);
  const score = getSkillScore(taskType);

  // Master seviyesi — Fenix tek başına
  if (skill === SKILL_LEVELS.MASTER && complexity !== 'critical') {
    return { handler: 'fenix', reason: 'Fenix bu görevi öğrendi', confidence: score };
  }

  // Journeyman — basit görevlerde Fenix, karmaşıklarda usta
  if (skill === SKILL_LEVELS.JOURNEYMAN && complexity === 'simple') {
    return { handler: 'fenix', reason: 'Basit görev, Fenix deneyecek', confidence: score, fallback: 'gemini' };
  }

  // Complexity-based routing
  const routing = {
    simple: { handler: 'gemini', model: 'fast', reason: 'Hızlı işlem (flash-lite)' },
    normal: { handler: 'gemini', model: 'standard', reason: 'Standart işlem (flash)' },
    critical: { handler: 'gemini', model: 'powerful', reason: 'Kritik işlem (pro)', reviewBy: 'claude' },
    creative: { handler: 'claude', reason: 'Yaratıcı/stratejik görev' },
  };

  return routing[complexity] || routing.normal;
}

// ═══════════════════════════════════════════════════════
// 2. SHADOW LEARNING — Usta Hareketlerini Kaydet
// ═══════════════════════════════════════════════════════

const shadowLog = []; // Bellekte son 1000 eylem
const MAX_SHADOW_LOG = 1000;

/**
 * Usta'nın bir eylemini kaydet
 * @param {string} actor - 'claude' | 'gemini' | 'user'
 * @param {string} taskType - 'scene_generation' | 'transition_selection' | etc.
 * @param {object} input - Girdi verisi
 * @param {object} output - Çıktı verisi
 * @param {string} outcome - 'success' | 'failure' | 'partial'
 */
function recordShadow(actor, taskType, input, output, outcome = 'success') {
  const entry = {
    timestamp: new Date().toISOString(),
    actor,
    taskType,
    input: summarize(input),
    output: summarize(output),
    outcome,
  };

  shadowLog.push(entry);
  if (shadowLog.length > MAX_SHADOW_LOG) shadowLog.shift();

  // Başarılı eylemler çırağın öğrenmesine katkıda bulunur
  if (outcome === 'success') {
    updateSkill(taskType, 1);
  } else if (outcome === 'failure') {
    updateSkill(taskType, -2);
  }

  logger.debug('Shadow Learning kaydı', { actor, taskType, outcome });
  return entry;
}

function updateSkill(taskType, delta) {
  if (!taskSkills[taskType]) {
    taskSkills[taskType] = { level: SKILL_LEVELS.APPRENTICE, score: 0, successes: 0, failures: 0, total: 0 };
  }
  skillsDirty = true; // Firestore'a yazılacak

  const skill = taskSkills[taskType];
  skill.score = Math.max(0, Math.min(100, skill.score + delta));
  skill.total++;
  if (delta > 0) skill.successes++;
  else skill.failures++;

  // Seviye geçişleri
  const successRate = skill.total > 10 ? skill.successes / skill.total : 0;
  if (skill.total >= 100 && successRate >= 0.9) {
    skill.level = SKILL_LEVELS.MASTER;
    logger.info(`🎓 Fenix MASTER seviyesine ulaştı: ${taskType}`, { score: skill.score, rate: successRate });
  } else if (skill.total >= 30 && successRate >= 0.7) {
    skill.level = SKILL_LEVELS.JOURNEYMAN;
  } else {
    skill.level = SKILL_LEVELS.APPRENTICE;
  }
}

function getShadowStats() {
  return {
    totalRecords: shadowLog.length,
    skills: { ...taskSkills },
    recentActions: shadowLog.slice(-10),
    actorBreakdown: shadowLog.reduce((acc, e) => {
      acc[e.actor] = (acc[e.actor] || 0) + 1;
      return acc;
    }, {})
  };
}

/**
 * FAZA 1-8 servislerinden gelen basit log — recordShadow'a köprü
 * Kullanım: fenixBrain.logShadow({ task: 'background_removal', method: 'imgly', success: true })
 */
function logShadow(data) {
  if (!data || !data.task) return;
  const taskType = data.task;
  const outcome = data.success === false ? 'failure' : 'success';
  const actor = data.actor || 'fenix_pipeline';
  const input = { ...data };
  delete input.task;
  delete input.success;
  delete input.actor;
  return recordShadow(actor, taskType, input, { logged: true }, outcome);
}

// Objeyi özetlemek (shadow log'da çok büyük veri tutmamak için)
function summarize(obj) {
  if (!obj) return null;
  if (typeof obj === 'string') return obj.substring(0, 200);
  try {
    const str = JSON.stringify(obj);
    return str.length > 500 ? JSON.parse(str.substring(0, 500) + '..."') : obj;
  } catch(e) { return String(obj).substring(0, 200); }
}

// ═══════════════════════════════════════════════════════
// 3. OTONOM OPTİMİZASYON — Metriklerden Otomatik Ayar
// ═══════════════════════════════════════════════════════

const metrics = {
  apiLatency: { gemini: [], claude: [], firestore: [] },
  errorRates: { gemini: 0, claude: 0, firestore: 0 },
  requestCounts: { total: 0, byEndpoint: {} },
  lastOptimization: null
};

/**
 * API çağrısı metriğini kaydet
 */
function recordMetric(service, latencyMs, success = true) {
  if (!metrics.apiLatency[service]) metrics.apiLatency[service] = [];
  metrics.apiLatency[service].push({ ms: latencyMs, success, at: Date.now() });

  // Son 100 kaydı tut
  if (metrics.apiLatency[service].length > 100) {
    metrics.apiLatency[service] = metrics.apiLatency[service].slice(-100);
  }

  if (!success) {
    metrics.errorRates[service] = (metrics.errorRates[service] || 0) + 1;
  }

  metrics.requestCounts.total++;
}

/**
 * Otonom optimizasyon — her 5 dakikada çalışır
 * Metriklere bakarak circuit breaker eşiklerini ayarlar
 */
function autoOptimize() {
  const now = Date.now();
  const recommendations = [];

  for (const [service, entries] of Object.entries(metrics.apiLatency)) {
    if (entries.length < 10) continue;

    const recent = entries.filter(e => now - e.at < 300000); // Son 5dk
    if (recent.length < 5) continue;

    const avgLatency = recent.reduce((sum, e) => sum + e.ms, 0) / recent.length;
    const errorRate = recent.filter(e => !e.success).length / recent.length;

    // Yüksek latency → circuit breaker timeout'unu artır
    const breaker = getBreaker(service);
    if (avgLatency > 10000 && breaker.timeout < 45000) {
      breaker.timeout = Math.min(60000, breaker.timeout + 5000);
      recommendations.push({
        service,
        action: 'timeout_increased',
        from: breaker.timeout - 5000,
        to: breaker.timeout,
        reason: `Ortalama latency ${Math.round(avgLatency)}ms`
      });
    }

    // Düşük hata oranı → threshold'u gevşet (daha toleranslı)
    if (errorRate < 0.05 && breaker.failureThreshold < 10) {
      breaker.failureThreshold = Math.min(10, breaker.failureThreshold + 1);
      recommendations.push({
        service,
        action: 'threshold_relaxed',
        to: breaker.failureThreshold,
        reason: `Hata oranı düşük: ${(errorRate * 100).toFixed(1)}%`
      });
    }

    // Yüksek hata oranı → threshold'u sıkılaştır
    if (errorRate > 0.3 && breaker.failureThreshold > 2) {
      breaker.failureThreshold = Math.max(2, breaker.failureThreshold - 1);
      recommendations.push({
        service,
        action: 'threshold_tightened',
        to: breaker.failureThreshold,
        reason: `Hata oranı yüksek: ${(errorRate * 100).toFixed(1)}%`
      });
    }
  }

  if (recommendations.length > 0) {
    metrics.lastOptimization = { at: new Date().toISOString(), recommendations };
    logger.info('Otonom optimizasyon uygulandı', { count: recommendations.length, recommendations });
  }

  return recommendations;
}

// 5 dakikada bir otomatik optimizasyon
setInterval(autoOptimize, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════
// 4. SELF-HEAL — Hata Kök Neden Analizi
// ═══════════════════════════════════════════════════════

const errorHistory = []; // Son 50 hata
const MAX_ERROR_HISTORY = 50;

/**
 * Hata kaydet ve kök neden analizi yap
 */
function recordError(service, error, context = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    service,
    message: error.message || error,
    stack: error.stack?.split('\n').slice(0, 3).join('\n'),
    context: summarize(context),
    rootCause: analyzeRootCause(error, service),
    autoAction: null
  };

  errorHistory.push(entry);
  if (errorHistory.length > MAX_ERROR_HISTORY) errorHistory.shift();

  // Otomatik düzeltme dene
  const action = attemptSelfHeal(entry);
  entry.autoAction = action;

  if (action) {
    logger.info('Self-heal uygulandı', { service, action: action.type, detail: action.detail });
  }

  return entry;
}

function analyzeRootCause(error, service) {
  const msg = (error.message || '').toLowerCase();

  if (msg.includes('timeout') || msg.includes('timed out')) return 'API_TIMEOUT';
  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('quota')) return 'RATE_LIMITED';
  if (msg.includes('unauthorized') || msg.includes('401') || msg.includes('forbidden')) return 'AUTH_FAILURE';
  if (msg.includes('not found') || msg.includes('404')) return 'RESOURCE_NOT_FOUND';
  if (msg.includes('network') || msg.includes('econnrefused') || msg.includes('enotfound')) return 'NETWORK_ERROR';
  if (msg.includes('memory') || msg.includes('heap')) return 'MEMORY_PRESSURE';
  if (msg.includes('firestore') || msg.includes('deadline')) return 'DATABASE_ERROR';

  return 'UNKNOWN';
}

function attemptSelfHeal(errorEntry) {
  const { rootCause, service } = errorEntry;

  switch (rootCause) {
    case 'API_TIMEOUT':
      // Timeout → circuit breaker timeout artır
      const breaker = getBreaker(service);
      if (breaker.timeout < 60000) {
        breaker.timeout += 5000;
        return { type: 'TIMEOUT_INCREASED', detail: `${service} timeout → ${breaker.timeout}ms` };
      }
      break;

    case 'RATE_LIMITED':
      // Rate limit → istek hızını yavaşlat (bilgi ver)
      return { type: 'RATE_LIMIT_WARNING', detail: `${service} rate limit'e ulaştı — istekler yavaşlatılmalı` };

    case 'MEMORY_PRESSURE':
      // Bellek baskısı — shadow log'u temizle
      shadowLog.length = 0;
      return { type: 'MEMORY_CLEANED', detail: 'Shadow log temizlendi' };

    case 'NETWORK_ERROR':
      // Ağ hatası — circuit breaker'ı aç
      getBreaker(service).reset();
      return { type: 'CIRCUIT_RESET', detail: `${service} circuit breaker sıfırlandı` };
  }

  return null;
}

function getErrorStats() {
  const recent = errorHistory.filter(e => Date.now() - new Date(e.timestamp).getTime() < 3600000); // Son 1 saat
  const byService = {};
  const byRootCause = {};

  recent.forEach(e => {
    byService[e.service] = (byService[e.service] || 0) + 1;
    byRootCause[e.rootCause] = (byRootCause[e.rootCause] || 0) + 1;
  });

  return {
    totalErrors: errorHistory.length,
    lastHour: recent.length,
    byService,
    byRootCause,
    selfHealActions: errorHistory.filter(e => e.autoAction).length,
    lastError: errorHistory[errorHistory.length - 1] || null
  };
}

// ═══════════════════════════════════════════════════════
// 5. ROLLBACK — Optimizasyon geri alma
// ═══════════════════════════════════════════════════════

const snapshots = []; // Önceki durumlar
const MAX_SNAPSHOTS = 10;

function takeSnapshot(reason) {
  const snap = {
    at: new Date().toISOString(),
    reason,
    circuitBreakers: {},
    taskSkills: JSON.parse(JSON.stringify(taskSkills))
  };
  // Circuit breaker durumlarını kaydet
  try {
    const { getAllStates } = require('../utils/circuit-breaker');
    snap.circuitBreakers = getAllStates();
  } catch(e) {}

  snapshots.push(snap);
  if (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();
  return snap;
}

function rollback() {
  if (snapshots.length === 0) return { ok: false, reason: 'Snapshot yok' };
  const snap = snapshots.pop();

  // Circuit breaker'ları geri al
  try {
    const { getBreaker } = require('../utils/circuit-breaker');
    for (const cb of (snap.circuitBreakers || [])) {
      const breaker = getBreaker(cb.name);
      breaker.reset();
    }
  } catch(e) {}

  // Skill'leri geri al
  Object.keys(taskSkills).forEach(k => delete taskSkills[k]);
  Object.assign(taskSkills, snap.taskSkills);

  logger.info('Rollback uygulandı', { to: snap.at, reason: snap.reason });
  return { ok: true, restoredTo: snap.at, reason: snap.reason };
}

// ═══════════════════════════════════════════════════════
// 6. ESCALATION — İnsan müdahalesi protokolü
// ═══════════════════════════════════════════════════════

const ESCALATION_THRESHOLDS = {
  consecutiveErrors: 5,     // 5 ardışık hata → escalate
  errorRatePercent: 40,     // %40 hata oranı → escalate
  circuitOpen: true,        // Circuit açılırsa → escalate
  selfHealFailed: 3,        // 3 başarısız self-heal → escalate
};

let escalationCallbacks = [];

function onEscalation(callback) {
  escalationCallbacks.push(callback);
}

function checkEscalation() {
  const errors = getErrorStats();
  const reasons = [];

  if (errors.lastHour >= ESCALATION_THRESHOLDS.consecutiveErrors) {
    reasons.push(`Son 1 saatte ${errors.lastHour} hata`);
  }

  // Circuit breaker kontrolü
  try {
    const { getAllStates } = require('../utils/circuit-breaker');
    const openCircuits = getAllStates().filter(c => c.state === 'OPEN');
    if (openCircuits.length > 0) {
      reasons.push(`Circuit OPEN: ${openCircuits.map(c => c.name).join(', ')}`);
    }
  } catch(e) {}

  if (reasons.length > 0) {
    const escalation = {
      timestamp: new Date().toISOString(),
      severity: reasons.length >= 2 ? 'critical' : 'warning',
      reasons,
      message: `Fenix müdahale istiyor: ${reasons.join(' | ')}`
    };

    // Tablet'e bildirim gönder
    if (global.io) {
      global.io.emit('fenix_escalation', escalation);
    }

    // Callback'leri çalıştır
    escalationCallbacks.forEach(cb => {
      try { cb(escalation); } catch(e) {}
    });

    logger.warn('ESCALATION — İnsan müdahalesi gerekli', escalation);
    return escalation;
  }

  return null;
}

// 2 dakikada bir escalation kontrolü
setInterval(checkEscalation, 2 * 60 * 1000);

// Optimizasyon öncesi snapshot al
const _origAutoOptimize = autoOptimize;
const autoOptimizeWithSnapshot = function() {
  takeSnapshot('pre-optimization');
  return _origAutoOptimize();
};

// ═══════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════

function getFullStatus() {
  return {
    orchestration: {
      skills: { ...taskSkills },
      routingExample: {
        simple: routeTask('scene_generation', 'simple'),
        normal: routeTask('scene_generation', 'normal'),
        critical: routeTask('scene_generation', 'critical'),
      }
    },
    shadowLearning: getShadowStats(),
    optimization: {
      metrics: {
        requestsTotal: metrics.requestCounts.total,
        lastOptimization: metrics.lastOptimization
      }
    },
    selfHeal: getErrorStats()
  };
}

// ═══════════════════════════════════════════════════════
// 5. BUG HAFIZASI — Fenix'in Ders Defteri
// Düzeltilen her bug buraya kaydedilir.
// Fenix yeni kod yazarken önce buraya bakar.
// ═══════════════════════════════════════════════════════

const lessonLog = []; // In-memory; Firestore'a da yazılır
const MAX_LESSONS = 10000;

/**
 * Yeni bir ders (bug/çözüm) kaydet
 * @param {string} category  - 'audio', 'video', 'performance', 'api', 'ui', 'css', vb.
 * @param {string} bug       - Hatanın kısa açıklaması
 * @param {string} cause     - Neden oldu?
 * @param {string} fix       - Nasıl düzeltildi?
 * @param {string} [file]    - Hangi dosyada?
 * @param {string} [actor]   - Kim düzeltti? (claude/bedrihan/gemini)
 */
async function recordLesson({ category, bug, cause, fix, file = null, actor = 'claude' }) {
  const entry = {
    id: Date.now().toString(36),
    timestamp: new Date().toISOString(),
    category,
    bug,
    cause,
    fix,
    file,
    actor,
  };

  lessonLog.push(entry);
  if (lessonLog.length > MAX_LESSONS) lessonLog.shift();

  logger.info('📚 Fenix ders öğrendi', { category, bug: bug.substring(0, 60) });

  // Canlı arayüz için socket yayını
  try {
    if (global.io) {
      global.io.emit('fenix:lesson', {
        ...entry,
        total: lessonLog.length
      });
    }
  } catch(e) { /* socket yoksa geç */ }

  // Firestore'a da yaz (kalıcı)
  const db = getDb();
  if (db) {
    try {
      await db.collection('fenix-memory').doc(entry.id).set(entry);
    } catch(e) {
      logger.warn('Fenix hafızası Firestore yazma hatası', { error: e.message });
    }
  }

  return entry;
}

/**
 * Dersleri getir — Fenix'in context injection için kullanır
 * @param {string} [category] - Filtrele (opsiyonel)
 * @param {number} [limit=20] - Max kaç ders
 */
async function getLessons({ category = null, limit = 20 } = {}) {
  // Önce Firestore'dan yükle (yoksa memory'den)
  const db = getDb();
  if (db) {
    try {
      let query = db.collection('fenix-memory').orderBy('timestamp', 'desc').limit(limit);
      if (category) query = query.where('category', '==', category);
      const snap = await query.get();
      if (!snap.empty) {
        return snap.docs.map(d => d.data());
      }
    } catch(e) { /* Firestore yoksa memory'e düş */ }
  }

  // Memory fallback
  let results = [...lessonLog].reverse();
  if (category) results = results.filter(l => l.category === category);
  return results.slice(0, limit);
}

/**
 * Kategori bazlı özet — Fenix'in prompt'una eklenir
 */
async function getLessonsByCategory() {
  const all = await getLessons({ limit: 200 });
  const grouped = {};
  all.forEach(l => {
    if (!grouped[l.category]) grouped[l.category] = [];
    grouped[l.category].push(`• [${l.timestamp.slice(0,10)}] ${l.bug} → ${l.fix}`);
  });
  return grouped;
}

// Başlangıçta Firestore'dan hafızayı yükle + seed dersleri ekle
(async () => {
  const db = getDb();
  if (db) {
    try {
      const snap = await db.collection('fenix-memory').orderBy('timestamp', 'desc').limit(100).get();
      snap.docs.forEach(d => lessonLog.unshift(d.data()));
      logger.info(`📚 Fenix hafızası yüklendi: ${lessonLog.length} ders`);
    } catch(e) { /* sessiz — Firestore yoksa skip */ }
  }

  // Seed: Eğer hiç ders yoksa, bilinen bug fix'leri yükle
  if (lessonLog.length === 0) {
    const seedLessons = [
      {
        category: 'audio',
        bug: 'Analiz sırasında 3-4 ses aynı anda çalıyor',
        cause: '_trendPreviewAudio ve JamendoAPI.currentPreviewAudio, generateMultiProductReels başlamadan önce durdurulmuyordu',
        fix: 'generateMultiProductReels() başında tüm audio kaynakları (customMusicAudio, _trendPreviewAudio, JamendoAPI.currentPreviewAudio, currentPreviewAudio) durdurulup null\'a set ediliyor',
        file: 'public/photoreel_v9.html',
        actor: 'claude'
      },
      {
        category: 'performance',
        bug: 'PhotoReel sayfası açılınca bilgisayar donuyor (kasma)',
        cause: 'OfflineAudioContext tüm ses dosyasını işliyordu — büyük dosyalarda milyonlarca sample yükleniyor, CPU kilitleniyor',
        fix: 'detectAndStoreBPM() içinde: blob 512KB\'ye slice edildi, AudioContext sampleRate 22050Hz\'e düşürüldü, max 30 saniye analiz edildi. Pipeline başlatma requestIdleCallback\'e taşındı',
        file: 'public/photoreel_v9.html',
        actor: 'claude'
      },
      {
        category: 'layout',
        bug: 'PhotoReel arayüzü tablet/mobil/ultrawide ekranlara uymuyor',
        cause: 'Ana grid 290px 1fr 310px sabit piksel değerleriyle tanımlanmıştı, küçük ekranlarda overflow ve bozulma',
        fix: 'photoreel-fluid.css oluşturuldu: clamp() ile fluid kolonlar, tablet için 2-kolon, mobil için tab bar + tek kolon düzeni',
        file: 'public/photoreel-fluid.css',
        actor: 'claude'
      }
    ];
    for (const lesson of seedLessons) {
      await recordLesson(lesson);
    }
    logger.info('📚 Fenix hafızası seed verileriyle başlatıldı (3 ders)');
  }
})();

// ═══════════════════════════════════════════════════════
// 7. TRAFİK PATTERN ÖĞRENMESİ
// Fenix bağlantı/istek pattern'lerini öğrenir,
// anomali tespit eder, otomatik ölçekleme önerir
// ═══════════════════════════════════════════════════════

const trafficPatterns = {
  hourlyBaseline: new Array(24).fill(0), // Saatlik ortalama bağlantı
  sampleCount: 0,
  anomalies: [],            // Son 20 anomali
  predictions: {},          // Tahmini yoğunluk saatleri
  lastAnalysis: null,
};

// Firestore'dan trafik pattern'lerini yükle
(async () => {
  const db = getDb();
  if (!db) return;
  try {
    const doc = await db.collection('system').doc('fenix-traffic-patterns').get();
    if (doc.exists) {
      const data = doc.data();
      if (data.hourlyBaseline) trafficPatterns.hourlyBaseline = data.hourlyBaseline;
      if (data.sampleCount) trafficPatterns.sampleCount = data.sampleCount;
      if (data.predictions) trafficPatterns.predictions = data.predictions;
      logger.info('📊 Trafik pattern\'leri yüklendi', { samples: data.sampleCount });
    }
  } catch(e) { logger.warn('Trafik pattern yüklenemedi', { error: e.message }); }
})();

/**
 * Trafik snapshot'ı al — her 10 dakikada çağrılır
 * Fenix saatlik trafik yoğunluğunu öğrenir
 */
function learnTrafficPattern(currentConnections, currentRequests) {
  const hour = new Date().getHours();
  trafficPatterns.sampleCount++;

  // Exponential moving average — eski verileri yavaşça unut
  const alpha = 0.1;
  trafficPatterns.hourlyBaseline[hour] =
    trafficPatterns.hourlyBaseline[hour] * (1 - alpha) + currentConnections * alpha;

  // Anomali tespiti — ortalamadan 3x sapma
  const baseline = trafficPatterns.hourlyBaseline[hour];
  if (baseline > 5 && currentConnections > baseline * 3) {
    const anomaly = {
      timestamp: new Date().toISOString(),
      hour,
      expected: Math.round(baseline),
      actual: currentConnections,
      ratio: (currentConnections / baseline).toFixed(1) + 'x',
      type: 'TRAFFIC_SPIKE'
    };
    trafficPatterns.anomalies.push(anomaly);
    if (trafficPatterns.anomalies.length > 20) trafficPatterns.anomalies.shift();

    logger.warn('🚨 Trafik anomalisi tespit edildi', anomaly);

    // Tablet'e bildir
    if (global.io) {
      global.io.emit('fenix_escalation', {
        severity: 'warning',
        reasons: [`Trafik spike: ${anomaly.ratio} (beklenen: ${anomaly.expected}, gerçek: ${anomaly.actual})`],
        message: 'Beklenmedik trafik artışı — DDoS veya viral içerik olabilir'
      });
    }
  }

  // Tahmin güncelle — en yoğun 3 saat
  const indexed = trafficPatterns.hourlyBaseline.map((v, i) => ({ hour: i, avg: v }));
  indexed.sort((a, b) => b.avg - a.avg);
  trafficPatterns.predictions = {
    peakHours: indexed.slice(0, 3).map(h => h.hour),
    quietHours: indexed.slice(-3).map(h => h.hour),
    updatedAt: new Date().toISOString()
  };

  trafficPatterns.lastAnalysis = new Date().toISOString();
}

// Her 10 dakikada trafik öğren + Firestore'a kaydet
setInterval(async () => {
  try {
    // global trafficStats'dan oku (server.js'den)
    const io = global.io;
    const connCount = io ? io.engine?.clientsCount || 0 : 0;
    learnTrafficPattern(connCount, 0);

    // Firestore'a kaydet
    const db = getDb();
    if (db && trafficPatterns.sampleCount % 6 === 0) { // Her saatte bir kaydet
      await db.collection('system').doc('fenix-traffic-patterns').set({
        hourlyBaseline: trafficPatterns.hourlyBaseline,
        sampleCount: trafficPatterns.sampleCount,
        predictions: trafficPatterns.predictions,
        updatedAt: new Date().toISOString()
      });
    }
  } catch(e) { logger.warn('Trafik pattern kayıt hatası', { error: e.message }); }
}, 10 * 60 * 1000);

function getTrafficInsights() {
  return {
    hourlyBaseline: trafficPatterns.hourlyBaseline.map(v => Math.round(v)),
    sampleCount: trafficPatterns.sampleCount,
    anomalies: trafficPatterns.anomalies.slice(-5),
    predictions: trafficPatterns.predictions,
    lastAnalysis: trafficPatterns.lastAnalysis
  };
}

module.exports = {
  routeTask,
  getSkillLevel,
  getSkillScore,
  SKILL_LEVELS,

  // Shadow Learning
  recordShadow,
  getShadowStats,
  updateSkill,

  // Otonom Optimizasyon
  recordMetric,
  autoOptimize: autoOptimizeWithSnapshot,

  // Self-Heal
  recordError,
  getErrorStats,
  attemptSelfHeal,

  // Rollback
  takeSnapshot,
  rollback,

  // Escalation
  onEscalation,
  checkEscalation,

  // FAZA 1-8 Servislerden Gelen Loglar
  logShadow,

  // Genel
  getFullStatus,

  // Bug Hafızası
  recordLesson,
  getLessons,
  getLessonsByCategory,

  // Trafik Öğrenme
  learnTrafficPattern,
  getTrafficInsights,
};
