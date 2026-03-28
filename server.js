const config = require('./config');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const logger = require('./utils/logger');
const { errorHandler, notFoundHandler, setupGlobalHandlers } = require('./middlewares/error');

// Global hata yakalama
setupGlobalHandlers();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: config.allowedOrigins },
  maxHttpBufferSize: 1e6, // 1MB max payload
  connectTimeout: 10000,
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 }
});

// Global io — fenix-brain ve diğer servisler socket emit için kullanır
global.io = io;

// Socket.io connection limit — DDoS koruması
const MAX_CONNECTIONS = 100;
let connectionCount = 0;
app.use(cors({
  origin: function(origin, cb) {
    if (!origin || config.allowedOrigins.includes(origin)) return cb(null, true);
    cb(null, false);
  }
}));
// Güvenlik
const { promptInjectionGuard, authLimiter, bruteForceCheck, auditLog } = require('./middlewares/security');
// Güvenlik — production'da tam Helmet, dev'de minimal (uzantı uyumu)
if (config.isProd) {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        mediaSrc: ["'self'", "blob:", "data:"],
        connectSrc: ["'self'", "ws:", "wss:", ...config.allowedOrigins],
      }
    }
  }));
} else {
  // Dev — minimal güvenlik, tarayıcı uzantılarıyla uyumlu
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
    frameguard: false,
    hsts: false, // localhost'u HTTPS'e zorlama
  }));
}
app.use(require('cookie-parser')()); // httpOnly cookie desteği
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting — sadece production'da aktif
if (config.env === 'production') {
  const limiter = rateLimit({
    windowMs: config.rateLimitWindow,
    max: config.rateLimitMax,
    message: { ok: false, error: 'Çok fazla istek. Lütfen bekleyin.' }
  });
  app.use('/api/', limiter);
}

// Landing page — "Yakında" sayfası
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing-soon.html'));
});

// Waitlist kayıt
app.post('/api/waitlist', async (req, res) => {
  const { email, lang } = req.body || {};
  if (!email || !email.includes('@')) return res.status(400).json({ ok: false });
  try {
    const admin = require('firebase-admin');
    await admin.firestore().collection('fenix-waitlist').add({
      email: email.toLowerCase().trim(),
      lang: lang || 'tr',
      createdAt: new Date().toISOString()
    });
  } catch(e) { /* Firestore yoksa sessizce geç */ }
  require('./utils/logger').info('Waitlist kaydı', { email });
  res.json({ ok: true });
});

// Dashboard (admin)
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// PhotoReel v9 app (eski) — /legacy olarak taşındı
app.get('/legacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'photoreel_v9.html'));
});

// Fenix AI (yeni arayüz)
app.get('/fenix', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'fenix.html'));
});

// Static dosyalar — cache headers ile
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: config.isProd ? '1d' : 0,
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    // HTML dosyaları cache'lenmesin (güncelleme anında güncel kalsın)
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
    // JSON dosyalar kısa cache
    else if (filePath.endsWith('.json')) {
      res.setHeader('Cache-Control', 'public, max-age=300'); // 5dk
    }
  }
}));

// API routes
const chatRoutes = require('./routes/api-chat');
app.use('/api/chat', chatRoutes(io));

// Agent API (tablet uzaktan kontrol)
const agentRoutes = require('./routes/api-agent');
app.use('/api/agent', agentRoutes);

// Local Claude (prompt injection korumalı)
const localClaudeRoutes = require('./routes/api-local-claude');
app.use('/api/claude-local', localClaudeRoutes);

// Gemini Kod Asistanı (tablet'ten dosya erişimi)
const codeRoutes = require('./routes/api-gemini-code');
app.use('/api/code', codeRoutes);

// Fenix Kontrol Paneli v2 (ember tasarım)
app.get('/kontrol', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kontrol2.html'));
});

// Eski kontrol paneli — arşiv
app.get('/kontrol-v1', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kontrol.html'));
});

// Fenix Analytics (video performans)
app.get('/analytics', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'fenix-analytics.html'));
});

// Admin auth kontrolü — httpOnly cookie veya Authorization header
const jwt = require('jsonwebtoken');
function requireAdmin(req, res, next) {
  const jwtSecret = process.env.JWT_SECRET;
  // Production'da JWT_SECRET zorunlu — fallback YOK
  if (!jwtSecret) {
    logger.error('KRITIK: JWT_SECRET env var eksik!');
    return res.status(500).json({ ok: false, error: 'Sunucu yapılandırma hatası.' });
  }
  // Cookie kontrolü
  const cookie = req.cookies && req.cookies.fenix_admin;
  // Header kontrolü (Bearer token)
  const header = req.headers.authorization && req.headers.authorization.replace('Bearer ', '');
  const token = cookie || header;
  // next parametresi whitelist ile sınırlandırılmış — open redirect engeli
  const ALLOWED_NEXT = ['/kontrol', '/satici', '/qr', '/dashboard', '/analytics'];
  const nextPath = req.originalUrl;
  const safeNext = ALLOWED_NEXT.includes(nextPath.split('?')[0]) ? nextPath : '/kontrol';
  if (!token) return res.redirect('/giris?next=' + encodeURIComponent(safeNext));
  try {
    const payload = jwt.verify(token, jwtSecret);
    if (payload.role !== 'admin') throw new Error('Yetersiz yetki');
    req.adminUser = payload;
    next();
  } catch {
    res.clearCookie('fenix_admin');
    return res.redirect('/giris?next=' + encodeURIComponent(req.originalUrl));
  }
}

