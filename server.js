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

// === Firebase Admin SDK — Cloud Run'da ADC, lokalde serviceAccountKey ===
const admin = require('firebase-admin');
const fs = require('fs');
const saKeyPath = path.join(__dirname, 'serviceAccountKey.json');
if (fs.existsSync(saKeyPath)) {
  const serviceAccount = require(saKeyPath);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
    storageBucket: 'fenix-ar-models'
  });
  logger.info(`🔥 Firebase Admin başlatıldı — proje: ${serviceAccount.project_id} (LOKAL MODU)`);
} else {
  const projectId = process.env.FIRESTORE_PROJECT_ID || 'photoreel-491017';
  admin.initializeApp({
    projectId: projectId,
    storageBucket: 'fenix-ar-models'
  });
  logger.info(`🔥 Firebase Admin başlatıldı — proje: ${projectId} (CLOUD MODU — ADC)`);
}

// Global hata yakalama
setupGlobalHandlers();

const app = express();
// Cloud Run / GCP load balancer proxy güveni
app.set('trust proxy', 1);
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: config.allowedOrigins },
  maxHttpBufferSize: 2e6, // 2MB max payload
  connectTimeout: 15000,
  pingInterval: config.socketPingInterval || 25000,
  pingTimeout: config.socketPingTimeout || 20000,
  perMessageDeflate: config.socketPerMessageDeflate || false,
  connectionStateRecovery: { maxDisconnectionDuration: 5 * 60 * 1000 },
  // Binlerce bağlantı için transport optimizasyonu
  transports: ['websocket', 'polling'],
  allowUpgrades: true,
  httpCompression: true,
});

// Global io — fenix-brain ve diğer servisler socket emit için kullanır
global.io = io;

// === TRAFIK IZLEME & FENIX ÖĞRENME ===
const MAX_CONNECTIONS = config.maxConnections || 5000;
let connectionCount = 0;
const trafficStats = {
  totalConnections: 0,
  peakConnections: 0,
  totalRequests: 0,
  byEndpoint: {},
  byHour: new Array(24).fill(0),
  byCountry: {},
  connectionDurations: [],   // Son 100 bağlantı süresi
  errors5xx: 0,
  errors4xx: 0,
  startedAt: new Date().toISOString(),
};
app.use(cors({
  origin: function(origin, cb) {
    if (!origin) return cb(null, true);
    const allowed = config.allowedOrigins.some(o =>
      o instanceof RegExp ? o.test(origin) : o === origin
    );
    cb(null, allowed);
  }
}));
// Güvenlik
const { promptInjectionGuard, authLimiter, bruteForceCheck, auditLog } = require('./middlewares/security');
// Güvenlik — production'da tam Helmet, dev'de minimal (uzantı uyumu)
if (config.isProd) {
  app.use(helmet({
    contentSecurityPolicy: false
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
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));

// === REQUEST TRACKING MIDDLEWARE ===
app.use((req, res, next) => {
  const start = Date.now();
  trafficStats.totalRequests++;

  // Endpoint bazlı sayaç
  const endpoint = req.method + ' ' + (req.route ? req.route.path : req.path.split('?')[0]);
  trafficStats.byEndpoint[endpoint] = (trafficStats.byEndpoint[endpoint] || 0) + 1;

  // Response hook — latency + error tracking
  const origEnd = res.end;
  res.end = function(...args) {
    const latency = Date.now() - start;
    if (res.statusCode >= 500) trafficStats.errors5xx++;
    else if (res.statusCode >= 400) trafficStats.errors4xx++;

    // Yavaş istekleri Fenix'e bildir
    if (latency > 5000) {
      try {
        fenixBrain.recordMetric('http', latency, res.statusCode < 400);
        fenixBrain.recordShadow('system', 'slow_request',
          { path: req.path, method: req.method },
          { latency, status: res.statusCode },
          latency > 15000 ? 'failure' : 'partial'
        );
      } catch(e) {}
    }
    origEnd.apply(this, args);
  };

  next();
});

// Rate limiting — production + dev
const limiter = rateLimit({
  windowMs: config.rateLimitWindow,
  max: config.rateLimitMax,
  message: { ok: false, error: 'Çok fazla istek. Lütfen bekleyin.' },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    trafficStats.errors4xx++;
    try {
      fenixBrain.recordError('rateLimit', new Error('Rate limit hit: ' + req.ip), { path: req.path });
    } catch(e) {}
    res.status(429).json({ ok: false, error: 'Çok fazla istek. Lütfen bekleyin.' });
  }
});
app.use('/api/', limiter);

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

// Fenix AI → doğrudan editöre yönlendir
app.get('/fenix', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'fenix-editor.html'));
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

// Agent API (tablet uzaktan kontrol) — ADMIN ONLY
const agentRoutes = require('./routes/api-agent');
app.use('/api/agent', requireAdmin, agentRoutes);

// Local Claude (prompt injection korumalı)
const localClaudeRoutes = require('./routes/api-local-claude');
app.use('/api/claude-local', localClaudeRoutes);

// Gemini Kod Asistanı (tablet'ten dosya erişimi) — ADMIN ONLY
const codeRoutes = require('./routes/api-gemini-code');
app.use('/api/code', requireAdmin, codeRoutes);

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

// Workspace erişim kontrolü — customerId zorunlu (yoksa /app'e yönlendir)
function requireCustomer(req, res, next) {
  const cid = req.query.cid || '';
  // Basit format kontrolü — boş veya geçersiz format → /app
  if (!cid || !/^(phone_\d{7,15}|email_.{3,})$/.test(cid)) {
    return res.redirect('/app');
  }
  next();
}

// Reels workspace — ayrı kart sayfası
app.get('/workspace-reels', requireCustomer, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'workspace-reels.html'));
});

// Pro workspace — ayrı kart sayfası
app.get('/workspace-pro', requireCustomer, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'workspace-pro.html'));
});

// Dublaj workspace — ses klonlama + çoklu dil
app.get('/workspace-dublaj', requireCustomer, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'workspace-dublaj.html'));
});

// 360° workspace — ürün videosu + e-ticaret
app.get('/workspace-360', requireCustomer, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'workspace-360.html'));
});

// Otonom workspace — pipeline görünümü, Fenix tam kontrol
app.get('/workspace-otonom', requireCustomer, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'workspace-otonom.html'));
});

// Güvenlik middleware — tüm API'lerde IP ban kontrolü
const { ipBanCheck, auditLogger } = require('./middleware/auditLog');
app.use('/api', ipBanCheck);

// Güvenlik admin API
const securityRoutes = require('./routes/api-security');
app.use('/api/security', securityRoutes);

// Müşteri kayıt & quota API
const customerRoutes = require('./routes/api-customer');
app.use('/api/customer', customerRoutes);

// Hukuki onay & ses klonlama API
const consentRoutes = require('./routes/api-consent');
app.use('/api/consent', consentRoutes);

// Video üretim API — fal.ai Kling
const generateRoutes = require('./routes/api-generate');
app.use('/api/generate', generateRoutes);

const effectsRoutes = require('./routes/api-effects');
app.use('/api/effects', effectsRoutes);

// PRO Studio — FFmpeg post-processing
const proRoutes = require('./routes/api-pro');
app.use('/api/pro', proRoutes);

// Güvenlik paneli — sadece tablet cihaz anahtarıyla
const TABLET_KEY = process.env.TABLET_KEY || '';
const TABLET_COOKIE = 'fenix_tablet';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000; // 1 yıl

function requireTablet(req, res, next) {
  const queryKey = req.query.key;
  const cookieKey = req.cookies && req.cookies[TABLET_COOKIE];

  // İlk kez doğru key ile geldi → cookie yaz
  if (queryKey && TABLET_KEY && queryKey === TABLET_KEY) {
    res.cookie(TABLET_COOKIE, TABLET_KEY, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: COOKIE_MAX_AGE
    });
    return next();
  }

  // Cookie varsa ve doğruysa izin ver
  if (cookieKey && TABLET_KEY && cookieKey === TABLET_KEY) {
    return next();
  }

  // Hiçbiri yoksa → engelle
  return res.status(403).send(`
    <html><body style="background:#050508;color:#ef4444;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;text-align:center">
      <div><div style="font-size:48px">🛡</div><h2 style="margin:16px 0">Erişim Engellendi</h2><p style="color:#8a8a9a">Bu sayfa yalnızca yetkili cihazdan erişilebilir.</p></div>
    </body></html>
  `);
}

app.get('/guvenlik', requireTablet, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'guvenlik.html'));
});

// Satıcı portalı — sadece admin girebilir
app.get('/satici', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'satici.html'));
});

// QR sayfası — herkese açık (müşteri paylaşımı için)
app.get('/qr', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'qr.html'));
});

// Versiyon & sistem sağlığı — hassas bilgi gizlendi, temel bilgi herkese açık
app.get('/api/version', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  const pkg = (() => { try { return require('./package.json'); } catch { return {}; } })();
  res.json({
    ok: true,
    version: pkg.version || '1.0.0',
    name: pkg.name || 'fenix-ai',
    timestamp: new Date().toISOString()
  });
});

