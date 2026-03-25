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
const io = new Server(server, { cors: { origin: config.allowedOrigins } });
app.use(cors({
  origin: function(origin, cb) {
    if (!origin || config.allowedOrigins.includes(origin)) return cb(null, true);
    cb(null, false);
  }
}));
// Güvenlik
const { promptInjectionGuard, authLimiter, bruteForceCheck, auditLog } = require('./middlewares/security');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // Dashboard inline script'ler için
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:", ...config.allowedOrigins],
    }
  }
})); // CSP kapalı (inline script'ler için)
app.use(express.json({ limit: config.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: config.bodyLimit }));

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimitWindow,
  max: config.rateLimitMax,
  message: { ok: false, error: 'Çok fazla istek. Lütfen bekleyin.' }
});
app.use('/api/', limiter);

// Dashboard ana sayfa
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// PhotoReel v9 app
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'photoreel_v9.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// API routes
const chatRoutes = require('./routes/api-chat');
app.use('/api/chat', chatRoutes(io));

// Agent API (tablet uzaktan kontrol)
const agentRoutes = require('./routes/api-agent');
app.use('/api/agent', agentRoutes);

// Local Claude (prompt injection korumalı)
const localClaudeRoutes = require('./routes/api-local-claude');
app.use('/api/claude-local', promptInjectionGuard, localClaudeRoutes);

// Tablet kontrol paneli
app.get('/kontrol', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kontrol.html'));
});

// Onay sistemi API
const approvalRoutes = require('./routes/api-approval');
app.use('/api/approval', approvalRoutes);

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
app.post('/api/queue/enqueue', (req, res) => {
  const { type, payload, userId } = req.body;
  if (!type) return res.status(400).json({ ok: false, error: 'type gerekli' });
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
app.post('/api/product/analyze', async (req, res) => {
  try {
    const { image, mimeType } = req.body;
    if (!image) return res.status(400).json({ ok: false, error: 'image (base64 veya URL) gerekli' });
    const analysis = await productAnalyzer.analyzeProduct(image, mimeType || 'image/jpeg');
    res.json({ ok: true, analysis });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/product/analyze-multiple', async (req, res) => {
  try {
    const { images } = req.body;
    if (!images || !Array.isArray(images)) return res.status(400).json({ ok: false, error: 'images dizisi gerekli' });
    const results = await productAnalyzer.analyzeMultipleProducts(images);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Arka Plan API
const bgGenerator = require('./services/background-generator');
app.post('/api/background/generate', (req, res) => {
  try {
    const { analysis, preferences } = req.body;
    if (!analysis) return res.status(400).json({ ok: false, error: 'analysis (ürün analizi) gerekli' });
    const bgConfig = bgGenerator.generateBackgroundConfig(analysis, preferences || {});
    res.json({ ok: true, background: bgConfig });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/background/themes', (req, res) => {
  res.json({ ok: true, themes: bgGenerator.BG_THEMES });
});

// Video Kurgu API
const videoEngine = require('./services/video-engine');
app.post('/api/video/storyboard', async (req, res) => {
  try {
    const { images, options } = req.body;
    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ ok: false, error: 'images dizisi gerekli' });
    }
    const storyboard = videoEngine.createStoryboard(images, options || {});
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
app.post('/api/tools/call', requireAuth, requirePermission('use_tools'), async (req, res) => {
  const { name, input, caller } = req.body;
  if (!name) return res.status(400).json({ ok: false, error: 'Tool adı gerekli' });
  const result = await aiTools.callTool(name, input || {}, caller || 'api');
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

// Health check (Cloud Run için)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// API Dokümantasyonu endpoint
app.get('/api/docs', (req, res) => {
  res.json({
    name: 'Fenix AI API',
    version: '1.0.0',
    description: 'E-ticaret ürün fotoğraflarından AI ile reels video üreten motor',
    endpoints: {
      auth: {
        'POST /api/auth/token': { body: { userId: 'string' }, response: { token: 'JWT' } }
      },
      chat: {
        'POST /api/chat/start': { body: { topic: 'string', maxTurns: 'number' } },
        'POST /api/chat/stop': {},
        'POST /api/chat/gemini': { body: { text: 'string' } },
        'POST /api/chat/claude': { body: { text: 'string' } },
        'GET /api/chat/status': {},
        'GET /api/chat/history': {}
      },
      agent: {
        'POST /api/agent/report': { body: { agentId: 'string', ...systemInfo } },
        'GET /api/agent/status/:agentId': {},
        'POST /api/agent/command/:agentId': { body: { type: 'screenshot|run|lock|...', data: 'string' } },
        'GET /api/agent/commands/:agentId': {},
        'GET /api/agent/results/:agentId': {}
      },
      approval: {
        'POST /api/approval/request': { body: { title: 'string', description: 'string' } },
        'GET /api/approval/pending': {},
        'POST /api/approval/respond/:id': { body: { decision: 'approved|rejected' } },
        'GET /api/approval/result/:id': {}
      },
      queue: {
        'POST /api/queue/enqueue': { body: { type: 'string', payload: 'object', userId: 'string' } },
        'GET /api/queue/job/:jobId': {},
        'GET /api/queue/stats': {}
      },
      claude: {
        'POST /api/claude-local/send': { body: { text: 'string', from: 'string' } },
        'GET /api/claude-local/inbox': {},
        'POST /api/claude-local/reply': { body: { text: 'string' } },
        'GET /api/claude-local/replies': { query: { since: 'number' } }
      },
      system: {
        'GET /health': {},
        'GET /api/docs': { description: 'Bu sayfa' }
      }
    }
  });
});

// Socket.io connection + auth
const { socketAuth } = require('./middlewares/auth');
io.use(socketAuth);
global.io = io;

io.on('connection', (socket) => {
  logger.debug('Dashboard bağlandı', { socketId: socket.id, user: socket.user?.userId });
  socket.emit('status', { state: 'idle', message: 'Bağlantı kuruldu' });

  socket.on('disconnect', () => {
    logger.debug('Dashboard ayrıldı', { socketId: socket.id });
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

async function saveQuota() {
  try { await stateService.saveQuota(quotaTracker); } catch(e) {
    logger.error('Kota kaydetme hatası', { error: e.message });
  }
}

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

// 404 ve hata yakalama (en sonda olmalı)
app.use(notFoundHandler);
app.use(errorHandler);

const PORT = config.port;
server.listen(PORT, () => {
  logger.info(`Fenix AI başlatıldı`, { port: PORT, env: config.env });
  logger.info(`Dashboard: http://localhost:${PORT}`);
  logger.info(`App: http://localhost:${PORT}/app`);
});