// Giriş sayfası (herkese açık)
app.get('/giris', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'giris.html'));
});

// Müşteri portalı — herkese açık (5 ücretsiz video)
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// Müşteri kayıt & quota API
const customerRoutes = require('./routes/api-customer');
app.use('/api/customer', customerRoutes);

// Satıcı portalı — sadece admin girebilir
app.get('/satici', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'satici.html'));
});

// QR sayfası — sadece admin
app.get('/qr', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'qr.html'));
});

// Versiyon & sistem sağlığı (kontrol paneli için) — TEK endpoint
app.get('/api/version', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  const pkg = (() => { try { return require('./package.json'); } catch { return {}; } })();
  res.json({
    ok: true,
    version: pkg.version || '1.0.0',
    name: pkg.name || 'fenix-ai',
    env: config.env || 'production',
    uptime: Math.floor(process.uptime()),
    nodeVersion: process.version,
    timestamp: new Date().toISOString(),
    revision: process.env.K_REVISION || 'dev',
    ts: process.env.DEPLOY_TS || Date.now(),
    services: {
      firestore: !!process.env.GOOGLE_APPLICATION_CREDENTIALS || !!process.env.FIREBASE_PROJECT_ID,
      gemini: !!process.env.GEMINI_API_KEY,
      fal: !!process.env.FAL_KEY,
      elevenlabs: !!process.env.ELEVENLABS_API_KEY,
      deepgram: !!process.env.DEEPGRAM_API_KEY
    }
  });
});

// Kod Review API (Gemini denetçi)
const codeReviewer = require('./services/code-reviewer');
app.get('/api/code/review', async (req, res) => {
  try {
    const minutes = parseInt(req.query.minutes) || 30;
    const result = await codeReviewer.autoReview(config.geminiApiKey, minutes);
    // Kritik issue varsa tablet'e bildirim gönder
    const criticals = (result.issues || []).filter(i => i.severity === 'critical');
    if (criticals.length > 0 && global.io) {
      global.io.emit('code_review', {
        type: 'critical',
        count: criticals.length,
        issues: criticals,
        summary: result.summary
      });
    }
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.get('/api/code/review/history', (req, res) => {
  res.json({ ok: true, ...codeReviewer.loadHistory() });
});
app.get('/api/code/changed', (req, res) => {
  const minutes = parseInt(req.query.minutes) || 30;
  const files = codeReviewer.getRecentlyChangedFiles(minutes);
  res.json({ ok: true, files, count: files.length });
});

// Onay sistemi API
const approvalRoutes = require('./routes/api-approval');
app.use('/api/approval', approvalRoutes);

// Auth API (email tabanlı kayıt/giriş)
const authRoutes = require('./routes/api-auth');
app.use('/api/auth', authRoutes);

// Terminal output API (bilgisayardan tablete canlı kod akışı)
const { validate, schemas } = require('./middlewares/validate');
const { sanitizeTerminalOutput, maskSensitive } = require('./utils/sanitize');
const terminalBuffer = [];
app.post('/api/terminal/output', validate(schemas.terminalOutput), (req, res) => {
  const { text } = req.body;
  if (text) {
    const safeText = maskSensitive(sanitizeTerminalOutput(text));
    terminalBuffer.push({ text: safeText, timestamp: new Date().toISOString() });
    if (terminalBuffer.length > 200) terminalBuffer.shift();
    if (global.io) global.io.emit('terminal_output', safeText);
  }
  res.json({ ok: true });
});

// Terminal buffer getir (polling için)
app.get('/api/terminal/lines', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const newLines = terminalBuffer.slice(since);
  res.json({ lines: newLines, total: terminalBuffer.length });
});

// Kuyruk API
const queue = require('./services/queue-service');
app.post('/api/queue/enqueue', validate(schemas.queueEnqueue), (req, res) => {
  const { type, payload, userId } = req.body;
  const result = queue.enqueue(type, payload, userId);
  result.then(r => res.json({ ok: true, ...r }));
});
app.get('/api/queue/job/:jobId', (req, res) => {
  const job = queue.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'Görev bulunamadı' });
  res.json({ ok: true, job });
});
app.get('/api/queue/stats', (req, res) => {
  res.json({ ok: true, stats: queue.getStats() });
});

// Socket.io ile kuyruk bildirimleri
queue.on('job:completed', (job) => {
  if (global.io) global.io.emit('job_completed', { jobId: job.id, type: job.type, userId: job.userId });
});
queue.on('job:failed', (job) => {
  if (global.io) global.io.emit('job_failed', { jobId: job.id, type: job.type, error: job.error });
});
queue.on('job:progress', (job) => {
  if (global.io) global.io.emit('job_progress', { jobId: job.id, progress: job.progress });
});

// === FAZA 1: ÇEKIRDEK MOTOR ===