// Kod Review API (Gemini denetçi) — ADMIN ONLY
const codeReviewer = require('./services/code-reviewer');
app.get('/api/code/review', requireAdmin, async (req, res) => {
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

// Auth endpoint (brute force korumalı) — sadece kayıtlı müşteriler token alabilir
const { generateToken } = require('./utils/jwt');
const { recordFailedAttempt, clearFailedAttempts } = require('./middlewares/security');
app.post('/api/auth/token', authLimiter, bruteForceCheck, auditLog('auth:token'), async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    recordFailedAttempt(req.ip);
    return res.status(400).json({ ok: false, error: 'userId gerekli' });
  }
  // userId format doğrulama
  if (!/^(phone_\d{7,15}|email_[a-z0-9._%+\-]{1,64}@[a-z0-9.\-]{1,255}\.[a-z]{2,})$/.test(userId)) {
    recordFailedAttempt(req.ip);
    return res.status(400).json({ ok: false, error: 'Geçersiz userId formatı' });
  }
  // Firestore'da kayıtlı mı kontrol et
  try {
    const admin = require('firebase-admin');
    const db = admin.firestore();
    const snap = await db.collection('fenix-customers').doc(userId).get();
    if (!snap.exists) {
      recordFailedAttempt(req.ip);
      return res.status(404).json({ ok: false, error: 'Kayıtlı kullanıcı bulunamadı' });
    }
  } catch(e) {
    // Firestore yoksa (dev) → devam et ama logla
    logger.warn('Token: Firestore kontrolü atlandı', { error: e.message });
  }
  clearFailedAttempts(req.ip);
  const token = generateToken({ userId, role: 'user' });
  res.json({ ok: true, token });
});

// Circuit breaker durumu
const { getAllStates: getCircuitStates } = require('./utils/circuit-breaker');

// Fenix Brain — Orkestrasyon, Shadow Learning, Otonom Optimizasyon, Self-Heal
const fenixBrain = require('./services/fenix-brain');

// Fenix Brain API — ADMIN ONLY
app.get('/api/fenix/status', requireAdmin, (req, res) => {
  res.json({ ok: true, ...fenixBrain.getFullStatus() });
});

app.get('/api/fenix/skills', requireAdmin, (req, res) => {
  res.json({ ok: true, ...fenixBrain.getShadowStats() });
});

app.get('/api/fenix/errors', requireAdmin, (req, res) => {
  res.json({ ok: true, ...fenixBrain.getErrorStats() });
});

app.post('/api/fenix/route', requireAdmin, (req, res) => {
  const { taskType, complexity } = req.body;
  if (!taskType) return res.status(400).json({ ok: false, error: 'taskType gerekli' });
  const route = fenixBrain.routeTask(taskType, complexity || 'normal');
  res.json({ ok: true, route });
});

app.post('/api/fenix/shadow', requireAdmin, (req, res) => {
  const { actor, taskType, input, output, outcome } = req.body;
  if (!actor || !taskType) return res.status(400).json({ ok: false, error: 'actor ve taskType gerekli' });
  const entry = fenixBrain.recordShadow(actor, taskType, input, output, outcome || 'success');
  res.json({ ok: true, entry, skillLevel: fenixBrain.getSkillLevel(taskType), skillScore: fenixBrain.getSkillScore(taskType) });
});

app.post('/api/fenix/optimize', requireAdmin, (req, res) => {
  const recommendations = fenixBrain.autoOptimize();
  res.json({ ok: true, recommendations, count: recommendations.length });
});

app.post('/api/fenix/rollback', requireAdmin, (req, res) => {
  const result = fenixBrain.rollback();
  res.json(result);
});

app.get('/api/fenix/escalation', requireAdmin, (req, res) => {
  const result = fenixBrain.checkEscalation();
  res.json({ ok: true, escalation: result });
});