// Ürün Analiz API
const productAnalyzer = require('./services/product-analyzer');
app.post('/api/product/analyze', validate(schemas.productAnalyze), async (req, res) => {
  try {
    const { image, mimeType } = req.body;
    const analysis = await productAnalyzer.analyzeProduct(image, mimeType || 'image/jpeg');
    res.json({ ok: true, analysis });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/product/analyze-multiple', validate(schemas.productAnalyzeMultiple), async (req, res) => {
  try {
    const { images } = req.body;
    const results = await productAnalyzer.analyzeMultipleProducts(images);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Arka Plan API
const bgGenerator = require('./services/background-generator');
app.post('/api/background/generate', validate(schemas.backgroundGenerate), (req, res) => {
  try {
    const { analysis, preferences } = req.body;
    const bgConfig = bgGenerator.generateBackgroundConfig(analysis, preferences || {});
    res.json({ ok: true, background: bgConfig });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/background/themes', (req, res) => {
  res.json({ ok: true, themes: bgGenerator.BG_THEMES });
});

// Müzik API
const musicService = require('./services/music-service');
app.post('/api/music/search', validate(schemas.musicSearch), async (req, res) => {
  try {
    const { analysis, duration } = req.body;
    const tracks = await musicService.searchMusic(analysis, { duration });
    res.json({ ok: true, tracks });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/music/beat-sync', validate(schemas.beatSync), (req, res) => {
  const { bpm, sceneDuration, sceneCount } = req.body;
  const sync = musicService.calculateBeatSync(bpm, sceneDuration, sceneCount);
  res.json({ ok: true, sync });
});

// Video Kurgu API
const videoEngine = require('./services/video-engine');
app.post('/api/video/storyboard', validate(schemas.videoStoryboard), async (req, res) => {
  try {
    const { images, options } = req.body;
    const storyboard = videoEngine.createStoryboard(images, options);
    const validation = videoEngine.validateStoryboard(storyboard);
    if (!validation.valid) {
      return res.status(400).json({ ok: false, errors: validation.errors });
    }
    res.json({ ok: true, storyboard });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/video/presets', (req, res) => {
  res.json({ ok: true, presets: videoEngine.PRESETS, transitions: Object.keys(videoEngine.TRANSITIONS) });
});

// AI Tool Calling API (auth korumalı)
const aiTools = require('./services/ai-tools');
const { requireAuth } = require('./middlewares/auth');
app.get('/api/tools', (req, res) => {
  res.json({ ok: true, tools: aiTools.getToolList() });
});
const { requirePermission } = require('./middlewares/security');
app.post('/api/tools/call', requireAuth, requirePermission('use_tools'), validate(schemas.toolCall), async (req, res) => {
  const { name, input, caller } = req.body;
  const result = await aiTools.callTool(name, input, caller);
  res.json({ ok: result.success, ...result });
});

// Auth endpoint (brute force korumalı)
const { generateToken } = require('./utils/jwt');
const { recordFailedAttempt, clearFailedAttempts } = require('./middlewares/security');
app.post('/api/auth/token', authLimiter, bruteForceCheck, auditLog('auth:token'), (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    recordFailedAttempt(req.ip);
    return res.status(400).json({ ok: false, error: 'userId gerekli' });
  }
  clearFailedAttempts(req.ip);
  const token = generateToken({ userId, role: 'user' });
  res.json({ ok: true, token });
});

// Circuit breaker durumu
const { getAllStates: getCircuitStates } = require('./utils/circuit-breaker');

// Fenix Brain — Orkestrasyon, Shadow Learning, Otonom Optimizasyon, Self-Heal
const fenixBrain = require('./services/fenix-brain');

// Fenix Brain API
app.get('/api/fenix/status', (req, res) => {
  res.json({ ok: true, ...fenixBrain.getFullStatus() });
});

app.get('/api/fenix/skills', (req, res) => {
  res.json({ ok: true, ...fenixBrain.getShadowStats() });
});

app.get('/api/fenix/errors', (req, res) => {
  res.json({ ok: true, ...fenixBrain.getErrorStats() });
});

app.post('/api/fenix/route', (req, res) => {
  const { taskType, complexity } = req.body;
  if (!taskType) return res.status(400).json({ ok: false, error: 'taskType gerekli' });
  const route = fenixBrain.routeTask(taskType, complexity || 'normal');
  res.json({ ok: true, route });
});

app.post('/api/fenix/shadow', (req, res) => {
  const { actor, taskType, input, output, outcome } = req.body;
  if (!actor || !taskType) return res.status(400).json({ ok: false, error: 'actor ve taskType gerekli' });
  const entry = fenixBrain.recordShadow(actor, taskType, input, output, outcome || 'success');
  res.json({ ok: true, entry, skillLevel: fenixBrain.getSkillLevel(taskType), skillScore: fenixBrain.getSkillScore(taskType) });
});

app.post('/api/fenix/optimize', (req, res) => {
  const recommendations = fenixBrain.autoOptimize();
  res.json({ ok: true, recommendations, count: recommendations.length });
});

app.post('/api/fenix/rollback', (req, res) => {
  const result = fenixBrain.rollback();
  res.json(result);
});

app.get('/api/fenix/escalation', (req, res) => {
  const result = fenixBrain.checkEscalation();
  res.json({ ok: true, escalation: result });
});

// Fenix Bug Hafızası API
app.get('/api/fenix/memory', async (req, res) => {
  try {
    const { category, limit } = req.query;
    const lessons = await fenixBrain.getLessons({ category, limit: parseInt(limit) || 20 });
    // Trainer'dan gerçek toplam sayısını al
    let total = lessons.length;
    try {
      if (fenixTrainer && fenixTrainer.getState) {
        const st = fenixTrainer.getState();
        total = st.totalLessons || lessons.length;
      }
    } catch(e) {}
    res.json({ ok: true, count: lessons.length, total, lessons });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/fenix/memory/summary', async (req, res) => {
  try {
    const grouped = await fenixBrain.getLessonsByCategory();
    res.json({ ok: true, grouped });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/fenix/memory', async (req, res) => {
  try {
    const { category, bug, cause, fix, file, actor } = req.body;
    if (!category || !bug || !fix) return res.status(400).json({ ok: false, error: 'category, bug, fix gerekli' });
    const entry = await fenixBrain.recordLesson({ category, bug, cause, fix, file, actor });
    res.json({ ok: true, entry });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Escalation → tablet bildirimi
fenixBrain.onEscalation((esc) => {
  if (global.io) {
    global.io.emit('approval_request', {
      id: 'esc_' + Date.now(),
      title: 'Fenix Yardım İstiyor',
      description: esc.message,
      type: 'escalation'
    });
  }
});

// Global erişim — diğer servisler kullanabilsin
global.fenixBrain = fenixBrain;

// ── Fenix Director — Otonom Video Üretim ──
const fenixDirector = require('./services/fenix-director');

app.post('/api/fenix/produce', async (req, res) => {
  try {
    const brief = req.body;
    if (!brief.kategori) return res.status(400).json({ ok: false, error: 'kategori gerekli' });
    res.json({ ok: true, message: 'Üretim başladı — bu birkaç dakika sürer' });
    fenixDirector.produce(brief).then(result => {
      if (global.io) global.io.emit('fenix:produce:done', result);
      logger.info('✅ Üretim tamamlandı', { skor: result.skor, sure: result.sure });
    }).catch(e => {
      if (global.io) global.io.emit('fenix:produce:error', { error: e.message });
      logger.error('Üretim hatası', { error: e.message });
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/fenix/produce/test', async (req, res) => {
  try {
    const kategori = req.body?.kategori || 'spor';
    res.json({ ok: true, message: `Test üretimi başladı — kategori: ${kategori}` });
    fenixDirector.testUret(kategori).then(result => {
      if (global.io) global.io.emit('fenix:produce:done', result);
    }).catch(e => {
      if (global.io) global.io.emit('fenix:produce:error', { error: e.message });
      logger.error('Test üretim hatası', { error: e.message });
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Fenix 360° İşleme — kategoriye özel pipeline ──
app.post('/api/fenix/360', async (req, res) => {
  try {
    const { kategori, dosyaYolu, sirketIsmi, kanca } = req.body;
    if (!kategori) return res.status(400).json({ ok: false, error: 'kategori gerekli' });
    const sonuc = await fenixDirector.isle360(kategori, dosyaYolu || '', { sirketIsmi, kanca });
    res.json(sonuc);
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Fenix Geri Bildirim — beğen/reddet → öğrenme döngüsü ──
app.post('/api/fenix/feedback', async (req, res) => {
  try {
    const { uretimId, kategori, karar, begendi } = req.body;
    if (!uretimId || !kategori || !karar) return res.status(400).json({ ok: false, error: 'uretimId, kategori, karar gerekli' });
    await fenixDirector.geribildirimIsle(uretimId, kategori, karar, !!begendi);
    res.json({ ok: true, mesaj: begendi ? '✅ Fenix öğrendi — bu kombinasyon güçlendi' : '❌ Fenix öğrendi — alternatif aranacak' });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Fenix Trainer API ──
const fenixTrainer = require('./services/fenix-trainer');

// MAKSİMUM bütçe kilidi — hiçbir şekilde $10 üstü harcama yapılamaz
const MAX_TRAIN_BUDGET = 20;

app.post('/api/fenix/train', async (req, res) => {
  const requested = parseFloat(req.body?.budget) || 5;
  // Güvenlik kilidi: max $10, min $1
  const budget = Math.min(MAX_TRAIN_BUDGET, Math.max(1, requested));

  if (fenixTrainer.getState().running) {
    return res.json({ ok: false, error: 'Eğitim zaten çalışıyor' });
  }

  logger.info(`🔥 Fenix eğitimi başlatıldı — $${budget} bütçe (istek: $${requested})`);
  res.json({ ok: true, message: `Eğitim başlatıldı ($${budget} bütçe)`, budget });
  fenixTrainer.runTraining(budget).catch(e =>
    logger.error('Trainer hatası', { error: e.message })
  );
});

app.post('/api/fenix/train/stop', (req, res) => {
  fenixTrainer.stop();
  res.json({ ok: true, message: 'Durdurma isteği gönderildi' });
});

app.get('/api/fenix/train/status', (req, res) => {
  res.json({ ok: true, ...fenixTrainer.getState() });
});

// ── Fenix Sağlık Kontrol Endpoint'i ──
app.get('/api/fenix/health', (req, res) => {
  const ts = fenixTrainer.getState();
  const issues = [];
  if (!ts.running && ts.totalCost < (ts.budget || 20) && ts.totalLessons > 0) {
    issues.push('Eğitim durdu ama bütçe bitmedi');
  }
  if (ts.totalCost >= (ts.budget || 20)) {
    issues.push('Bütçe tükendi — eğitim tamamlandı');
  }
  res.json({
    ok: true,
    healthy: issues.length === 0,
    issues,
    training: {
      running: ts.running,
      totalLessons: ts.totalLessons,
      totalCost: ts.totalCost,
      budget: ts.budget || 20,
      budgetPct: Math.round((ts.totalCost / (ts.budget || 20)) * 100),
      phase: ts.phase,
    },
    ts: new Date().toISOString(),
  });
});

// ── Watchdog: DEVRE DIŞI — Gemini API maliyeti kontrol altında tutmak için ──
// Manuel başlatma: POST /api/fenix/train { budget: 5 }
// setInterval(fenixWatchdog, 5 * 60 * 1000);

// Frontend config — public key'leri expose et (secret değil, client-side API)
app.get('/api/config', (req, res) => {
  res.json({
    geminiKey: process.env.GEMINI_API_KEY || '',
    version: process.env.npm_package_version || '1.0'
  });
});

// /api/version — yukarıda tek endpoint olarak tanımlandı

// Health check (Cloud Run için)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1048576) + 'MB',
      heap: Math.round(process.memoryUsage().heapUsed / 1048576) + 'MB'
    },
    connections: connectionCount,
    circuits: getCircuitStates()
  });
});

// OpenAPI 3.0 dokümantasyonu
app.get('/api/docs', (req, res) => {
  res.json({
    openapi: '3.0.3',
    info: {
      title: 'Fenix AI API',
      version: '1.1.0',
      description: 'E-ticaret ürün fotoğraflarından AI ile reels video üreten motor. Circuit breaker, Joi validasyon, JWT auth korumalı.'
    },
    servers: [
      { url: config.cloudUrl, description: 'Production (Cloud Run)' },
      { url: 'http://localhost:3000', description: 'Development' }
    ],
    paths: {
      '/api/auth/token': { post: { summary: 'JWT token al', tags: ['Auth'], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] } } } } } },
      '/api/chat/start': { post: { summary: 'Otomatik konuşma başlat', tags: ['Chat'], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { topic: { type: 'string' }, maxTurns: { type: 'integer', default: 20 } } } } } } } },
      '/api/chat/gemini': { post: { summary: 'Gemini\'ye mesaj gönder', tags: ['Chat'] } },
      '/api/chat/claude': { post: { summary: 'Claude\'a mesaj gönder', tags: ['Chat'] } },
      '/api/product/analyze': { post: { summary: 'Ürün fotoğrafı analiz et', tags: ['Product'], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { image: { type: 'string', description: 'base64 veya URL' }, mimeType: { type: 'string', default: 'image/jpeg' } }, required: ['image'] } } } } } },
      '/api/background/generate': { post: { summary: 'Arka plan konfigürasyonu üret', tags: ['Video'] } },
      '/api/music/search': { post: { summary: 'Müzik ara', tags: ['Video'] } },
      '/api/video/storyboard': { post: { summary: 'Video storyboard oluştur', tags: ['Video'] } },
      '/api/feedback': { post: { summary: 'Video geri bildirimi kaydet', tags: ['Feedback'] } },
      '/api/feedback/stats': { get: { summary: 'Geri bildirim istatistikleri', tags: ['Feedback'] } },
      '/api/queue/enqueue': { post: { summary: 'Kuyruğa görev ekle', tags: ['Queue'] } },
      '/api/agent/report': { post: { summary: 'Agent durum raporu', tags: ['Agent'] } },
      '/api/agent/command/:agentId': { post: { summary: 'Agent\'a komut gönder', tags: ['Agent'] } },
      '/api/approval/request': { post: { summary: 'Onay isteği oluştur', tags: ['Approval'] } },
      '/api/approval/pending': { get: { summary: 'Bekleyen onaylar', tags: ['Approval'] } },
      '/api/claude-local/send': { post: { summary: 'Tablet → Claude mesaj', tags: ['Claude Bridge'] } },
      '/api/claude-local/replies': { get: { summary: 'Claude yanıtları (polling)', tags: ['Claude Bridge'] } },
      '/health': { get: { summary: 'Sağlık kontrolü + circuit breaker durumu', tags: ['System'] } },
      '/api/fenix/status': { get: { summary: 'Fenix beyin durumu (orkestrasyon + öğrenme + optimizasyon)', tags: ['Fenix Brain'] } },
      '/api/fenix/skills': { get: { summary: 'Fenix yetkinlik seviyeleri (Shadow Learning)', tags: ['Fenix Brain'] } },
      '/api/fenix/errors': { get: { summary: 'Hata analizi + self-heal geçmişi', tags: ['Fenix Brain'] } },
      '/api/fenix/route': { post: { summary: 'Görev yönlendirme (kim yapacak?)', tags: ['Fenix Brain'] } },
      '/api/fenix/optimize': { post: { summary: 'Manuel otonom optimizasyon tetikle', tags: ['Fenix Brain'] } },
      '/api/video/formats': { get: { summary: 'Desteklenen video formatları', tags: ['Video Processing'] } },
      '/api/video/ffmpeg': { get: { summary: 'FFmpeg durumu', tags: ['Video Processing'] } },
      '/api/video/info': { post: { summary: 'Video bilgisi + kamera tipi tespiti', tags: ['Video Processing'] } },
      '/api/video/extract-audio': { post: { summary: 'Videodan ses ayır (FFmpeg)', tags: ['Video Processing'] } },
      '/api/video/convert-format': { post: { summary: 'Video format dönüşüm (reels/square/landscape)', tags: ['Video Processing'] } },
      '/api/video/trim': { post: { summary: 'Video kırp (start→end)', tags: ['Video Processing'] } },
      '/api/user/profile/:userId': { get: { summary: 'Kullanıcı profili (marka + stil)', tags: ['User Memory'] } },
      '/api/user/brand': { post: { summary: 'Marka kimliği kaydet', tags: ['User Memory'] } },
      '/api/user/style': { post: { summary: 'Stil tercihleri kaydet', tags: ['User Memory'] } },
      '/api/brand/generate-logo': { post: { summary: 'AI logo önerisi (Gemini)', tags: ['Brand'] } }
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' }
      }
    }
  });
});

// Socket.io connection + auth
const { socketAuth } = require('./middlewares/auth');
io.use(socketAuth);
global.io = io;

io.on('connection', (socket) => {
  connectionCount++;
  if (connectionCount > MAX_CONNECTIONS) {
    logger.warn('Socket.io bağlantı limiti aşıldı', { count: connectionCount, socketId: socket.id });
    socket.emit('error', { message: 'Çok fazla bağlantı' });
    socket.disconnect(true);
    connectionCount--;
    return;
  }
  logger.debug('Dashboard bağlandı', { socketId: socket.id, user: socket.user?.userId, total: connectionCount });
  socket.emit('status', { state: 'idle', message: 'Bağlantı kuruldu' });

  socket.on('disconnect', () => {
    connectionCount--;
    logger.debug('Dashboard ayrıldı', { socketId: socket.id, total: connectionCount });
  });
});

// === KOTA & MALIYET TAKIP SISTEMI (Firestore tabanlı — Cloud Run uyumlu) ===
const stateService = require('./services/state-service');

const DEFAULT_QUOTA = {
  gemini: { used: 0, limit: 1500, resetDate: new Date().toISOString().slice(0, 7) },
  claude: { used: 0, limit: 500, resetDate: new Date().toISOString().slice(0, 7) },
  cloudRun: { used: 0, limit: 2000000, resetDate: new Date().toISOString().slice(0, 7) },
  warnings: { gemini80: false, claude80: false, gemini100: false, claude100: false }
};

let quotaTracker = { ...DEFAULT_QUOTA };

// Başlangıçta Firestore'dan kota yükle
(async () => {
  try {
    const saved = await stateService.getQuota();
    if (saved) quotaTracker = saved;
    else await stateService.saveQuota(quotaTracker);
  } catch(e) { logger.warn('Kota Firestore yüklenemedi, varsayılan kullanılıyor'); }
})();

// Kota batch write — Gemini önerisi: her çağrıda değil, periyodik kaydet
let quotaDirty = false;
async function saveQuota() {
  quotaDirty = true; // Değişiklik var, bir sonraki flush'ta kaydedilecek
}
// 30 saniyede bir Firestore'a yaz (maliyet optimizasyonu)
setInterval(async () => {
  if (!quotaDirty) return;
  quotaDirty = false;
  try { await stateService.saveQuota(quotaTracker); }
  catch(e) { logger.error('Kota kaydetme hatası', { error: e.message }); quotaDirty = true; }
}, 30000);
// Process kapanırken son kota durumunu kaydet
process.on('SIGTERM', async () => {
  if (quotaDirty) { try { await stateService.saveQuota(quotaTracker); } catch(e) { logger.error('SIGTERM kota kayıt hatası', { error: e.message }); } }
  process.exit(0);
});

// Ay degisince kotayi sifirla
function checkQuotaReset() {
  const currentMonth = new Date().toISOString().slice(0, 7);
  ['gemini', 'claude', 'cloudRun'].forEach(service => {
    if (quotaTracker[service].resetDate !== currentMonth) {
      quotaTracker[service].used = 0;
      quotaTracker[service].resetDate = currentMonth;
    }
  });
  quotaTracker.warnings = { gemini80: false, claude80: false, gemini100: false, claude100: false };
}

// Kota kullanimi kaydet ve uyar
async function trackUsage(service) {
  checkQuotaReset();
  if (!quotaTracker[service]) return;
  quotaTracker[service].used++;
  saveQuota();

  const q = quotaTracker[service];
  const percent = (q.used / q.limit) * 100;

  // %80 uyarisi
  if (percent >= 80 && percent < 100 && !quotaTracker.warnings[`${service}80`]) {
    quotaTracker.warnings[`${service}80`] = true;
    await sendQuotaAlert(service, percent, q.used, q.limit);
  }
  // %100 uyarisi
  if (percent >= 100 && !quotaTracker.warnings[`${service}100`]) {
    quotaTracker.warnings[`${service}100`] = true;
    await sendQuotaAlert(service, percent, q.used, q.limit);
  }
}

async function sendQuotaAlert(service, percent, used, limit) {
  const serviceNames = { gemini: 'Gemini API', claude: 'Claude API', cloudRun: 'Cloud Run' };
  const status = percent >= 100 ? 'LIMIT DOLDU!' : 'Limite yaklasiliyor!';
  logger.warn('Kota uyarısı', { service: serviceNames[service], status, used, limit, percent: Math.round(percent) });
}

// Kota bilgisini disari ac (dashboard icin)
global.quotaTracker = quotaTracker;
global.trackUsage = trackUsage;

// === GERİ BİLDİRİM API (Fenix öğrenme döngüsü) ===
app.post('/api/feedback', validate(schemas.feedback), async (req, res) => {
  try {
    const { videoId, rating, category, templateUsed, transitionsUsed, musicUsed, comment, userId } = req.body;
    const saved = await stateService.saveFeedback({
      videoId: videoId || `v_${Date.now()}`,
      rating, category, templateUsed, transitionsUsed, musicUsed, comment, userId
    });
    res.json({ ok: saved, message: saved ? 'Geri bildirim kaydedildi' : 'Kayıt başarısız' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/feedback/history', async (req, res) => {
  try {
    const userId = req.query.userId || null;
    const limit = parseInt(req.query.limit) || 50;
    const history = await stateService.getFeedbackHistory(userId, limit);
    res.json({ ok: true, feedback: history });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/feedback/stats', async (req, res) => {
  try {
    const stats = await stateService.getFeedbackStats();
    res.json({ ok: true, stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Analytics: kapsamlı video performans özeti
app.get('/api/analytics/overview', async (req, res) => {
  try {
    const [fbStats, trainStatus, memSummary] = await Promise.allSettled([
      stateService.getFeedbackStats(),
      Promise.resolve(global.fenixTrainer ? global.fenixTrainer.getStatus() : {}),
      fetch(`http://localhost:${config.port || 3000}/api/fenix/memory/summary`).then(r => r.json()).catch(() => ({}))
    ]);

    const fb = fbStats.status === 'fulfilled' ? fbStats.value : {};
    const train = trainStatus.status === 'fulfilled' ? trainStatus.value : {};
    const mem = memSummary.status === 'fulfilled' ? memSummary.value : {};

    // Kategori bazlı performans
    const catPerf = {};
    if (fb.categories) {
      for (const [cat, data] of Object.entries(fb.categories)) {
        const total = (data.liked || 0) + (data.disliked || 0);
        catPerf[cat] = {
          liked: data.liked || 0,
          disliked: data.disliked || 0,
          total,
          satisfaction: total > 0 ? Math.round((data.liked / total) * 100) : null,
          avgScore: data.avgScore || null
        };
      }
    }

    res.json({
      ok: true,
      overview: {
        totalVideos: fb.total || 0,
        liked: fb.liked || 0,
        disliked: fb.disliked || 0,
        satisfaction: fb.total > 0 ? Math.round(((fb.liked || 0) / fb.total) * 100) : null,
        categories: catPerf,
        training: {
          totalLessons: train.totalLessons || 0,
          totalCost: train.totalCost || 0,
          phases: train.phases || []
        },
        memory: {
          topCategories: mem.topCategories || [],
          recentActivity: mem.recentActivity || []
        }
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// === VIDEO İŞLEME API (FFmpeg tabanlı) ===
const videoProcessor = require('./services/video-processor');

app.get('/api/video/formats', (req, res) => {
  res.json({ ok: true, formats: videoProcessor.FORMATS });
});

app.get('/api/video/ffmpeg', async (req, res) => {
  const status = await videoProcessor.checkFFmpeg();
  res.json({ ok: true, ...status });
});

app.post('/api/video/info', async (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ ok: false, error: 'filePath gerekli' });
    const info = await videoProcessor.getVideoInfo(filePath);
    const camera = videoProcessor.detectCameraType(info);
    res.json({ ok: true, info, camera });
  } catch(err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/video/extract-audio', async (req, res) => {
  try {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ ok: false, error: 'filePath gerekli' });
    const audioPath = await videoProcessor.extractAudio(filePath);
    // Shadow learning
    if (global.fenixBrain) global.fenixBrain.recordShadow('system', 'audio_extract', { filePath }, { audioPath }, 'success');
    res.json({ ok: true, audioPath });
  } catch(err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/video/convert-format', async (req, res) => {
  try {
    const { filePath, format } = req.body;
    if (!filePath || !format) return res.status(400).json({ ok: false, error: 'filePath ve format gerekli' });
    const result = await videoProcessor.convertFormat(filePath, format);
    if (global.fenixBrain) global.fenixBrain.recordShadow('system', 'format_convert', { format }, { path: result.path }, 'success');
    res.json({ ok: true, ...result });
  } catch(err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/video/trim', async (req, res) => {
  try {
    const { filePath, start, end } = req.body;
    if (!filePath || start == null || end == null) return res.status(400).json({ ok: false, error: 'filePath, start, end gerekli' });
    const outPath = await videoProcessor.trimVideo(filePath, start, end);
    res.json({ ok: true, path: outPath });
  } catch(err) { res.status(500).json({ ok: false, error: err.message }); }
});

// === KULLANICI HAFIZASI API (marka kimliği + stil) ===
const userMemory = require('./services/user-memory');

app.get('/api/user/profile/:userId', async (req, res) => {
  try {
    const profile = await userMemory.getProfile(req.params.userId);
    res.json({ ok: true, profile });
  } catch(err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/user/brand', async (req, res) => {
  try {
    const { userId, ...brand } = req.body;
    if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });
    const profile = await userMemory.saveBrandIdentity(userId, brand);
    if (global.fenixBrain) global.fenixBrain.recordShadow('user', 'brand_save', { userId }, { brandName: brand.name }, 'success');
    res.json({ ok: true, profile });
  } catch(err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/user/style', async (req, res) => {
  try {
    const { userId, ...prefs } = req.body;
    if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });
    const profile = await userMemory.saveStylePreferences(userId, prefs);
    res.json({ ok: true, profile });
  } catch(err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/user/video-history', async (req, res) => {
  try {
    const { userId, ...videoMeta } = req.body;
    if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });
    const profile = await userMemory.addVideoToHistory(userId, videoMeta);
    res.json({ ok: true, totalVideos: profile.totalVideos });
  } catch(err) { res.status(500).json({ ok: false, error: err.message }); }
});

// === LOGO ÜRETİMİ (Gemini ile) ===
app.post('/api/brand/generate-logo', async (req, res) => {
  try {
    const { brandName, category, primaryColor } = req.body;
    if (!brandName) return res.status(400).json({ ok: false, error: 'brandName gerekli' });

    const geminiService = require('./services/gemini-service');
    const prompt = `Marka adı "${brandName}" için ${category || 'genel'} kategorisinde minimalist, modern bir logo tasarımı oluştur. ${primaryColor ? 'Ana renk: ' + primaryColor + '.' : ''} Logo şık, profesyonel ve sosyal medyada kullanılabilir olmalı. Sadece logo açıklamasını ve SVG kodu öner.`;

    const response = await geminiService.sendMessage([], prompt, 'creative');
    if (global.fenixBrain) global.fenixBrain.recordShadow('gemini', 'logo_generation', { brandName, category }, { responseLength: response.length }, 'success');
    res.json({ ok: true, suggestion: response });
  } catch(err) { res.status(500).json({ ok: false, error: err.message }); }
});

// === LEARNING SYNC (Frontend localStorage → Firestore) ===
app.post('/api/feedback/sync-learning', async (req, res) => {
  try {
    const learningData = req.body;
    if (!learningData || typeof learningData.totalLikes !== 'number') {
      return res.status(400).json({ ok: false, error: 'Geçersiz öğrenme verisi' });
    }
    const firestore = stateService.isFirestoreAvailable() ? require('@google-cloud/firestore') : null;
    if (firestore) {
      const { Firestore } = firestore;
      const db = new Firestore({ projectId: config.firestoreProjectId });
      await db.collection('system').doc('learning-state').set({
        ...learningData,
        syncedAt: new Date().toISOString(),
        source: 'photoreel_v9_frontend'
      });
    }
    logger.info('Öğrenme durumu senkronize edildi', {
      totalLikes: learningData.totalLikes,
      totalDislikes: learningData.totalDislikes,
      categories: learningData.categories?.length || 0
    });
    res.json({ ok: true, message: 'Öğrenme durumu kaydedildi' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// === FEEDBACK-BASED LEARNING (basit ağırlıklı öğrenme) ===
// Gemini önerisi: vektör embedding olmadan kategori+template bazlı sıralama
app.get('/api/feedback/recommendations', async (req, res) => {
  try {
    const stats = await stateService.getFeedbackStats();
    const recommendations = {};

    // Kategori bazlı başarı oranı hesapla
    for (const [category, data] of Object.entries(stats.categories || {})) {
      const total = data.liked + data.disliked;
      if (total < 2) continue; // Yeterli veri yok
      const score = data.liked / total;
      recommendations[category] = {
        score: Math.round(score * 100),
        total,
        recommendation: score >= 0.7 ? 'favored' : score <= 0.3 ? 'avoid' : 'neutral'
      };
    }

    // En iyi ve en kötü kategoriler
    const sorted = Object.entries(recommendations).sort((a, b) => b[1].score - a[1].score);
    res.json({
      ok: true,
      recommendations,
      topCategories: sorted.slice(0, 5).map(([k, v]) => k),
      avoidCategories: sorted.filter(([k, v]) => v.recommendation === 'avoid').map(([k]) => k),
      totalFeedback: stats.total,
      overallSatisfaction: stats.total > 0 ? Math.round((stats.liked / stats.total) * 100) : null
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 404 ve hata yakalama (en sonda olmalı)
app.use(notFoundHandler);
app.use(errorHandler);

const PORT = config.port;
server.listen(PORT, () => {
  logger.info(`Fenix AI başlatıldı`, { port: PORT, env: config.env });
  logger.info(`Dashboard: http://localhost:${PORT}`);
  logger.info(`App: http://localhost:${PORT}/app`);
});