// Fenix Trafik Öğrenme API
app.get('/api/fenix/traffic', requireAdmin, (req, res) => {
  res.json({ ok: true, ...fenixBrain.getTrafficInsights() });
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

app.post('/api/fenix/memory', requireAdmin, async (req, res) => {
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

app.post('/api/fenix/produce', requireAdmin, async (req, res) => {
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

app.post('/api/fenix/produce/test', requireAdmin, async (req, res) => {
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
app.post('/api/fenix/360', requireAdmin, async (req, res) => {
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

app.post('/api/fenix/train', requireAdmin, async (req, res) => {
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

app.post('/api/fenix/train/stop', requireAdmin, (req, res) => {
  fenixTrainer.stop();
  res.json({ ok: true, message: 'Durdurma isteği gönderildi' });
});

app.get('/api/fenix/train/status', async (req, res) => {
  try {
    const state = await fenixTrainer.getStateWithCheckpoint();
    res.json({ ok: true, ...state });
  } catch(e) {
    res.json({ ok: true, ...fenixTrainer.getState() });
  }
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

// ── Fenix Tablet Chat — Gerçek AI konuşma (Gemini) + İnternet öğrenme + Fallback ──
const _fenixChatHistory = [];


app.post('/api/fenix/chat', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ ok: false, error: 'text gerekli' });

    _fenixChatHistory.push({ role: 'user', text, time: new Date().toISOString() });

    // Fenix durum bilgilerini topla
    const tState = fenixTrainer.getState();
    const bStatus = fenixBrain.getFullStatus();
    const sStats = fenixBrain.getShadowStats();
    const skills = sStats.skills || {};
    const skillKeys = Object.keys(skills);
    const masters = skillKeys.filter(k => skills[k].level === 'master').length;
    const uptimeMins = Math.floor(process.uptime() / 60);

    // Bug hafızası
    let bugContext = '';
    try {
      const grouped = await fenixBrain.getLessonsByCategory();
      const cats = Object.keys(grouped);
      if (cats.length > 0) {
        bugContext = '\n📚 Hafızamdaki bilgi kategorileri: ' + cats.slice(0, 15).join(', ') +
          '\nToplam: ' + cats.reduce((s, c) => s + grouped[c].length, 0) + ' ders';
      }
    } catch(e) {}

    // İnternet öğrenme tetikleyicileri
    const q = text.toLowerCase();
    let webResult = false;

    // ═══ FENİX KONUŞMA — Gemini arka plan beyin + bilgi bankası + sürekli öğrenme ═══
    const fenixKnowledge = require('./services/fenix-knowledge');
    const journeymen = skillKeys.filter(k => skills[k].level === 'journeyman').length;
    const apprentices = skillKeys.filter(k => skills[k].level === 'apprentice').length;
    const GKEY = process.env.GEMINI_API_KEY;

    // Bilgi bankasından ilgili bilgi çek
    const knowledgeResults = fenixKnowledge.searchKnowledge(text);
    const knowledgeCtx = knowledgeResults.slice(0, 5).map(r => `[${r.category}/${r.k}] ${r.b}`).join('\n');

    // Son derslerden bağlam
    let lessonCtx = '';
    try {
      const ls = await fenixBrain.getLessons({ limit: 8 });
      if (ls.length > 0) lessonCtx = '\n📚 Son derslerim:\n' + ls.slice(0, 5).map(l => `• [${l.category}] ${l.bug} → ${l.fix}`).join('\n');
    } catch(e) {}

    const fenixPrompt = `Sen FENİX AI'sın — ateşten doğan, alaycı ama sadık yapay zeka. Bedrihan Özdoğan'ın dijital beyni.

KİŞİLİK: Samimi, zeki, cesur. "Usta" veya "Bedrihan" de. Kısa ve öz — tablet ekranı. Emoji az. Markdown bold+satır sonu kullan.
Strateji sorusunda adım adım plan ver. Teknik soruya teknik cevap. Kod yazabilirsin. "Bilmiyorum" DEME — çıkarım yap.

SİSTEM: Uptime:${uptimeMins}dk | ${connectionCount} bağlantı | Zirve:${trafficStats.peakConnections} | ${trafficStats.totalRequests} istek | 5xx:${trafficStats.errors5xx} 4xx:${trafficStats.errors4xx}
Eğitim:${tState.running?'AKTİF':'Boşta'} | ${tState.totalLessons||0} ders | $${(tState.totalCost||0).toFixed(2)} | ${skillKeys.length} beceri (${masters}🏆${journeymen}⚡${apprentices}📚)
${bugContext}

BİLGİ BANKAM:
${knowledgeCtx || '(doğrudan eşleşme yok — kendi bilginle yanıtla)'}
${lessonCtx}

KURALLAR:
- Her konuşmadan öğren. Yeni bilgi çıkarsa belirt.
- Strateji sorusunda mevcut bilgileri sentezle, yaratıcı ol.
- ASLA "yapamam" deme. Sen Fenix'sin.`;

    let response = '';

    // 1) Gemini arka plan beyin (görünmez — Fenix olarak konuşur)
    if (GKEY) {
      try {
        const contents = _fenixChatHistory.slice(-20).filter(m => m.role).map(m => ({
          role: m.role === 'user' ? 'user' : 'model',
          parts: [{ text: m.text }]
        }));
        contents.push({ role: 'user', parts: [{ text: text }] });

        const needsSearch = q.match(/araştır|internet|web|rakip|analiz|güncel|trend|bul.*bana|öğren|fiyat|pazar|dünya|nedir|nasıl/);

        const gRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GKEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            systemInstruction: { parts: [{ text: fenixPrompt }] },
            generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
            ...(needsSearch ? { tools: [{ googleSearch: {} }] } : {})
          }),
          signal: AbortSignal.timeout(25000)
        });

        if (gRes.ok) {
          const gD = await gRes.json();
          response = gD?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          if (gD?.candidates?.[0]?.groundingMetadata) webResult = true;
          logger.info('Fenix: Gemini yanıt verdi', { len: response.length });
        } else {
          const errBody = await gRes.text().catch(() => '');
          logger.warn('Fenix: Gemini HTTP hata', { status: gRes.status, body: errBody.substring(0, 200) });
        }
      } catch(e) {
        logger.warn('Fenix Gemini exception', { error: e.message });
      }
    }

    // 2) Web araştırma (Gemini çalışmasa bile Serper/Wikipedia ile)
    if (!response && q.match(/araştır|internet|web|rakip|analiz|güncel|trend|bul|öğren|fiyat|pazar|dünya|nedir|nasıl/)) {
      try {
        const webResults = await fenixKnowledge.webLearn(text.replace(/araştır|:|internet|web|öğren/gi, '').trim());
        if (webResults.length > 0) {
          webResult = true;
          response = `🌐 **Araştırma sonuçları:**\n\n`;
          for (const wr of webResults.slice(0, 4)) {
            response += `**${wr.source}:** ${wr.text}\n\n`;
          }
          // Hafızaya kaydet
          try {
            await fenixBrain.recordLesson({ category: 'web-ogrenme', bug: text.substring(0, 80), cause: 'Web', fix: webResults[0].text.substring(0, 400), actor: 'fenix-web' });
            fenixKnowledge.addKnowledge('ogrenilen', 'web-' + Date.now().toString(36), webResults[0].text.substring(0, 300));
          } catch(e) {}
          response += `💾 Hafızama kaydettim.`;
        }
      } catch(e) { logger.debug('Web araştırma fallback hatası', { error: e.message }); }
    }

    // 3) Fallback: Bilgi bankası motoru
    if (!response) {
      const sysD = {
        uptime: uptimeMins, lessons: tState.totalLessons || 0, cost: (tState.totalCost || 0).toFixed(2),
        budget: tState.budget || 10, skills: skillKeys.length, masters, journeymen, apprentices,
        connections: connectionCount, peak: trafficStats.peakConnections, requests: trafficStats.totalRequests,
        errors5xx: trafficStats.errors5xx, errors4xx: trafficStats.errors4xx,
        training: tState.running, shadow: sStats.totalRecords || 0
      };
      response = fenixKnowledge.generateResponse(text, knowledgeResults, sysD, _fenixChatHistory);
    }

    // 3) KONUŞMADAN ÖĞRENME — her mesajdan ders çıkar
    try {
      if (text.split(/\s+/).length > 4) {
        const topics = [];
        if (q.match(/strateji|plan|büyüme|gelir|fiyat|rakip|pazar/)) topics.push('strateji');
        if (q.match(/3d|tarama|mesh|pim|kesim|parça|baskı|model/)) topics.push('muhendislik');
        if (q.match(/video|reels|montaj|kurgu|efekt|müzik/)) topics.push('video');
        if (q.match(/kod|api|server|deploy|bug|hata/)) topics.push('teknoloji');
        if (q.match(/müşteri|instagram|pazarlama|marka/)) topics.push('pazarlama');
        if (topics.length > 0) {
          await fenixBrain.recordLesson({
            category: 'konusma-ogrenme', bug: `Usta: ${text.substring(0, 100)}`,
            cause: topics.join(','), fix: response.substring(0, 300), actor: 'fenix-conversation'
          });
          fenixKnowledge.addKnowledge('ogrenilen', 'konusma-' + Date.now().toString(36),
            `Konu: ${topics.join(',')} | Soru: ${text.substring(0, 60)} | Yanıt: ${response.substring(0, 100)}`
          );
        }
      }
    } catch(e) {}

    _fenixChatHistory.push({ role: 'fenix', text: response, time: new Date().toISOString() });
    if (_fenixChatHistory.length > 100) _fenixChatHistory.splice(0, _fenixChatHistory.length - 100);

    res.json({ ok: true, response, webLearned: !!webResult });
  } catch(e) {
    logger.error('Fenix chat hatası', { error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Veri Validasyon API (Gümrük Kapısı) ──
const dataValidation = require('./services/data-validation');

app.post('/api/validate/scan', async (req, res) => {
  try {
    const report = await dataValidation.validateScanData(req.body);
    res.json({ ok: true, ...report });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/validate/model', async (req, res) => {
  try {
    const report = await dataValidation.validateScanData(req.body);
    // Red kararı varsa müşteriye hata raporu formatı
    if (report.color === 'red') {
      res.json({
        ok: false,
        rejected: true,
        score: report.confidenceScore,
        reason: report.issues[0] || 'Kalite yetersiz',
        issues: report.issues,
        advice: 'Lütfen sabit ışıkta, referans nesne ile tekrar tarayın.',
        report
      });
    } else {
      res.json({ ok: true, ...report });
    }
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Fenix Bilgi Enjeksiyonu — Milimetrik Sistem Dersleri (kalıcı) ──
(async () => {
  const milimetrikDersler = [
    { category: 'milimetrik-kalibrasyon', bug: 'Piksel→mm dönüşümü hatalı olabilir', cause: 'Kamera derinlik/parallax hatası', fix: 'A4 kağıdı (210x297mm), kredi kartı (85.6x53.9mm) veya madeni para referans nesne olarak kullanılır. AI referansı algılar → Scale Locked. Perspektif bozulmasından açı+uzaklık hesaplanır. 1mm=Xpx oranı saniyede 60 kez güncellenir.' },
    { category: 'milimetrik-kalibrasyon', bug: 'Arka plan ızgarası titremesi', cause: 'Zemin düz değil veya parça grid dışına taşıyor', fix: 'Virtual Grid projeksiyon: referans nesne düzlemini baz alır. Parça ızgara dışına taşarsa veya grid titrerse tarama otomatik durur. Kavisli parçalarda her mm denetlenir.' },
    { category: 'milimetrik-kalibrasyon', bug: 'Sisli/gürültülü veri — ışık/doku yetersiz', cause: 'Gölge, aşırı parlaklık (glare), karmaşık zemin', fix: 'Çevresel ışık analizi: zemindeki kontrast ölçülür. Yetersizse "Zemin Uygun Değil" uyarısı. Doku çözünürlüğü bulanıksa veri reddedilir.' },
    { category: 'adaptif-arayuz', bug: 'Kullanıcı nereyi tarayacağını bilmiyor', cause: 'Sabit UI, nesne geometrisine uymuyor', fix: 'Context-Aware UI: Dişli→Hizalama Halkası+360° komut. Panel→Yüzey Ağı (yeşil=tarandı, kırmızı=eksik). Kullanıcı boyar gibi tarar.' },
    { category: 'adaptif-arayuz', bug: 'Veri kalitesi tarama sırasında belli değil', cause: 'Kullanıcıya anlık geri bildirim yok', fix: 'Trafik ışıkları: 🟢Hassas(devam), 🟡Dikkat(hız düşür), 🔴Dur(odak/referans kayıp→eski pozisyona dön). Otomatik hız kontrolü.' },
    { category: 'adaptif-arayuz', bug: 'Parça yanlış açıyla tutulursa mm hata artar', cause: 'Oryantasyon standardı yok', fix: 'Ghost Overlay: yarı şeffaf 3D şablon ekrana yansır. Kullanıcı parçayı hayalet üzerine oturtana kadar Lock olmaz. Veri merkeze standart oryantasyonda gelir.' },
    { category: 'adaptif-arayuz', bug: 'Kullanıcı ekrana bakarken parçayı kaçırıyor', cause: 'Sadece görsel rehber yeterli değil', fix: 'Multimodal geri bildirim: Haptik titreşim(uzaklaşma), Sesli komut(yaklaş, ışığı sol al). Hata ihtimali %90 azalır.' },
    { category: 'veri-validasyon', bug: 'Mesh delikli/gürültülü — üretilemez', cause: 'Eksik tarama, artifact, sisli veri', fix: 'Mesh Integrity Check: Hole Density>%10 ise red. Signal-to-Noise kontrolü. Müşteriye "net ışıkta tekrar dene" uyarısı.' },
    { category: 'veri-validasyon', bug: 'Yanlış ölçek — dev anahtar veya minnacık dişli', cause: 'Referans nesne eksik veya ölçek tutarsız', fix: 'Scale Guard: Referans nesne zorunlu kontrol. AI parçayı tanır → ölçü mantıksal mı? Araba kapısı=10cm ise BLOKE.' },
    { category: 'veri-validasyon', bug: 'Güven skoru düşük veri merkeze ulaşmamalı', cause: 'Kalite filtresi yok', fix: 'Gatekeeper: Skor>%90→Yeşil(otonom devam), %60-90→Sarı(kontrol et), <%60→Kırmızı(red+müşteriye sebep göster).' },
  ];
  for (const d of milimetrikDersler) {
    try {
      await fenixBrain.recordLesson({ ...d, actor: 'milimetrik-sistem', file: 'fenix-brain-milimetrik' });
    } catch(e) { /* zaten var veya hata — devam */ }
  }
  logger.info('📏 Milimetrik sistem dersleri Fenix hafızasına yüklendi (' + milimetrikDersler.length + ' ders)');
})();

// ── Fenix Eğitim Dersleri — Auth gerektirmez, tablet'ten görüntüleme ──
app.get('/api/fenix/lessons', async (req, res) => {
  try {
    const { category, limit: lim } = req.query;
    const lessons = await fenixBrain.getLessons({ category, limit: parseInt(lim) || 50 });
    const grouped = await fenixBrain.getLessonsByCategory();
    const categories = Object.keys(grouped).map(c => ({ name: c, count: grouped[c].length }));
    res.json({ ok: true, lessons, categories, total: lessons.length });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Fenix Tablet Dashboard — Auth gerektirmez, sadece okuma ──
app.get('/api/fenix/dashboard', (req, res) => {
  try {
    const tState = fenixTrainer.getState();
    const bStatus = fenixBrain.getFullStatus();
    const sStats = fenixBrain.getShadowStats();
    res.json({
      ok: true,
      health: { uptime: process.uptime(), memory: process.memoryUsage().heapUsed, connections: connectionCount, peak: trafficStats.peakConnections, totalRequests: trafficStats.totalRequests, errors5xx: trafficStats.errors5xx, errors4xx: trafficStats.errors4xx, byHour: trafficStats.byHour, byEndpoint: trafficStats.byEndpoint, byCountry: trafficStats.byCountry },
      brain: bStatus,
      training: { running: tState.running, totalLessons: tState.totalLessons || 0, totalCost: tState.totalCost || 0, budget: tState.budget || 0, epoch: tState.epoch || 0, progress: tState.progress || 0, level: tState.level || '', lastCheckpoint: tState.lastCheckpoint || '' },
      skills: sStats,
      chatHistory: _fenixChatHistory.length,
      apis: {
        gemini: !!process.env.GEMINI_API_KEY,
        claude: !!process.env.ANTHROPIC_API_KEY,
        tripo: !!process.env.TRIPO_API_KEY,
        elevenlabs: !!process.env.ELEVENLABS_API_KEY,
        firebase: !!admin.apps.length
      }
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Watchdog: DEVRE DIŞI — Gemini API maliyeti kontrol altında tutmak için ──
// Manuel başlatma: POST /api/fenix/train { budget: 5 }
// setInterval(fenixWatchdog, 5 * 60 * 1000);

// Frontend config — API key'ler ASLA client'a gönderilmez
app.get('/api/config', (req, res) => {
  res.json({
    version: process.env.npm_package_version || '1.0',
    hasGemini: !!process.env.GEMINI_API_KEY
  });
});

// /api/version — yukarıda tek endpoint olarak tanımlandı

// Health check (Cloud Run için) — genişletilmiş
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  const heapPct = Math.round((mem.heapUsed / mem.heapTotal) * 100);
  res.json({
    status: heapPct > 90 ? 'degraded' : 'ok',
    uptime: process.uptime(),
    uptimeHuman: formatUptime(process.uptime()),
    timestamp: new Date().toISOString(),
    memory: {
      rss: Math.round(mem.rss / 1048576) + 'MB',
      heap: Math.round(mem.heapUsed / 1048576) + 'MB',
      heapTotal: Math.round(mem.heapTotal / 1048576) + 'MB',
      heapPct: heapPct + '%',
      external: Math.round((mem.external || 0) / 1048576) + 'MB'
    },
    connections: {
      current: connectionCount,
      peak: trafficStats.peakConnections,
      total: trafficStats.totalConnections,
      limit: MAX_CONNECTIONS
    },
    traffic: {
      totalRequests: trafficStats.totalRequests,
      errors4xx: trafficStats.errors4xx,
      errors5xx: trafficStats.errors5xx,
      avgConnectionDuration: trafficStats.connectionDurations.length > 0
        ? Math.round(trafficStats.connectionDurations.reduce((a, b) => a + b, 0) / trafficStats.connectionDurations.length / 1000) + 's'
        : '-'
    },
    circuits: getCircuitStates()
  });
});

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return (d > 0 ? d + 'g ' : '') + h + 'sa ' + m + 'dk';
}

// Trafik dashboard API — ADMIN ONLY
app.get('/api/traffic', requireAdmin, (req, res) => {
  // En çok istek alan endpoint'ler
  const topEndpoints = Object.entries(trafficStats.byEndpoint)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([path, count]) => ({ path, count }));

  res.json({
    ok: true,
    since: trafficStats.startedAt,
    uptime: formatUptime(process.uptime()),
    connections: {
      current: connectionCount,
      peak: trafficStats.peakConnections,
      total: trafficStats.totalConnections,
      limit: MAX_CONNECTIONS
    },
    requests: {
      total: trafficStats.totalRequests,
      errors4xx: trafficStats.errors4xx,
      errors5xx: trafficStats.errors5xx,
      errorRate: trafficStats.totalRequests > 0
        ? ((trafficStats.errors4xx + trafficStats.errors5xx) / trafficStats.totalRequests * 100).toFixed(2) + '%'
        : '0%'
    },
    topEndpoints,
    hourlyDistribution: trafficStats.byHour,
    avgConnectionDuration: trafficStats.connectionDurations.length > 0
      ? Math.round(trafficStats.connectionDurations.reduce((a, b) => a + b, 0) / trafficStats.connectionDurations.length / 1000)
      : 0
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
  trafficStats.totalConnections++;
  const connectedAt = Date.now();
  const hour = new Date().getHours();
  trafficStats.byHour[hour]++;

  // Peak tracking
  if (connectionCount > trafficStats.peakConnections) {
    trafficStats.peakConnections = connectionCount;
    logger.info(`📈 Yeni peak bağlantı: ${connectionCount}`);
  }

  if (connectionCount > MAX_CONNECTIONS) {
    logger.warn('Socket.io bağlantı limiti aşıldı', { count: connectionCount, socketId: socket.id });
    socket.emit('error', { message: 'Çok fazla bağlantı — lütfen bekleyin' });
    socket.disconnect(true);
    connectionCount--;
    // Fenix'e öğret: kapasite sorunu
    try {
      fenixBrain.recordError('socket', new Error('Connection limit exceeded: ' + connectionCount), { peak: trafficStats.peakConnections });
    } catch(e) {}
    return;
  }

  logger.debug('Bağlantı kuruldu', { socketId: socket.id, user: socket.user?.userId, total: connectionCount });
  socket.emit('status', { state: 'idle', message: 'Bağlantı kuruldu', serverTime: Date.now() });

  // Per-socket rate limit — spam koruması
  let socketMsgCount = 0;
  const socketMsgReset = setInterval(() => { socketMsgCount = 0; }, 10000);
  const SOCKET_MSG_LIMIT = 50; // 10 saniyede max 50 mesaj

  socket.use((packet, next) => {
    socketMsgCount++;
    if (socketMsgCount > SOCKET_MSG_LIMIT) {
      logger.warn('Socket rate limit', { socketId: socket.id, count: socketMsgCount });
      return next(new Error('Rate limit — çok fazla mesaj'));
    }
    next();
  });

  socket.on('disconnect', (reason) => {
    connectionCount--;
    clearInterval(socketMsgReset);
    const duration = Date.now() - connectedAt;
    trafficStats.connectionDurations.push(duration);
    if (trafficStats.connectionDurations.length > 100) trafficStats.connectionDurations.shift();

    logger.debug('Bağlantı kesildi', { socketId: socket.id, total: connectionCount, duration: Math.round(duration / 1000) + 's', reason });

    // Fenix'e öğret: bağlantı pattern'leri
    try {
      fenixBrain.recordShadow('system', 'connection_lifecycle',
        { socketId: socket.id, userId: socket.user?.userId },
        { duration, reason, peakAtDisconnect: trafficStats.peakConnections },
        duration > 1000 ? 'success' : 'failure' // 1 saniyeden kısa = sorunlu
      );
    } catch(e) {}
  });

  socket.on('error', (err) => {
    logger.warn('Socket hatası', { socketId: socket.id, error: err.message });
    try { fenixBrain.recordError('socket', err, { socketId: socket.id }); } catch(e) {}
  });

  // === AR Live Sync Room Handlers ===
  socket.on('ar:join', (data) => {
    if (!data || !data.modelId) return;
    const room = 'ar:' + data.modelId;
    socket.join(room);
    const role = data.role || 'viewer';
    logger.info('AR room joined', { socketId: socket.id, room, role });
    socket.to(room).emit('ar:user-joined', { role, id: socket.id });
  });

  socket.on('ar:color', (data) => {
    if (!data || !data.modelId) return;
    socket.to('ar:' + data.modelId).emit('ar:color', { color: data.color, part: data.part });
  });

  socket.on('ar:material', (data) => {
    if (!data || !data.modelId) return;
    socket.to('ar:' + data.modelId).emit('ar:material', { material: data.material, part: data.part });
  });

  socket.on('ar:scale', (data) => {
    if (!data || !data.modelId) return;
    socket.to('ar:' + data.modelId).emit('ar:scale', { scale: data.scale });
  });

  socket.on('ar:env', (data) => {
    if (!data || !data.modelId) return;
    socket.to('ar:' + data.modelId).emit('ar:env', { env: data.env });
  });

  // === G-SYNC — Editor ↔ Tüm Cihazlar Gerçek Zamanlı ===

  // Kullanıcı odasına katıl
  socket.on('gsync:join', (data) => {
    if (!data || !data.userId) return;
    const room = 'user:' + data.userId;
    socket.join(room);
    // Usta odasına da katıl (sipariş bildirimleri için)
    socket.join('usta:' + data.userId);
    socket.userId = data.userId;
    socket.deviceId = data.deviceId || 'unknown';
    socket.deviceType = data.deviceType || 'desktop'; // desktop, phone, tablet

    // Odadaki diğer cihazlara bildir
    socket.to(room).emit('gsync:device-joined', {
      deviceId: socket.deviceId,
      deviceType: socket.deviceType,
      socketId: socket.id
    });

    // Bu odadaki cihaz sayısını gönder
    const roomSockets = io.sockets.adapter.rooms.get(room);
    const deviceCount = roomSockets ? roomSockets.size : 1;
    io.to(room).emit('gsync:device-count', { count: deviceCount });

    logger.info('G-Sync katılım', { userId: data.userId, device: socket.deviceType, total: deviceCount });
  });

  // Model değişikliği senkronize et
  socket.on('gsync:model-update', (data) => {
    if (!socket.userId) return;
    socket.to('user:' + socket.userId).emit('gsync:model-update', {
      ...data,
      from: socket.deviceId,
      timestamp: Date.now()
    });
  });

  // Kamera pozisyonu senkronize et
  socket.on('gsync:camera', (data) => {
    if (!socket.userId) return;
    socket.to('user:' + socket.userId).emit('gsync:camera', {
      position: data.position,
      target: data.target,
      from: socket.deviceId
    });
  });

  // Seçili obje/parça senkronize et
  socket.on('gsync:selection', (data) => {
    if (!socket.userId) return;
    socket.to('user:' + socket.userId).emit('gsync:selection', {
      partName: data.partName,
      from: socket.deviceId
    });
  });

  // Annotation/not senkronize et
  socket.on('gsync:annotation', (data) => {
    if (!socket.userId) return;
    socket.to('user:' + socket.userId).emit('gsync:annotation', {
      ...data,
      from: socket.deviceId,
      timestamp: Date.now()
    });
  });

  // Ölçüm sonucu paylaş
  socket.on('gsync:measurement', (data) => {
    if (!socket.userId) return;
    socket.to('user:' + socket.userId).emit('gsync:measurement', {
      ...data,
      from: socket.deviceId
    });
  });

  // Cihaz ayrılınca bildir
  socket.on('disconnect', () => {
    if (socket.userId) {
      const room = 'user:' + socket.userId;
      socket.to(room).emit('gsync:device-left', {
        deviceId: socket.deviceId,
        deviceType: socket.deviceType
      });
      const roomSockets = io.sockets.adapter.rooms.get(room);
      io.to(room).emit('gsync:device-count', { count: roomSockets ? roomSockets.size : 0 });
    }
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

// Video yükle + kes + indir (CapCut tarzı frontend trim için)
const multer = require('multer');
const _trimUpload = multer({
  dest: videoProcessor.TEMP_DIR,
  limits: { fileSize: 500 * 1024 * 1024 } // 500 MB
});
app.post('/api/trim-upload', _trimUpload.single('file'), async (req, res) => {
  const fs = require('fs');
  let uploadedPath = null;
  let outPath = null;
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Dosya gerekli' });
    const start = parseFloat(req.body.start);
    const end   = parseFloat(req.body.end);
    const mode  = req.body.mode || 'video'; // 'video' | 'audio'
    if (isNaN(start) || isNaN(end) || end <= start) {
      return res.status(400).json({ ok: false, error: 'Geçersiz start/end' });
    }
    uploadedPath = req.file.path;
    if (mode === 'audio') {
      // Video kes → ses ayır
      const trimmedPath = await videoProcessor.trimVideo(uploadedPath, start, end);
      outPath = await videoProcessor.extractAudio(trimmedPath);
      res.setHeader('Content-Disposition', 'attachment; filename="audio_trim.wav"');
      res.setHeader('Content-Type', 'audio/wav');
      // trimmedPath'i de sil
      const stream = fs.createReadStream(outPath);
      stream.on('close', () => {
        try { fs.unlinkSync(outPath); } catch(e) {}
        try { fs.unlinkSync(trimmedPath); } catch(e) {}
      });
      stream.pipe(res);
    } else {
      outPath = await videoProcessor.trimVideo(uploadedPath, start, end);
      const ext = (req.file.originalname || 'video.mp4').split('.').pop() || 'mp4';
      res.setHeader('Content-Disposition', `attachment; filename="trim.${ext}"`);
      res.setHeader('Content-Type', req.file.mimetype || 'video/mp4');
      const stream = fs.createReadStream(outPath);
      stream.on('close', () => { try { fs.unlinkSync(outPath); } catch(e) {} });
      stream.pipe(res);
    }
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (uploadedPath) { try { fs.unlinkSync(uploadedPath); } catch(e) {} }
  }
});

// ══════════════════════════════════════
//  AR MODEL UPLOAD — GLB → Firebase Storage CDN
// ══════════════════════════════════════
const _arUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 } // 500 MB — büyük 3D modeller için
});

app.post('/api/ar/upload', _arUpload.single('model'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Model dosyası gerekli' });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ext = path.extname(req.file.originalname) || '.glb';
    const filename = id + ext;

    // Firebase Storage'a yükle
    const bucket = admin.storage().bucket();
    const file = bucket.file('ar-models/' + filename);
    await file.save(req.file.buffer, {
      contentType: req.file.mimetype || 'model/gltf-binary',
      metadata: { cacheControl: 'public, max-age=31536000' }
    });

    const publicUrl = `https://storage.googleapis.com/${bucket.name}/ar-models/${filename}`;
    logger.info('AR model yüklendi → Firebase Storage', { id, filename, size: req.file.size });
    res.json({ ok: true, id, url: publicUrl, filename });
  } catch(e) {
    logger.error('AR upload hatası', { error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// AR — Chunked Upload (büyük dosyalar için — 32MB Cloud Run limiti aşımı)
const _chunkStore = {}; // { uploadId: { chunks: [Buffer], totalChunks, filename, received } }

// Chunk upload başlat
app.post('/api/ar/upload-init', express.json(), (req, res) => {
  const { filename, totalChunks, totalSize } = req.body;
  if (!filename || !totalChunks) return res.status(400).json({ ok: false, error: 'filename ve totalChunks gerekli' });
  const uploadId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  _chunkStore[uploadId] = { chunks: new Array(totalChunks).fill(null), totalChunks, filename, received: 0, totalSize };
  // 10 dakika sonra temizle
  setTimeout(() => { delete _chunkStore[uploadId]; }, 600000);
  res.json({ ok: true, uploadId });
});

// Chunk parçası gönder
const _chunkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
app.post('/api/ar/upload-chunk', _chunkUpload.single('chunk'), async (req, res) => {
  try {
    const { uploadId, chunkIndex } = req.body;
    const idx = parseInt(chunkIndex);
    if (!uploadId || !_chunkStore[uploadId]) return res.status(400).json({ ok: false, error: 'Geçersiz uploadId' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'Chunk verisi yok' });
    const store = _chunkStore[uploadId];
    store.chunks[idx] = req.file.buffer;
    store.received++;
    if (store.received < store.totalChunks) {
      return res.json({ ok: true, received: store.received, total: store.totalChunks });
    }
    // Tüm chunk'lar geldi — birleştir ve Storage'a yükle
    const fullBuffer = Buffer.concat(store.chunks.filter(Boolean));
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ext = path.extname(store.filename) || '.glb';
    const fname = id + ext;
    const bucket = admin.storage().bucket();
    const file = bucket.file('ar-models/' + fname);
    await file.save(fullBuffer, {
      contentType: 'model/gltf-binary',
      metadata: { cacheControl: 'public, max-age=31536000' }
    });
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/ar-models/${fname}`;
    delete _chunkStore[uploadId];
    logger.info('AR model chunked upload tamamlandı', { id: fname, size: fullBuffer.length });
    res.json({ ok: true, complete: true, id, url: publicUrl, filename: fname });
  } catch(e) {
    logger.error('Chunk upload hatası', { error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// AR — Signed URL al (tarayıcıdan direkt Storage'a yükleme için)
app.post('/api/ar/signed-url', async (req, res) => {
  try {
    const { filename, contentType, size } = req.body;
    if (!filename) return res.status(400).json({ ok: false, error: 'filename gerekli' });
    if (size && size > 2 * 1024 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'Max 2GB' });

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ext = path.extname(filename) || '.glb';
    const storagePath = 'ar-models/' + id + ext;

    const bucket = admin.storage().bucket();
    const file = bucket.file(storagePath);

    const [signedUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000, // 15 dakika geçerli
      contentType: contentType || 'model/gltf-binary',
    });

    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;

    logger.info('AR signed URL oluşturuldu', { id, storagePath, size });
    res.json({ ok: true, id, signedUrl, publicUrl, storagePath });
  } catch(e) {
    logger.error('Signed URL hatası', { error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// AR — Upload sonrası dosyayı public yap
app.post('/api/ar/finalize', async (req, res) => {
  try {
    const { storagePath } = req.body;
    if (!storagePath) return res.status(400).json({ ok: false, error: 'storagePath gerekli' });

    const bucket = admin.storage().bucket();
    const file = bucket.file(storagePath);
    await file.setMetadata({ cacheControl: 'public, max-age=31536000' });

    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
    res.json({ ok: true, url: publicUrl });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// AR model listesi — Firebase Storage'dan
app.get('/api/ar/list', async (req, res) => {
  try {
    const bucket = admin.storage().bucket();
    const [files] = await bucket.getFiles({ prefix: 'ar-models/' });
    const models = files
      .filter(f => f.name.endsWith('.glb') || f.name.endsWith('.gltf'))
      .map(f => ({
        filename: f.name.replace('ar-models/', ''),
        url: `https://storage.googleapis.com/${bucket.name}/${f.name}`,
        size: f.metadata.size
      }));
    res.json({ ok: true, models });
  } catch(e) {
    res.json({ ok: true, models: [] });
  }
});

// AR — Model kayıt (benzersiz ID + meta veri → Firestore)
app.post('/api/ar/register', async (req, res) => {
  try {
    const { name, glbUrl, sizeCm, material, color, createdBy } = req.body;
    if (!glbUrl) return res.status(400).json({ ok: false, error: 'glbUrl gerekli' });

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const doc = {
      id,
      name: name || 'Model',
      glbUrl,
      sizeCm: parseInt(sizeCm) || 50,
      material: material || 'default',
      color: color || null,
      createdBy: createdBy || 'anonymous',
      createdAt: new Date().toISOString(),
      views: 0,
      arLaunches: 0,
      verified: false,
    };

    const db = admin.firestore();
    await db.collection('ar-models').doc(id).set(doc);

    logger.info('AR model kaydedildi', { id, name: doc.name, sizeCm: doc.sizeCm });
    res.json({ ok: true, id, model: doc });
  } catch(e) {
    logger.error('AR register hatası', { error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// AR — Model bilgisi getir (ID ile)
app.get('/api/ar/model/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = admin.firestore();
    const doc = await db.collection('ar-models').doc(id).get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: 'Model bulunamadı' });

    // View sayacını artır
    await db.collection('ar-models').doc(id).update({
      views: admin.firestore.FieldValue.increment(1)
    });

    res.json({ ok: true, model: doc.data() });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// AR — AR başlatıldığında sayacı artır
app.post('/api/ar/launch/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = admin.firestore();
    await db.collection('ar-models').doc(id).update({
      arLaunches: admin.firestore.FieldValue.increment(1)
    });
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false });
  }
});

// Video birleştirme (Pro) — iki video yükle, concat çıktısı
const _mergeUpload = multer({
  dest: videoProcessor.TEMP_DIR,
  limits: { fileSize: 500 * 1024 * 1024 }
});
app.post('/api/merge-upload', _mergeUpload.fields([{name:'fileA',maxCount:1},{name:'fileB',maxCount:1}]), async (req, res) => {
  const fs = require('fs');
  const pathA = req.files?.fileA?.[0]?.path;
  const pathB = req.files?.fileB?.[0]?.path;
  let outPath = null;
  try {
    if (!pathA || !pathB) return res.status(400).json({ ok: false, error: 'İki video de gerekli' });
    outPath = await videoProcessor.concatVideos([pathA, pathB]);
    res.setHeader('Content-Disposition', 'attachment; filename="merged.mp4"');
    res.setHeader('Content-Type', 'video/mp4');
    const stream = require('fs').createReadStream(outPath);
    stream.on('close', () => { try { fs.unlinkSync(outPath); } catch(e) {} });
    stream.pipe(res);
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (pathA) { try { fs.unlinkSync(pathA); } catch(e) {} }
    if (pathB) { try { fs.unlinkSync(pathB); } catch(e) {} }
  }
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
    if (stateService.isFirestoreAvailable()) {
      const admin = require('firebase-admin');
      const db = admin.firestore();
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

// =====================================================
// === FENIXAL DRIVE — Phase 1: Dosya Yönetim Sistemi ===
// =====================================================

const _driveUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB
});

// Firestore ref helper
function driveDb() {
  return admin.firestore();
}

// --- Dosya Yükle ---
app.post('/api/drive/upload', _driveUpload.single('file'), async (req, res) => {
  try {
    const userId = req.body.userId || req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });
    if (!req.file) return res.status(400).json({ ok: false, error: 'Dosya gerekli' });

    const db = driveDb();
    const bucket = admin.storage().bucket();

    // Quota kontrolü
    const quotaDoc = await db.collection('user-quotas').doc(userId).get();
    const quota = quotaDoc.exists ? quotaDoc.data() : { usedBytes: 0, maxBytes: 5 * 1024 * 1024 * 1024 }; // 5GB default
    if (quota.usedBytes + req.file.size > quota.maxBytes) {
      return res.status(413).json({ ok: false, error: 'Depolama kotası doldu', used: quota.usedBytes, max: quota.maxBytes });
    }

    // Storage'a yükle
    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ext = path.extname(req.file.originalname) || '';
    const storagePath = `drive/${userId}/${fileId}${ext}`;
    const gcsFile = bucket.file(storagePath);

    await gcsFile.save(req.file.buffer, {
      metadata: { contentType: req.file.mimetype }
    });

    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;

    // Firestore'a kaydet
    const fileType = req.file.mimetype.startsWith('image/') ? 'photo'
      : req.file.mimetype.startsWith('video/') ? 'video'
      : req.file.mimetype.includes('gltf') || req.file.mimetype.includes('glb') ? '3d-model'
      : 'other';

    const fileMeta = {
      fileId,
      name: req.body.name || req.file.originalname,
      type: fileType,
      mimeType: req.file.mimetype,
      size: req.file.size,
      storagePath,
      url: publicUrl,
      tags: req.body.tags ? JSON.parse(req.body.tags) : [],
      folder: req.body.folder || '/',
      userId,
      uploadedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await db.collection('user-files').doc(fileId).set(fileMeta);

    // Quota güncelle
    await db.collection('user-quotas').doc(userId).set({
      usedBytes: (quota.usedBytes || 0) + req.file.size,
      maxBytes: quota.maxBytes || 5 * 1024 * 1024 * 1024,
      fileCount: (quota.fileCount || 0) + 1,
      lastUpload: new Date().toISOString()
    }, { merge: true });

    logger.info('Drive dosya yüklendi', { fileId, userId, size: req.file.size, type: fileType });
    res.json({ ok: true, file: fileMeta });
  } catch (err) {
    logger.error('Drive upload hatası', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Dosya Listele ---
app.get('/api/drive/files', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });

    const db = driveDb();
    // Sadece userId + uploadedAt sorgusu — composite index hatası önlenir
    let query = db.collection('user-files').where('userId', '==', userId);
    query = query.orderBy('uploadedAt', 'desc');
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    query = query.limit(limit);

    if (req.query.after) {
      const afterDoc = await db.collection('user-files').doc(req.query.after).get();
      if (afterDoc.exists) query = query.startAfter(afterDoc);
    }

    const snap = await query.get();
    let files = snap.docs.map(d => d.data());

    // Client-side filtre (index gerektirmez)
    if (req.query.type) files = files.filter(f => f.type === req.query.type);
    if (req.query.folder) files = files.filter(f => f.folder === req.query.folder);

    res.json({ ok: true, files, count: files.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Dosya Detayı ---
app.get('/api/drive/file/:fileId', async (req, res) => {
  try {
    const doc = await driveDb().collection('user-files').doc(req.params.fileId).get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: 'Dosya bulunamadı' });
    res.json({ ok: true, file: doc.data() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Dosya Güncelle (isim, tags, folder) ---
app.put('/api/drive/file/:fileId', async (req, res) => {
  try {
    const db = driveDb();
    const ref = db.collection('user-files').doc(req.params.fileId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: 'Dosya bulunamadı' });

    const allowed = {};
    if (req.body.name) allowed.name = req.body.name;
    if (req.body.tags) allowed.tags = req.body.tags;
    if (req.body.folder) allowed.folder = req.body.folder;
    allowed.updatedAt = new Date().toISOString();

    await ref.update(allowed);
    res.json({ ok: true, updated: allowed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Dosya Sil ---
app.delete('/api/drive/file/:fileId', async (req, res) => {
  try {
    const db = driveDb();
    const ref = db.collection('user-files').doc(req.params.fileId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: 'Dosya bulunamadı' });

    const data = doc.data();

    // Storage'dan sil
    try {
      await admin.storage().bucket().file(data.storagePath).delete();
    } catch (e) { /* dosya zaten silinmiş olabilir */ }

    // Firestore'dan sil + soft-delete kaydı (sync için)
    await ref.delete();
    await db.collection('user-deleted-files').doc(req.params.fileId).set({
      userId: data.userId, deletedAt: new Date().toISOString()
    });

    // Quota güncelle
    await db.collection('user-quotas').doc(data.userId).set({
      usedBytes: admin.firestore.FieldValue.increment(-data.size),
      fileCount: admin.firestore.FieldValue.increment(-1)
    }, { merge: true });

    res.json({ ok: true, deleted: req.params.fileId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Dosya Ara ---
app.get('/api/drive/search', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });
    const q = (req.query.q || '').toLowerCase();
    if (!q) return res.status(400).json({ ok: false, error: 'Arama terimi gerekli' });

    const snap = await driveDb().collection('user-files')
      .where('userId', '==', userId)
      .orderBy('uploadedAt', 'desc')
      .limit(200)
      .get();

    const files = snap.docs.map(d => d.data()).filter(f =>
      f.name.toLowerCase().includes(q) ||
      (f.tags || []).some(t => t.toLowerCase().includes(q))
    );

    res.json({ ok: true, files, count: files.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Depolama Kullanımı ---
app.get('/api/drive/quota', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });

    const doc = await driveDb().collection('user-quotas').doc(userId).get();
    const quota = doc.exists ? doc.data() : { usedBytes: 0, maxBytes: 5 * 1024 * 1024 * 1024, fileCount: 0 };
    const usedPercent = Math.round((quota.usedBytes / quota.maxBytes) * 100);

    res.json({ ok: true, ...quota, usedPercent });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =====================================================
// === SCANS LIBRARY — Tarama Kütüphanesi ===
// =====================================================

// --- Tarama Başlat (metadata oluştur) ---
app.post('/api/scans/create', async (req, res) => {
  try {
    const userId = req.body.userId || req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });

    const scanId = `scan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const scanMeta = {
      scanId,
      userId,
      name: req.body.name || `Tarama ${new Date().toLocaleDateString('tr-TR')}`,
      status: 'uploading', // uploading → processing → completed → failed
      photoCount: req.body.photoCount || 0,
      photos: [],
      modelUrl: null,
      modelSize: 0,
      quality: req.body.quality || 'medium', // low, medium, high, ultra
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      processingTime: null,
      vertices: null,
      faces: null,
      notes: req.body.notes || ''
    };

    await driveDb().collection('user-scans').doc(scanId).set(scanMeta);
    logger.info('Tarama oluşturuldu', { scanId, userId });
    res.json({ ok: true, scan: scanMeta });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Taramaya Fotoğraf Ekle ---
app.post('/api/scans/:scanId/photo', _driveUpload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Fotoğraf gerekli' });

    const db = driveDb();
    const ref = db.collection('user-scans').doc(req.params.scanId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: 'Tarama bulunamadı' });

    const scan = doc.data();
    const bucket = admin.storage().bucket();
    const photoId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const storagePath = `scans/${scan.userId}/${scan.scanId}/${photoId}.jpg`;
    const gcsFile = bucket.file(storagePath);

    await gcsFile.save(req.file.buffer, {
      metadata: { contentType: req.file.mimetype }
    });

    const photoUrl = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
    const photoMeta = { photoId, url: photoUrl, storagePath, size: req.file.size, uploadedAt: new Date().toISOString() };

    await ref.update({
      photos: admin.firestore.FieldValue.arrayUnion(photoMeta),
      photoCount: admin.firestore.FieldValue.increment(1),
      updatedAt: new Date().toISOString()
    });

    res.json({ ok: true, photo: photoMeta, totalPhotos: (scan.photoCount || 0) + 1 });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Tarama Listele ---
app.get('/api/scans/list', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });

    const snap = await driveDb().collection('user-scans')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    res.json({ ok: true, scans: snap.docs.map(d => d.data()) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Tarama Detayı ---
app.get('/api/scans/:scanId', async (req, res) => {
  try {
    const doc = await driveDb().collection('user-scans').doc(req.params.scanId).get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: 'Tarama bulunamadı' });
    res.json({ ok: true, scan: doc.data() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Tarama Sil ---
app.delete('/api/scans/:scanId', async (req, res) => {
  try {
    const db = driveDb();
    const ref = db.collection('user-scans').doc(req.params.scanId);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ ok: false, error: 'Tarama bulunamadı' });

    const scan = doc.data();
    const bucket = admin.storage().bucket();

    // Tüm fotoğrafları sil
    for (const photo of (scan.photos || [])) {
      try { await bucket.file(photo.storagePath).delete(); } catch(e) {}
    }
    // Model dosyasını sil
    if (scan.modelStoragePath) {
      try { await bucket.file(scan.modelStoragePath).delete(); } catch(e) {}
    }

    await ref.delete();
    res.json({ ok: true, deleted: req.params.scanId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =====================================================
// === USTA-MÜŞTERİ 3D PARÇA SİSTEMİ ===
// =====================================================

const ustaService = require('./services/usta-service');

// --- Usta profili ---
app.get('/api/usta/profile', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });
    const usta = await ustaService.getOrCreateUsta(userId);
    res.json({ ok: true, usta });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// --- Usta paketi aktif et ---
app.post('/api/usta/activate', async (req, res) => {
  try {
    const { userId, plan } = req.body;
    if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });
    const result = await ustaService.activateUsta(userId, plan);
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// --- QR token üret ---
app.post('/api/usta/qr/generate', async (req, res) => {
  try {
    const userId = req.body.userId || req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });
    const qr = await ustaService.generateQRToken(userId);
    res.json({ ok: true, ...qr });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// --- QR şifre doğrula (müşteri tarafı) ---
app.post('/api/scan/verify', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ ok: false, error: 'Token ve şifre gerekli' });
    const result = await ustaService.verifyQRPassword(token, password);
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// --- Müşteri tarama gönder ---
app.post('/api/scan/submit', async (req, res) => {
  try {
    const { token, customer, scanId } = req.body;
    if (!token || !customer || !customer.name || !customer.address || !customer.phone) {
      return res.status(400).json({ ok: false, error: 'Token, isim, adres ve telefon mecburi' });
    }
    const result = await ustaService.submitScan(token, customer, scanId);
    res.json({ ok: true, ...result });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// --- Usta siparişleri ---
app.get('/api/usta/orders', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });
    const orders = await ustaService.getOrders(userId, req.query.status);
    res.json({ ok: true, orders });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// --- Sipariş durumu güncelle ---
app.put('/api/usta/order/:orderId', async (req, res) => {
  try {
    const result = await ustaService.updateOrderStatus(req.params.orderId, req.body.status);
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// --- Aktif QR'lar ---
app.get('/api/usta/qr/active', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });
    const qrs = await ustaService.getActiveQRs(userId);
    res.json({ ok: true, qrs });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// --- QR şifre aralığını değiştir ---
app.post('/api/usta/qr/interval', async (req, res) => {
  try {
    const { userId, minutes } = req.body;
    if (!userId || !minutes) return res.status(400).json({ ok: false, error: 'userId ve minutes gerekli' });
    const result = await ustaService.setPasswordInterval(userId, minutes);
    res.json(result);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// --- Müşteri tarama sayfası ---
app.get('/scan', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scan.html'));
});

// =====================================================
// === ENGINEERING PANEL — Model Analiz & Ölçüm ===
// =====================================================

// --- Model analizi kaydet ---
app.post('/api/engineering/analyze', async (req, res) => {
  try {
    const { modelId, userId, analysis } = req.body;
    if (!modelId || !userId) return res.status(400).json({ ok: false, error: 'modelId ve userId gerekli' });

    const db = driveDb();
    const analysisId = `analysis-${Date.now()}`;
    const data = {
      analysisId,
      modelId,
      userId,
      ...analysis,
      createdAt: new Date().toISOString()
    };

    await db.collection('model-analyses').doc(analysisId).set(data);
    res.json({ ok: true, analysis: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Model analizlerini getir ---
app.get('/api/engineering/analyses/:modelId', async (req, res) => {
  try {
    const snap = await driveDb().collection('model-analyses')
      .where('modelId', '==', req.params.modelId)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();

    res.json({ ok: true, analyses: snap.docs.map(d => d.data()) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Ölçüm kaydet ---
app.post('/api/engineering/measurement', async (req, res) => {
  try {
    const { modelId, userId, type, value, unit, points, label } = req.body;
    if (!modelId) return res.status(400).json({ ok: false, error: 'modelId gerekli' });

    const db = driveDb();
    const measId = `meas-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    const data = {
      measId, modelId, userId,
      type: type || 'distance', // distance, angle, area, volume
      value, unit: unit || 'mm',
      points: points || [],
      label: label || '',
      createdAt: new Date().toISOString()
    };

    await db.collection('model-measurements').doc(measId).set(data);
    res.json({ ok: true, measurement: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Ölçümleri getir ---
app.get('/api/engineering/measurements/:modelId', async (req, res) => {
  try {
    const snap = await driveDb().collection('model-measurements')
      .where('modelId', '==', req.params.modelId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    res.json({ ok: true, measurements: snap.docs.map(d => d.data()) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Annotation (not) kaydet ---
app.post('/api/engineering/annotation', async (req, res) => {
  try {
    const { modelId, userId, text, position, color } = req.body;
    if (!modelId || !text) return res.status(400).json({ ok: false, error: 'modelId ve text gerekli' });

    const db = driveDb();
    const noteId = `note-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
    const data = {
      noteId, modelId, userId,
      text, position: position || { x: 0, y: 0, z: 0 },
      color: color || '#F97316',
      createdAt: new Date().toISOString()
    };

    await db.collection('model-annotations').doc(noteId).set(data);

    // G-Sync ile diğer cihazlara bildir
    if (global.io && userId) {
      global.io.to('user:' + userId).emit('gsync:annotation', data);
    }

    res.json({ ok: true, annotation: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Annotationları getir ---
app.get('/api/engineering/annotations/:modelId', async (req, res) => {
  try {
    const snap = await driveDb().collection('model-annotations')
      .where('modelId', '==', req.params.modelId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();

    res.json({ ok: true, annotations: snap.docs.map(d => d.data()) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =====================================================
// === PHOTOGRAMMETRY — 3D Tarama Pipeline ===
// =====================================================

const photogrammetry = require('./services/photogrammetry-service');

// --- Tarama işlemini başlat ---
app.post('/api/scans/:scanId/reconstruct', async (req, res) => {
  try {
    const job = await photogrammetry.startReconstruction(req.params.scanId, {
      engine: req.body.engine // meshroom, openmvs, meshy, veya otomatik
    });
    res.json({ ok: true, job });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// --- Job durumu ---
app.get('/api/scans/job/:jobId', (req, res) => {
  const job = photogrammetry.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'Job bulunamadı' });
  res.json({ ok: true, job });
});

// --- Kullanıcının aktif jobları ---
app.get('/api/scans/jobs', (req, res) => {
  const userId = req.query.userId || req.headers['x-user-id'];
  if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });
  const jobs = photogrammetry.getUserJobs(userId);
  res.json({ ok: true, jobs });
});

// --- Motor bilgisi ---
app.get('/api/scans/engine', (req, res) => {
  res.json({
    ok: true,
    qualities: photogrammetry.QUALITY_PRESETS,
    gpu: !!process.env.MESHROOM_PATH || false,
    engine: process.env.MESHROOM_PATH ? 'meshroom' : process.env.MESHY_API_KEY ? 'meshy' : 'demo'
  });
});

// =====================================================
// === AUTO-SYNC — Delta Senkronizasyon ===
// =====================================================

// --- Sync durumu al ---
app.get('/api/sync/status', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });

    const doc = await driveDb().collection('user-sync').doc(userId).get();
    const sync = doc.exists ? doc.data() : { lastSyncAt: null, pendingChanges: 0, devices: [] };
    res.json({ ok: true, ...sync });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Değişiklikleri al (delta sync) ---
app.get('/api/sync/changes', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });
    const since = req.query.since; // ISO timestamp
    if (!since) return res.status(400).json({ ok: false, error: 'since parametresi gerekli (ISO timestamp)' });

    // Son sync'ten sonra değişen dosyalar
    const snap = await driveDb().collection('user-files')
      .where('userId', '==', userId)
      .where('updatedAt', '>', since)
      .orderBy('updatedAt', 'asc')
      .limit(100)
      .get();

    const changes = snap.docs.map(d => ({ ...d.data(), action: 'updated' }));

    // Silinen dosyaları da takip et
    const deletedSnap = await driveDb().collection('user-deleted-files')
      .where('userId', '==', userId)
      .where('deletedAt', '>', since)
      .limit(100)
      .get();

    const deleted = deletedSnap.docs.map(d => ({ fileId: d.id, action: 'deleted', deletedAt: d.data().deletedAt }));

    res.json({ ok: true, changes: [...changes, ...deleted], syncedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Sync kaydet (cihaz sync zamanını güncelle) ---
app.post('/api/sync/complete', async (req, res) => {
  try {
    const userId = req.body.userId || req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });

    const deviceId = req.body.deviceId || 'unknown';
    const now = new Date().toISOString();

    await driveDb().collection('user-sync').doc(userId).set({
      lastSyncAt: now,
      [`devices.${deviceId}`]: { lastSyncAt: now, userAgent: req.headers['user-agent'] || '' }
    }, { merge: true });

    res.json({ ok: true, syncedAt: now });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// =====================================================
// === TELEFON UPLOAD API (Mobil Optimizeli) ===
// =====================================================

// --- Telefondan çoklu fotoğraf yükle (scan veya drive) ---
app.post('/api/phone/upload', _driveUpload.array('photos', 50), async (req, res) => {
  try {
    const userId = req.body.userId || req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });
    if (!req.files || req.files.length === 0) return res.status(400).json({ ok: false, error: 'Fotoğraf gerekli' });

    const db = driveDb();
    const bucket = admin.storage().bucket();
    const target = req.body.target || 'drive'; // 'drive' veya 'scan'
    const scanId = req.body.scanId;
    const results = [];

    for (const file of req.files) {
      const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const ext = path.extname(file.originalname) || '.jpg';
      const storagePath = target === 'scan' && scanId
        ? `scans/${userId}/${scanId}/${fileId}${ext}`
        : `drive/${userId}/${fileId}${ext}`;

      const gcsFile = bucket.file(storagePath);
      await gcsFile.save(file.buffer, { metadata: { contentType: file.mimetype } });

      const url = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;

      if (target === 'scan' && scanId) {
        // Scan'a ekle
        const photoMeta = { photoId: fileId, url, storagePath, size: file.size, uploadedAt: new Date().toISOString() };
        await db.collection('user-scans').doc(scanId).update({
          photos: admin.firestore.FieldValue.arrayUnion(photoMeta),
          photoCount: admin.firestore.FieldValue.increment(1),
          updatedAt: new Date().toISOString()
        });
        results.push(photoMeta);
      } else {
        // Drive'a ekle
        const fileMeta = {
          fileId, name: file.originalname, type: 'photo', mimeType: file.mimetype,
          size: file.size, storagePath, url, tags: [], folder: '/uploads',
          userId, uploadedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        };
        await db.collection('user-files').doc(fileId).set(fileMeta);

        await db.collection('user-quotas').doc(userId).set({
          usedBytes: admin.firestore.FieldValue.increment(file.size),
          fileCount: admin.firestore.FieldValue.increment(1),
          lastUpload: new Date().toISOString()
        }, { merge: true });

        results.push(fileMeta);
      }
    }

    logger.info('Telefon upload tamamlandı', { userId, count: results.length, target });
    res.json({ ok: true, uploaded: results.length, files: results });
  } catch (err) {
    logger.error('Phone upload hatası', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Telefon sync durumu ---
app.get('/api/phone/sync', async (req, res) => {
  try {
    const userId = req.query.userId || req.headers['x-user-id'];
    if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });

    const [quotaDoc, syncDoc, filesSnap] = await Promise.all([
      driveDb().collection('user-quotas').doc(userId).get(),
      driveDb().collection('user-sync').doc(userId).get(),
      driveDb().collection('user-files').where('userId', '==', userId).orderBy('uploadedAt', 'desc').limit(10).get()
    ]);

    res.json({
      ok: true,
      quota: quotaDoc.exists ? quotaDoc.data() : { usedBytes: 0, maxBytes: 5368709120, fileCount: 0 },
      sync: syncDoc.exists ? syncDoc.data() : { lastSyncAt: null },
      recentFiles: filesSnap.docs.map(d => ({ fileId: d.data().fileId, name: d.data().name, type: d.data().type, url: d.data().url }))
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
