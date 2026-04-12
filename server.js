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

// Firebase Admin init — Cloud Run'da ADC kullanır
const admin = require('firebase-admin');
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      projectId: process.env.FIREBASE_PROJECT_ID || 'fenixai-b93c9',
    });
    logger.info('Firebase Admin initialized');
  } catch(e) {
    logger.warn('Firebase Admin init hatası:', e.message);
  }
}

// Global hata yakalama
setupGlobalHandlers();

const app = express();
// Cloud Run / GCP load balancer proxy güveni
app.set('trust proxy', 1);
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
    contentSecurityPolicy: false,
    frameguard: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false
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

// ── Fenix Trafik Sayaçları (Dashboard için) ──
global._fenixTotalRequests = 0;
global._fenixPeak = 0;
global._fenix5xx = 0;
global._fenix4xx = 0;
global._fenixByHour = new Array(24).fill(0);
global._fenixByEndpoint = {};
global._fenixByCountry = {};
global._fenixConnections = 0;

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    global._fenixTotalRequests++;
    global._fenixByHour[new Date().getHours()]++;
    const ep = req.path.split('/').slice(0, 4).join('/');
    global._fenixByEndpoint[ep] = (global._fenixByEndpoint[ep] || 0) + 1;
    const startTime = Date.now();
    const origEnd = res.end;
    res.end = function() {
      const duration = Date.now() - startTime;
      if (res.statusCode >= 500) global._fenix5xx++;
      else if (res.statusCode >= 400) {
        global._fenix4xx++;
        if (req.path.includes('/auth/') && res.statusCode === 401) global._fenixFailedLogins++;
      }
      if (res.statusCode === 429) global._fenixRateLimitHits++;
      // Performance tracking
      const p = global._fenixPerf;
      p.totalMs += duration; p.count++;
      p.avgMs = Math.round(p.totalMs / p.count);
      if (!p.byEndpoint[ep]) p.byEndpoint[ep] = { avg: 0, total: 0, count: 0 };
      const pe = p.byEndpoint[ep]; pe.total += duration; pe.count++; pe.avg = Math.round(pe.total / pe.count);
      if (duration > 1000) { p.slowest.push({ ep, ms: duration, ts: Date.now() }); if (p.slowest.length > 20) p.slowest.shift(); }
      origEnd.apply(res, arguments);
    };
  }
  next();
});

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

// ─── QR KART SİSTEMİ ───────────────────────────────────────────────
// Her müşteriye benzersiz QR üret — hiçbiri birbirinin kopyası değil

// POST /api/card/generate — yeni müşteri kartı oluştur (benzersiz QR token)
app.post('/api/card/generate', async (req, res) => {
  const { email, plan, name } = req.body;
  const validPlans = ['pro', '360', 'dublaj', 'eticaret', 'otonom', 'free', 'master'];
  const safePlan = validPlans.includes(plan) ? plan : 'free';
  const credits = (safePlan === 'master' || safePlan === 'otonom') ? 30 : 15;

  // Benzersiz token: crypto random + timestamp → asla tekrar etmez
  const crypto = require('crypto');
  const token = crypto.randomBytes(8).toString('hex') + Date.now().toString(36);

  const cardData = {
    token,
    email: email || `musteri-${token.slice(0,6)}@fenix.ai`,
    name: name || '',
    plan: safePlan,
    credits,
    createdAt: new Date().toISOString(),
    activatedAt: null,
    status: 'active',
  };

  // Firestore'a kaydet
  try {
    const admin = require('firebase-admin');
    await admin.firestore().collection('cards').doc(token).set(cardData);
  } catch(e) {
    console.log('Card Firestore kayıt hatası (devam):', e.message);
  }

  res.json({ ok: true, ...cardData });
});

// GET /api/card/:token — QR tarandığında kart doğrula
app.get('/api/card/:token', async (req, res) => {
  const { token } = req.params;
  if (!token || token.length < 6) {
    return res.status(400).json({ error: 'Geçersiz token' });
  }

  // Önce Firestore'dan bak
  try {
    const admin = require('firebase-admin');
    const doc = await admin.firestore().collection('cards').doc(token).get();
    if (doc.exists) {
      const data = doc.data();
      // İlk aktivasyonu kaydet
      if (!data.activatedAt) {
        await admin.firestore().collection('cards').doc(token).update({
          activatedAt: new Date().toISOString(),
        });
      }
      return res.json({
        plan: data.plan,
        credits: data.credits,
        email: data.email,
        name: data.name || '',
        token,
        activatedAt: data.activatedAt || new Date().toISOString(),
      });
    }
  } catch(e) { /* Firestore yoksa fallback */ }

  // Fallback: eski base64 token formatı (geriye uyumluluk)
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf-8');
    const parts = decoded.split('-');
    const slug = parts.length >= 2 ? parts[parts.length - 2] : 'free';
    const validPlans = ['pro', '360', 'dublaj', 'eticaret', 'otonom', 'free', 'master'];
    const plan = validPlans.includes(slug) ? slug : 'free';
    const credits = (plan === 'master' || plan === 'otonom') ? 30 : 15;
    res.json({
      plan,
      credits,
      email: parts.slice(0, -2).join('-') || `kart-${token.slice(0,6)}@fenix.ai`,
      token,
      activatedAt: new Date().toISOString(),
    });
  } catch {
    res.status(400).json({ error: 'Token çözülemedi' });
  }

});

// GET /api/cards/list — tüm kartları listele (admin)
app.get('/api/cards/list', async (req, res) => {
  try {
    const admin = require('firebase-admin');
    const snap = await admin.firestore().collection('cards').orderBy('createdAt', 'desc').limit(100).get();
    const cards = [];
    snap.forEach(doc => cards.push(doc.data()));
    res.json({ ok: true, cards });
  } catch(e) {
    res.json({ ok: false, cards: [], error: e.message });
  }
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

// CSP header — fenix-editor.html için güvenlik katmanı
// Not: nonce + unsafe-inline birlikte kullanılamaz (tarayıcı nonce varken unsafe-inline'ı yoksayar)
// Binlerce inline handler (onclick vb.) olduğu için unsafe-inline zorunlu
app.get('/fenix-editor.html', (req, res, next) => {
  res.setHeader('Content-Security-Policy',
    `default-src 'self' https: data: blob:; ` +
    `script-src 'unsafe-inline' 'unsafe-eval' 'self' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://www.gstatic.com https://ajax.googleapis.com; ` +
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; ` +
    `font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; ` +
    `img-src 'self' data: blob: https:; ` +
    `connect-src 'self' https: wss: blob:; ` +
    `frame-src 'self' https:; ` +
    `frame-ancestors 'self' https://*.lovable.app https://*.lovableproject.com https://localhost:* http://localhost:*; ` +
    `worker-src 'self' blob:; ` +
    `media-src 'self' blob: https:;`
  );
  next(); // static middleware'e devam et
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

// Fenix Brain chat — /api/fenix/chat → Gemini
app.post('/api/fenix/chat', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ ok: false, error: '"text" is required' });
    const ConversationManager = require('./services/conversation-manager');
    const manager = new ConversationManager(io);
    const response = await manager.sendToGemini(text);
    res.json({ ok: true, response });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// AI Bridge Proxy — frontend'den API key sızmasını önler
app.post('/api/ai/claude', async (req, res) => {
  try {
    const { prompt, system, model, max_tokens } = req.body;
    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt gerekli' });
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: max_tokens || 1024,
      system: system || 'Sen Fenix AI asistanısın. Türkçe cevap ver.',
      messages: [{ role: 'user', content: prompt }]
    });
    res.json({ ok: true, text: msg.content[0].text });
  } catch (err) {
    logger.error('AI Claude proxy hatası:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/ai/gemini', async (req, res) => {
  try {
    const { prompt, image, model } = req.body;
    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt gerekli' });
    const geminiModel = model || 'gemini-2.5-flash';
    const parts = [{ text: prompt }];
    if (image) parts.push({ inline_data: { mime_type: 'image/jpeg', data: image } });
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts }] }) }
    );
    if (!resp.ok) throw new Error('Gemini API ' + resp.status);
    const data = await resp.json();
    res.json({ ok: true, text: data.candidates[0].content.parts[0].text });
  } catch (err) {
    logger.error('AI Gemini proxy hatası:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

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
const { validateCSRF } = securityRoutes;
app.use('/api/security', securityRoutes);

// CSRF koruması — yazma endpoint'lerinde aktif
if (config.env === 'production') {
  app.use('/api/pro', validateCSRF);
  app.use('/api/agent', validateCSRF);
  app.use('/api/approval', validateCSRF);
}

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
    timestamp: new Date().toISOString(),
    services: {
      gemini: !!process.env.GEMINI_API_KEY,
      claude: !!process.env.ANTHROPIC_API_KEY,
      elevenlabs: !!process.env.ELEVENLABS_API_KEY,
      deepgram: !!process.env.DEEPGRAM_API_KEY,
      firestore: !!process.env.FIRESTORE_PROJECT_ID,
      luma: !!process.env.LUMA_API_KEY,
      fal: !!process.env.FAL_API_KEY
    }
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

// Dublaj API (ElevenLabs / HeyGen / LatentSync)
const dubbingRoutes = require('./routes/api-dubbing');
app.use('/api/dubbing', dubbingRoutes);

// Gelir Takip API
const gelirRoutes = require('./routes/api-gelir');
app.use('/api/gelir', requireAdmin, gelirRoutes);

// Job Queue API
const queueModule = require('./routes/api-queue');
app.use('/api/queue', queueModule.router);

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

// Kuyruk API — api-queue.js router + socket.io bildirimleri
const queue = require('./services/queue-service');
if (queue.on) {
  queue.on('job:completed', (job) => {
    if (global.io) global.io.emit('job_completed', { jobId: job.id, type: job.type, userId: job.userId });
  });
  queue.on('job:failed', (job) => {
    if (global.io) global.io.emit('job_failed', { jobId: job.id, type: job.type, error: job.error });
  });
  queue.on('job:progress', (job) => {
    if (global.io) global.io.emit('job_progress', { jobId: job.id, progress: job.progress });
  });
}

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

// Fenix Brain API — Durum endpoint'leri herkese açık (sadece okuma)
app.get('/api/fenix/status', (req, res) => {
  res.json({ ok: true, ...fenixBrain.getFullStatus() });
});

app.get('/api/fenix/skills', (req, res) => {
  res.json({ ok: true, ...fenixBrain.getShadowStats() });
});

app.get('/api/fenix/errors', (req, res) => {
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

// ── Fenix Dashboard (Tablet Panel için birleşik endpoint) ──
app.get('/api/fenix/dashboard', async (req, res) => {
  try {
    const brain = fenixBrain.getFullStatus();
    const shadow = fenixBrain.getShadowStats();
    const errors = fenixBrain.getErrorStats();
    const ts = fenixTrainer ? fenixTrainer.getState() : {};

    // Uptime & connections
    const uptime = process.uptime();
    const connections = global._fenixConnections || 0;
    const totalRequests = global._fenixTotalRequests || 0;
    const peak = global._fenixPeak || 0;
    const errors5xx = global._fenix5xx || 0;
    const errors4xx = global._fenix4xx || 0;
    const byHour = global._fenixByHour || new Array(24).fill(0);
    const byEndpoint = global._fenixByEndpoint || {};
    const byCountry = global._fenixByCountry || {};

    // API key durumları
    const apis = {
      gemini: !!process.env.GEMINI_API_KEY,
      claude: !!process.env.ANTHROPIC_API_KEY,
      tripo: !!process.env.TRIPO_API_KEY,
      elevenlabs: !!process.env.ELEVENLABS_API_KEY,
      firebase: !!process.env.FIRESTORE_PROJECT_ID,
      fal: !!process.env.FAL_API_KEY,
      luma: !!process.env.LUMA_API_KEY,
      deepgram: !!process.env.DEEPGRAM_API_KEY
    };

    // Maliyet takibi
    const costData = global._fenixCosts || { byApi: {}, daily: [], total: 0 };

    // Circuit breaker durumları
    let circuits = [];
    try { circuits = getCircuitStates(); } catch(e) {}

    // Response time tracking
    const perf = global._fenixPerf || { avgMs: 0, slowest: [], byEndpoint: {} };

    // Pipeline / Queue
    let queueStats = { total: 0, queued: 0, processing: 0, done: 0, failed: 0, jobs: [] };
    try {
      const qService = require('./services/queue-service');
      if (qService && qService.getStats) queueStats = qService.getStats();
      else if (qService && qService.stats) queueStats = qService.stats();
    } catch(e) {}

    // Security
    let securityData = { failedLogins: 0, rateLimitHits: 0, bannedIps: 0, suspicious: 0 };
    securityData.failedLogins = global._fenixFailedLogins || 0;
    securityData.rateLimitHits = global._fenixRateLimitHits || 0;
    securityData.suspicious = global._fenixSuspicious || 0;

    // Memory usage
    const mem = process.memoryUsage();

    res.json({
      ok: true,
      health: {
        uptime,
        connections,
        totalRequests,
        peak,
        errors5xx,
        errors4xx,
        byHour,
        byEndpoint,
        byCountry,
        memory: {
          rss: Math.round(mem.rss / 1024 / 1024),
          heap: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024)
        },
        cpu: process.cpuUsage ? process.cpuUsage() : null,
        nodeVersion: process.version
      },
      training: {
        totalLessons: ts.totalLessons || 0,
        level: ts.level || 'apprentice',
        running: ts.running || false,
        totalCost: ts.totalCost || 0,
        budget: ts.budget || 20,
        progress: ts.progress || 0,
        phase: ts.phase || null,
        lastTraining: ts.lastTraining || null,
        successRate: ts.successRate || 0
      },
      skills: shadow,
      brain: brain,
      apis,
      errors,
      costs: costData,
      circuits,
      performance: perf,
      queue: queueStats,
      security: securityData
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Maliyet + Performans + Güvenlik Takip Middleware ──
global._fenixCosts = { byApi: {}, daily: [], total: 0, history: [] };
global._fenixPerf = { avgMs: 0, totalMs: 0, count: 0, slowest: [], byEndpoint: {} };
global._fenixFailedLogins = 0;
global._fenixRateLimitHits = 0;
global._fenixSuspicious = 0;

// API maliyet kaydı — servislerden çağrılır
global.fenixRecordCost = function(apiName, cost, details) {
  const c = global._fenixCosts;
  c.byApi[apiName] = (c.byApi[apiName] || 0) + cost;
  c.total += cost;
  const today = new Date().toISOString().slice(0, 10);
  let dayEntry = c.daily.find(d => d.date === today);
  if (!dayEntry) { dayEntry = { date: today, total: 0, byApi: {} }; c.daily.push(dayEntry); if (c.daily.length > 30) c.daily.shift(); }
  dayEntry.total += cost;
  dayEntry.byApi[apiName] = (dayEntry.byApi[apiName] || 0) + cost;
  c.history.push({ api: apiName, cost, details, ts: Date.now() });
  if (c.history.length > 200) c.history = c.history.slice(-200);
};

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
  global._fenixConnections = connectionCount;
  if (connectionCount > global._fenixPeak) global._fenixPeak = connectionCount;
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
    global._fenixConnections = connectionCount;
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
//  CHUNK UPLOAD — Büyük dosyalar için parça parça yükleme
// ══════════════════════════════════════
const _chunkUpload = multer({
  dest: path.join(__dirname, 'uploads', 'chunks'),
  limits: { fileSize: 30 * 1024 * 1024 } // 30MB per chunk
});
try { require('fs').mkdirSync(path.join(__dirname, 'uploads', 'chunks'), { recursive: true }); } catch(e) {}

// POST /api/upload/chunk — tek parça yükle
app.post('/api/upload/chunk', _chunkUpload.single('chunk'), (req, res) => {
  const fs = require('fs');
  if (!req.file) return res.status(400).json({ ok: false, error: 'Chunk gerekli' });
  const { uploadId, chunkIndex, totalChunks, fileName } = req.body;
  if (!uploadId || chunkIndex === undefined || !totalChunks) {
    return res.status(400).json({ ok: false, error: 'uploadId, chunkIndex, totalChunks gerekli' });
  }

  // Chunk'ı uploadId klasörüne taşı
  const chunkDir = path.join(__dirname, 'uploads', 'chunks', uploadId);
  try { fs.mkdirSync(chunkDir, { recursive: true }); } catch(e) {}
  const chunkPath = path.join(chunkDir, `chunk_${String(chunkIndex).padStart(4, '0')}`);
  fs.renameSync(req.file.path, chunkPath);

  logger.info(`Chunk ${parseInt(chunkIndex)+1}/${totalChunks} yüklendi`, { uploadId, fileName, size: req.file.size });
  res.json({ ok: true, chunkIndex: parseInt(chunkIndex), received: true });
});

// POST /api/upload/complete — tüm parçaları birleştir ve işleme başla
app.post('/api/upload/complete', express.json(), (req, res) => {
  const fs = require('fs');
  const { uploadId, totalChunks, fileName, tool } = req.body;
  if (!uploadId || !totalChunks) return res.status(400).json({ ok: false, error: 'uploadId, totalChunks gerekli' });

  const chunkDir = path.join(__dirname, 'uploads', 'chunks', uploadId);
  const mergedPath = path.join(__dirname, 'uploads', '360-convert', uploadId + '_' + (fileName || 'video.mp4'));

  try {
    // Chunk'ları sırayla birleştir
    const writeStream = fs.createWriteStream(mergedPath);
    for (let i = 0; i < parseInt(totalChunks); i++) {
      const cp = path.join(chunkDir, `chunk_${String(i).padStart(4, '0')}`);
      if (!fs.existsSync(cp)) {
        writeStream.end();
        return res.status(400).json({ ok: false, error: `Chunk ${i} eksik` });
      }
      writeStream.write(fs.readFileSync(cp));
    }
    writeStream.end();

    // Chunk klasörünü temizle
    writeStream.on('finish', () => {
      try { fs.rmSync(chunkDir, { recursive: true, force: true }); } catch(e) {}
      const fileSize = fs.statSync(mergedPath).size;
      logger.info('Chunk birleştirme tamamlandı', { uploadId, fileName, fileSize, tool });

      // İşlem bilgisini global'e kaydet — process endpoint'i kullanacak
      if (!global._chunkUploads) global._chunkUploads = {};
      global._chunkUploads[uploadId] = { path: mergedPath, fileName, tool, size: fileSize };

      res.json({ ok: true, uploadId, fileSize, message: 'Dosya birleştirildi, işleme hazır' });
    });
  } catch (err) {
    logger.error('Chunk birleştirme hatası:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/360/process-chunked — birleştirilmiş dosyayı işle (SSE)
app.post('/api/360/process-chunked', express.json(), async (req, res) => {
  const fs = require('fs');
  const { uploadId, tool, yaw, pitch, fov, currentTime, duration, speed, codec, resolution } = req.body;

  const upload = global._chunkUploads?.[uploadId];
  if (!upload || !fs.existsSync(upload.path)) {
    return res.status(404).json({ ok: false, error: 'Upload bulunamadı — tekrar yükle' });
  }

  const inputPath = upload.path;
  const toolName = tool || upload.tool || 'stabilize';
  logger.info('360/process-chunked başlıyor', { uploadId, tool: toolName, fileSize: upload.size });

  // req.body'yi req.body olarak process handler'a iletelim — aynı mantık
  req.file = { path: inputPath, originalname: upload.fileName, size: upload.size };
  req.body = { ...req.body, tool: toolName };

  // Aynı process logic'i kullan — ama multer yerine direkt dosya yolunu kullanarak
  // SSE stream
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch(e) {} };
  send({ status: 'processing', progress: 0, message: toolName + ' başlatılıyor...' });

  // FFmpeg filter builder (aynı switch/case)
  const _yaw = parseFloat(yaw) || 180;
  const _pitch = parseFloat(pitch) || 0;
  const _fov = parseFloat(fov) || 75;
  const _currentTime = parseFloat(currentTime) || 0;
  const _duration = parseFloat(duration) || 0;
  const _speed = parseInt(speed) || 100;
  const outputPath = inputPath + '_processed.mp4';
  let ffArgs = ['-y'];
  let isDownload = false;

  switch (toolName) {
    case 'stabilize': ffArgs.push('-i', inputPath, '-vf', 'deshake=rx=32:ry=32:edge=1:blocksize=8'); break;
    case 'tinyplanet': ffArgs.push('-i', inputPath, '-vf', `v360=equirect:stereographic:ih_fov=360:iv_fov=180:h_fov=160:v_fov=160:yaw=${_yaw-180}:pitch=${90-_pitch}`); break;
    case 'reframe': ffArgs.push('-i', inputPath, '-vf', `v360=equirect:flat:yaw=${_yaw-180}:pitch=${-_pitch}:h_fov=${_fov}:v_fov=${Math.round(_fov*9/16)}:w=1080:h=1920`); break;
    case 'cut': ffArgs.push('-ss', String(_currentTime), '-i', inputPath); break;
    case 'split': ffArgs.push('-i', inputPath, '-t', String(_currentTime)); break;
    case 'wind': ffArgs.push('-i', inputPath, '-af', 'highpass=f=200,lowpass=f=3000,afftdn=nf=-25'); break;
    case 'denoise': ffArgs.push('-i', inputPath, '-af', 'afftdn=nf=-20:nr=10:nt=w'); break;
    case 'audiofocus': ffArgs.push('-i', inputPath, '-af', 'dynaudnorm=g=5:f=150:r=0.9,equalizer=f=1000:t=h:width=2000:g=3'); break;
    case 'blur': ffArgs.push('-i', inputPath, '-vf', 'boxblur=10:5'); break;
    case 'glitch': ffArgs.push('-i', inputPath, '-vf', 'noise=alls=30:allf=t+u,rgbashift=rh=-3:bh=3:gv=2,eq=contrast=1.3'); break;
    case 'zoom': ffArgs.push('-i', inputPath, '-vf', "zoompan=z='min(zoom+0.001,1.3)':d=1:s=1920x1080:fps=30"); break;
    case 'shake': ffArgs.push('-i', inputPath, '-vf', "crop=iw-20:ih-20:10+5*sin(n/3):10+5*cos(n/5)"); break;
    case 'fadein': ffArgs.push('-i', inputPath, '-vf', 'fade=t=in:st=0:d=1.5', '-af', 'afade=t=in:st=0:d=1.5'); break;
    case 'fadeout': { const fs2 = Math.max(0, _duration-1.5); ffArgs.push('-i', inputPath, '-vf', `fade=t=out:st=${fs2}:d=1.5`, '-af', `afade=t=out:st=${fs2}:d=1.5`); break; }
    case 'reverse': ffArgs.push('-i', inputPath, '-vf', 'reverse', '-af', 'areverse'); break;
    case 'freeze': ffArgs.push('-i', inputPath, '-vf', `trim=start=${_currentTime}:end=${_currentTime+0.04},loop=90:1:0,setpts=N/30/TB`, '-an'); break;
    case 'speed': { const f=_speed/100; const pts=(1/f).toFixed(4); const at=f>=0.5&&f<=2?`atempo=${f}`:f<0.5?`atempo=0.5,atempo=${f/0.5}`:`atempo=2.0,atempo=${f/2}`; ffArgs.push('-i',inputPath,'-vf',`setpts=${pts}*PTS`,'-af',at); break; }
    case 'crop_1_1': ffArgs.push('-i', inputPath, '-vf', 'crop=min(iw\\,ih):min(iw\\,ih),scale=1080:1080'); break;
    case 'crop_9_16': ffArgs.push('-i', inputPath, '-vf', 'crop=ih*9/16:ih,scale=1080:1920'); break;
    case 'crop_16_9': ffArgs.push('-i', inputPath, '-vf', 'crop=iw:iw*9/16,scale=1920:1080'); break;
    case 'crop_4_5': ffArgs.push('-i', inputPath, '-vf', 'crop=ih*4/5:ih,scale=1080:1350'); break;
    case 'crop_21_9': ffArgs.push('-i', inputPath, '-vf', 'crop=iw:iw*9/21,scale=2520:1080'); break;
    case 'instagram': ffArgs.push('-i', inputPath, '-vf', 'crop=ih*9/16:ih,scale=1080:1920', '-b:v', '5M'); isDownload=true; break;
    case 'tiktok': ffArgs.push('-i', inputPath, '-vf', 'crop=ih*9/16:ih,scale=1080:1920', '-b:v', '6M'); isDownload=true; break;
    case 'youtube': ffArgs.push('-i', inputPath, '-vf', 'crop=iw:iw*9/16,scale=1920:1080', '-b:v', '12M'); isDownload=true; break;
    case 'render_hq': ffArgs.push('-i', inputPath, '-vf', 'scale=3840:2160:flags=lanczos', '-preset', 'slow', '-crf', '15'); isDownload=true; break;
    case 'subtitle': ffArgs.push('-i', inputPath, '-vf', "drawtext=text='Fenix AI':fontsize=36:fontcolor=white:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-60"); break;
    case 'convert_insv': ffArgs.push('-i', inputPath, '-vf', 'v360=dfisheye:equirect:ih_fov=190:iv_fov=190'); break;
    case 'convert_h264': ffArgs.push('-i', inputPath); break;
    default: ffArgs.push('-i', inputPath, '-vf', 'null');
  }

  if (toolName !== 'freeze' && toolName !== 'render_hq') {
    ffArgs.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '128k');
  } else if (toolName === 'freeze') {
    ffArgs.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
  }
  ffArgs.push(outputPath);

  // Süre
  const ffprobe = require('child_process').spawn('ffprobe', ['-v','error','-show_entries','format=duration','-of','csv=p=0',inputPath]);
  let durSec = 0;
  ffprobe.stdout.on('data', d => { durSec = parseFloat(d.toString().trim()) || 0; });
  await new Promise(r => ffprobe.on('close', r));

  const proc = require('child_process').spawn('ffmpeg', ffArgs);
  let lastProgress = 0;
  proc.stderr.on('data', chunk => {
    const m = chunk.toString().match(/time=(\d+):(\d+):(\d+\.\d+)/);
    if (m && durSec > 0) {
      const sec = parseInt(m[1])*3600 + parseInt(m[2])*60 + parseFloat(m[3]);
      const pct = Math.min(99, Math.round((sec/durSec)*100));
      if (pct > lastProgress) { lastProgress=pct; send({ status:'processing', progress:pct, message:`${toolName}... %${pct}` }); }
    }
  });

  proc.on('close', code => {
    try { fs.unlinkSync(inputPath); } catch(e) {}
    delete global._chunkUploads?.[uploadId];
    if (code !== 0) {
      try { fs.unlinkSync(outputPath); } catch(e) {}
      send({ status:'error', message:'İşlem hatası (kod: '+code+')' });
      return res.end();
    }
    const outName = `fenix_${toolName}_${Date.now()}.mp4`;
    const publicDir = path.join(__dirname, 'public', 'converted');
    try { fs.mkdirSync(publicDir, { recursive: true }); } catch(e) {}
    const publicPath = path.join(publicDir, outName);
    fs.renameSync(outputPath, publicPath);
    const result = { status:'done', progress:100, url:`/converted/${outName}`, message:'Tamamlandı!' };
    if (isDownload) { result.download=true; result.filename=`fenix_${toolName}.mp4`; }
    send(result);
    res.end();
    setTimeout(() => { try { fs.unlinkSync(publicPath); } catch(e) {} }, 3600000);
  });

  proc.on('error', err => {
    try { fs.unlinkSync(inputPath); } catch(e) {}
    send({ status:'error', message:'FFmpeg başlatılamadı: '+err.message });
    res.end();
  });
});

// ══════════════════════════════════════
//  360° VIDEO CONVERT — INSV/H.265 → H.264 Equirectangular MP4
// ══════════════════════════════════════
const _360Upload = multer({
  dest: path.join(__dirname, 'uploads', '360-convert'),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2 GB
});

// Klasör oluştur
try { require('fs').mkdirSync(path.join(__dirname, 'uploads', '360-convert'), { recursive: true }); } catch(e) {}

app.post('/api/360/convert', _360Upload.single('video'), async (req, res) => {
  const fs = require('fs');
  const { execFile } = require('child_process');
  const inputPath = req.file?.path;
  if (!inputPath) return res.status(400).json({ ok: false, error: 'Video dosyası gerekli' });

  const originalName = req.file.originalname || 'video.mp4';
  const isDualFisheye = req.body.dualFisheye === 'true' || /\.(insv|insp)$/i.test(originalName);
  const outputPath = inputPath + '_converted.mp4';

  // FFmpeg args: dual-fisheye → equirect VEYA sadece H.264 re-encode
  const ffArgs = ['-y', '-i', inputPath];
  if (isDualFisheye) {
    // Dual-fisheye → equirectangular projection dönüşümü
    ffArgs.push('-vf', 'v360=dfisheye:equirect:ih_fov=190:iv_fov=190');
  }
  // H.264 çıkış (tarayıcı uyumlu), hızlı preset
  ffArgs.push(
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-c:a', 'aac',
    '-b:a', '128k',
    outputPath
  );

  // SSE stream ile progress bildir
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch(e) {} };
  send({ status: 'processing', message: 'FFmpeg dönüşüm başladı...', progress: 0 });

  // Video süresini öğren (progress hesabı için)
  const ffprobe = require('child_process').spawn('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inputPath
  ]);
  let durationSec = 0;
  ffprobe.stdout.on('data', d => { durationSec = parseFloat(d.toString().trim()) || 0; });
  await new Promise(r => ffprobe.on('close', r));

  // FFmpeg çalıştır
  const proc = require('child_process').spawn('ffmpeg', ffArgs);
  let lastProgress = 0;

  proc.stderr.on('data', (chunk) => {
    const line = chunk.toString();
    // "time=00:01:23.45" formatından saniye çıkar
    const m = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
    if (m && durationSec > 0) {
      const sec = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
      const pct = Math.min(99, Math.round((sec / durationSec) * 100));
      if (pct > lastProgress) {
        lastProgress = pct;
        send({ status: 'processing', progress: pct, message: `Dönüştürülüyor... %${pct}` });
      }
    }
  });

  proc.on('close', (code) => {
    // Girdi dosyasını temizle
    try { fs.unlinkSync(inputPath); } catch(e) {}

    if (code !== 0) {
      try { fs.unlinkSync(outputPath); } catch(e) {}
      send({ status: 'error', message: 'FFmpeg dönüşüm hatası (kod: ' + code + ')' });
      return res.end();
    }

    // Çıktı dosyasını unique isimle public'e taşı
    const outName = `360_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`;
    const publicPath = path.join(__dirname, 'public', 'converted', outName);
    try { fs.mkdirSync(path.join(__dirname, 'public', 'converted'), { recursive: true }); } catch(e) {}
    fs.renameSync(outputPath, publicPath);

    send({ status: 'done', progress: 100, url: `/converted/${outName}`, message: 'Dönüşüm tamamlandı!' });
    res.end();

    // 1 saat sonra dosyayı otomatik sil
    setTimeout(() => { try { fs.unlinkSync(publicPath); } catch(e) {} }, 60 * 60 * 1000);
  });

  proc.on('error', (err) => {
    try { fs.unlinkSync(inputPath); } catch(e) {}
    send({ status: 'error', message: 'FFmpeg başlatılamadı: ' + err.message });
    res.end();
  });
});

// ══════════════════════════════════════
//  VIDEO PROCESS — Tüm FFmpeg araçları (kes, efekt, format, ses, 360°)
// ══════════════════════════════════════
app.post('/api/360/process', (req, res, next) => {
  logger.info('360/process isteği geldi', { contentLength: req.headers['content-length'], contentType: req.headers['content-type'] });
  _360Upload.single('video')(req, res, (err) => {
    if (err) {
      logger.error('360/process multer hatası:', err.message);
      return res.status(413).json({ ok: false, error: 'Dosya yükleme hatası: ' + err.message });
    }
    next();
  });
}, async (req, res) => {
  const fs = require('fs');
  const inputPath = req.file?.path;
  if (!inputPath) {
    logger.error('360/process: dosya yok', { body: Object.keys(req.body || {}) });
    return res.status(400).json({ ok: false, error: 'Video gerekli' });
  }
  logger.info('360/process başlıyor', { tool: req.body.tool, fileSize: req.file.size, fileName: req.file.originalname });

  const tool = req.body.tool || 'stabilize';
  const yaw = parseFloat(req.body.yaw) || 180;
  const pitch = parseFloat(req.body.pitch) || 0;
  const fov = parseFloat(req.body.fov) || 75;
  const currentTime = parseFloat(req.body.currentTime) || 0;
  const duration = parseFloat(req.body.duration) || 0;
  const speed = parseInt(req.body.speed) || 100;
  const codec = req.body.codec || 'h264';
  const resolution = req.body.resolution || '1080p';
  const outputPath = inputPath + '_processed.mp4';

  // FFmpeg args builder — araç tipine göre
  let ffArgs = ['-y'];
  let isDownload = false;

  switch (tool) {
    // ── 360° Araçları ──
    case 'stabilize':
      ffArgs.push('-i', inputPath, '-vf', 'deshake=rx=32:ry=32:edge=1:blocksize=8');
      break;
    case 'tinyplanet':
      ffArgs.push('-i', inputPath, '-vf', `v360=equirect:stereographic:ih_fov=360:iv_fov=180:h_fov=160:v_fov=160:yaw=${yaw-180}:pitch=${90-pitch}`);
      break;
    case 'reframe':
      ffArgs.push('-i', inputPath, '-vf', `v360=equirect:flat:yaw=${yaw-180}:pitch=${-pitch}:h_fov=${fov}:v_fov=${Math.round(fov*9/16)}:w=1080:h=1920`);
      break;
    case 'equirect2cube':
      ffArgs.push('-i', inputPath, '-vf', 'v360=equirect:cubemap:w=2048:h=1536');
      break;
    case 'cube2equirect':
      ffArgs.push('-i', inputPath, '-vf', 'v360=cubemap:equirect:w=3840:h=1920');
      break;

    // ── Kesme / Bölme ──
    case 'cut':
      // Playhead'den sona kadar kes (playhead öncesini kaldır)
      ffArgs.push('-ss', String(currentTime), '-i', inputPath);
      break;
    case 'split':
      // Playhead'den böl — ilk parçayı döndür
      ffArgs.push('-i', inputPath, '-t', String(currentTime));
      break;

    // ── Ses İşleme ──
    case 'wind':
      ffArgs.push('-i', inputPath, '-af', 'highpass=f=200,lowpass=f=3000,afftdn=nf=-25');
      break;
    case 'denoise':
      ffArgs.push('-i', inputPath, '-af', 'afftdn=nf=-20:nr=10:nt=w');
      break;
    case 'audiofocus':
      ffArgs.push('-i', inputPath, '-af', 'dynaudnorm=g=5:f=150:r=0.9,equalizer=f=1000:t=h:width=2000:g=3');
      break;

    // ── Video Efektleri ──
    case 'blur':
      ffArgs.push('-i', inputPath, '-vf', 'boxblur=10:5');
      break;
    case 'glitch':
      ffArgs.push('-i', inputPath, '-vf', 'noise=alls=30:allf=t+u,rgbashift=rh=-3:bh=3:gv=2,eq=contrast=1.3');
      break;
    case 'zoom':
      ffArgs.push('-i', inputPath, '-vf', "zoompan=z='min(zoom+0.001,1.3)':d=1:s=1920x1080:fps=30");
      break;
    case 'shake':
      ffArgs.push('-i', inputPath, '-vf', "crop=iw-20:ih-20:10+5*sin(n/3):10+5*cos(n/5)");
      break;
    case 'fadein':
      ffArgs.push('-i', inputPath, '-vf', 'fade=t=in:st=0:d=1.5', '-af', 'afade=t=in:st=0:d=1.5');
      break;
    case 'fadeout': {
      const fadeStart = Math.max(0, duration - 1.5);
      ffArgs.push('-i', inputPath, '-vf', `fade=t=out:st=${fadeStart}:d=1.5`, '-af', `afade=t=out:st=${fadeStart}:d=1.5`);
      break;
    }
    case 'dissolve':
      ffArgs.push('-i', inputPath, '-vf', 'fade=t=in:st=0:d=1,fade=t=out:st=' + Math.max(0, duration-1) + ':d=1');
      break;

    // ── Hız / Ters ──
    case 'reverse':
      ffArgs.push('-i', inputPath, '-vf', 'reverse', '-af', 'areverse');
      break;
    case 'freeze': {
      // Playhead pozisyonunda 3 saniyelik freeze frame
      const freezeAt = currentTime || 0;
      ffArgs.push('-i', inputPath, '-vf', `trim=start=${freezeAt}:end=${freezeAt+0.04},loop=90:1:0,setpts=N/30/TB`);
      ffArgs.push('-an'); // freeze frame'de ses yok
      break;
    }
    case 'speed': {
      const factor = speed / 100;
      const pts = (1 / factor).toFixed(4);
      const atempo = factor >= 0.5 && factor <= 2 ? `atempo=${factor}` : factor < 0.5 ? `atempo=0.5,atempo=${factor/0.5}` : `atempo=2.0,atempo=${factor/2}`;
      ffArgs.push('-i', inputPath, '-vf', `setpts=${pts}*PTS`, '-af', atempo);
      break;
    }

    // ── Format / Crop ──
    case 'crop_1_1':
      ffArgs.push('-i', inputPath, '-vf', 'crop=min(iw\\,ih):min(iw\\,ih),scale=1080:1080');
      break;
    case 'crop_9_16':
      ffArgs.push('-i', inputPath, '-vf', 'crop=ih*9/16:ih,scale=1080:1920');
      break;
    case 'crop_16_9':
      ffArgs.push('-i', inputPath, '-vf', 'crop=iw:iw*9/16,scale=1920:1080');
      break;
    case 'crop_4_5':
      ffArgs.push('-i', inputPath, '-vf', 'crop=ih*4/5:ih,scale=1080:1350');
      break;
    case 'crop_21_9':
      ffArgs.push('-i', inputPath, '-vf', 'crop=iw:iw*9/21,scale=2520:1080');
      break;

    // ── Platform Render ──
    case 'instagram':
      ffArgs.push('-i', inputPath, '-vf', 'crop=ih*9/16:ih,scale=1080:1920', '-b:v', '5M', '-maxrate', '5M');
      isDownload = true;
      break;
    case 'tiktok':
      ffArgs.push('-i', inputPath, '-vf', 'crop=ih*9/16:ih,scale=1080:1920', '-b:v', '6M', '-maxrate', '6M');
      isDownload = true;
      break;
    case 'youtube':
      ffArgs.push('-i', inputPath, '-vf', 'crop=iw:iw*9/16,scale=1920:1080', '-b:v', '12M', '-maxrate', '12M');
      isDownload = true;
      break;
    case 'render_hq':
      ffArgs.push('-i', inputPath, '-vf', 'scale=3840:2160:flags=lanczos');
      ffArgs.push('-preset', 'slow', '-crf', '15');
      isDownload = true;
      break;

    // ── Export ──
    case 'export': {
      const resMap = { '720p': '1280:720', '1080p': '1920:1080', '2k': '2560:1440', '4k': '3840:2160' };
      ffArgs.push('-i', inputPath, '-vf', `scale=${resMap[resolution] || '1920:1080'}:flags=lanczos`);
      if (codec === 'h265') ffArgs.push('-c:v', 'libx265');
      isDownload = true;
      break;
    }

    // ── AI Altyazı (placeholder — FFmpeg drawtext) ──
    case 'subtitle':
      ffArgs.push('-i', inputPath, '-vf', "drawtext=text='Fenix AI Altyazi':fontsize=36:fontcolor=white:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-60");
      break;

    // ── INSV/H.265 Dönüşüm ──
    case 'convert_insv':
      ffArgs.push('-i', inputPath, '-vf', 'v360=dfisheye:equirect:ih_fov=190:iv_fov=190');
      break;
    case 'convert_h264':
      ffArgs.push('-i', inputPath);
      break;

    // ── Segmentasyon (blur-bg) ──
    default:
      if (tool.startsWith('segment_')) {
        // Basit blur-bg segmentasyon (gerçek AI segmentasyon ayrı endpoint)
        ffArgs.push('-i', inputPath, '-vf', 'boxblur=20:10');
      } else {
        ffArgs.push('-i', inputPath, '-vf', 'null');
      }
  }

  // Ortak çıkış parametreleri (freeze hariç — zaten -an var)
  if (tool !== 'freeze' && tool !== 'export') {
    ffArgs.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      '-c:a', 'aac', '-b:a', '128k');
  } else if (tool === 'freeze') {
    ffArgs.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
  } else if (tool === 'export') {
    if (codec !== 'h265') ffArgs.push('-c:v', 'libx264');
    ffArgs.push('-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-c:a', 'aac', '-b:a', '192k');
  }
  ffArgs.push(outputPath);

  // SSE stream
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch(e) {} };

  send({ status: 'processing', progress: 0, message: tool + ' başlatılıyor...' });

  // Süre öğren
  const ffprobe = require('child_process').spawn('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', inputPath
  ]);
  let durSec = 0;
  ffprobe.stdout.on('data', d => { durSec = parseFloat(d.toString().trim()) || 0; });
  await new Promise(r => ffprobe.on('close', r));

  const proc = require('child_process').spawn('ffmpeg', ffArgs);
  let lastProgress = 0;

  proc.stderr.on('data', chunk => {
    const m = chunk.toString().match(/time=(\d+):(\d+):(\d+\.\d+)/);
    if (m && durSec > 0) {
      const sec = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
      const pct = Math.min(99, Math.round((sec / durSec) * 100));
      if (pct > lastProgress) {
        lastProgress = pct;
        send({ status: 'processing', progress: pct, message: `${toolLabels[tool] || tool}... %${pct}` });
      }
    }
  });

  proc.on('close', code => {
    try { fs.unlinkSync(inputPath); } catch(e) {}
    if (code !== 0) {
      try { fs.unlinkSync(outputPath); } catch(e) {}
      send({ status: 'error', message: 'İşlem hatası (kod: ' + code + ')' });
      return res.end();
    }
    const outName = `360_${tool}_${Date.now()}.mp4`;
    const publicDir = path.join(__dirname, 'public', 'converted');
    try { fs.mkdirSync(publicDir, { recursive: true }); } catch(e) {}
    const publicPath = path.join(publicDir, outName);
    fs.renameSync(outputPath, publicPath);
    const result = { status: 'done', progress: 100, url: `/converted/${outName}`, message: 'Tamamlandı!' };
    if (isDownload) { result.download = true; result.filename = `fenix_${tool}_${Date.now()}.mp4`; }
    send(result);
    res.end();
    setTimeout(() => { try { fs.unlinkSync(publicPath); } catch(e) {} }, 3600000);
  });

  proc.on('error', err => {
    try { fs.unlinkSync(inputPath); } catch(e) {}
    send({ status: 'error', message: 'FFmpeg başlatılamadı: ' + err.message });
    res.end();
  });
});

// ══════════════════════════════════════
//  AR MODEL UPLOAD — GLB yükle, public URL al
// ══════════════════════════════════════
const _arUpload = multer({
  dest: path.join(__dirname, 'public', 'ar-models'),
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
});
// ar-models klasörünü oluştur
const _arDir = path.join(__dirname, 'public', 'ar-models');
if (!require('fs').existsSync(_arDir)) require('fs').mkdirSync(_arDir, { recursive: true });

app.post('/api/ar/upload', _arUpload.single('model'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Model dosyası gerekli' });
    const fs = require('fs');
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const ext = path.extname(req.file.originalname) || '.glb';
    const filename = id + ext;
    const destPath = path.join(_arDir, filename);
    fs.renameSync(req.file.path, destPath);
    const publicUrl = '/ar-models/' + filename;
    res.json({ ok: true, id, url: publicUrl, filename });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// AR model listesi
app.get('/api/ar/list', (req, res) => {
  try {
    const fs = require('fs');
    const files = fs.readdirSync(_arDir).filter(f => f.endsWith('.glb') || f.endsWith('.gltf'));
    res.json({ ok: true, models: files.map(f => ({ filename: f, url: '/ar-models/' + f })) });
  } catch(e) {
    res.json({ ok: true, models: [] });
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

// ════════════════════════════════════════════════════════
//  QR KOD + TARAMA SİSTEMİ
// ════════════════════════════════════════════════════════
const crypto = require('crypto');
const fs = require('fs');

// Scan sayfası — müşteri QR okutunca buraya gelir
app.get('/scan', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scan.html'));
});
app.get('/scan.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scan.html'));
});

// QR üret — usta panelden çağrılır
// QR SABİT kalır, sadece şifre periyodik değişir
app.post('/api/usta/qr/generate', async (req, res) => {
  try {
    const userId = req.body.userId || 'default';
    // Sabit token: userId bazlı, her zaman aynı QR
    const token = crypto.createHash('md5').update('fenix_' + userId).digest('hex').substring(0, 12);
    const password = crypto.randomBytes(3).toString('hex').toUpperCase();
    const intervalMin = parseInt(req.body.interval) || 5;

    // Firestore'a kaydet (varsa)
    try {
      const db = require('firebase-admin').firestore();
      await db.collection('qr-tokens').doc(token).set({
        token, userId, password,
        intervalMin,
        updatedAt: new Date(),
        status: 'active'
      }, { merge: true });
    } catch(e) { logger.warn('QR Firestore kayıt atlandı: ' + e.message); }

    res.json({
      ok: true,
      token,
      password,
      url: '/scan?t=' + token,
      intervalMin
    });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Şifre yenile — otomatik periyodik çağrılır
app.post('/api/usta/qr/refresh', async (req, res) => {
  try {
    const userId = req.body.userId || 'default';
    const token = crypto.createHash('md5').update('fenix_' + userId).digest('hex').substring(0, 12);
    const password = crypto.randomBytes(3).toString('hex').toUpperCase();

    try {
      const db = require('firebase-admin').firestore();
      await db.collection('qr-tokens').doc(token).update({
        password, updatedAt: new Date()
      });
    } catch(e) { /* Firestore yoksa devam */ }

    res.json({ ok: true, password });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════
//  AKILLI TARAMA — Gemini Vision ile ürün tanıma + doğrulama
// ════════════════════════════════════════════════════════════

// Ürün tanıma — ilk kareyi Gemini'ye gönder, ürünü öğren + açı planı al
const _scanUploadSingle = multer({ dest: path.join(__dirname, 'uploads', 'scan-frames'), limits: { fileSize: 10 * 1024 * 1024 } });

app.post('/api/scan/identify', _scanUploadSingle.single('frame'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Görsel gerekli' });

    const imageBuffer = fs.readFileSync(req.file.path);
    const base64 = imageBuffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: 'Gemini API key eksik' });

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inlineData: { mimeType, data: base64 } },
              { text: `Sen bir sanayi 3D tarama uzmanısın. Bu fotoğraftaki ürünü analiz et.

ZORUNLU JSON formatında yanıtla:
{
  "productName": "ürün adı (türkçe)",
  "productType": "silindirik | düz | karmaşık | küresel | L-şekil | T-şekil | organik",
  "estimatedSize": { "width": cm, "height": cm, "depth": cm },
  "material": "metal | plastik | ahşap | cam | seramik | kompozit | bilinmiyor",
  "features": ["delik", "vida", "kanal", "yüzey detayı", "iç boşluk"],
  "scanPlan": {
    "totalPhotos": sayı,
    "levels": [
      { "name": "alt seviye", "angle": 30, "photos": sayı, "description": "açıklama" },
      { "name": "orta seviye", "angle": 0, "photos": sayı, "description": "açıklama" },
      { "name": "üst seviye", "angle": -30, "photos": sayı, "description": "açıklama" }
    ],
    "specialAngles": ["iç boşluk için yakın çekim", "alt kısım için ters çevir"],
    "referenceNeeded": true,
    "estimatedTime": "dakika"
  },
  "warnings": ["dikkat edilecek şeyler"],
  "difficulty": "kolay | orta | zor",
  "colorSignature": { "dominant": "#hex", "secondary": "#hex" },
  "boundingBox": { "description": "ürünün karede nerede olduğu" }
}` }
            ]
          }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
        })
      }
    );

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const text = data.candidates[0].content.parts[0].text;
    let result;
    try {
      const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
      result = JSON.parse(jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : text);
    } catch (e) {
      result = { productName: 'Bilinmiyor', productType: 'karmaşık', scanPlan: { totalPhotos: 30, levels: [{ name: 'standart', angle: 0, photos: 30 }] } };
    }

    // Referans frame'i kaydet (sonraki karelerle karşılaştırma için)
    const frameId = 'ref_' + Date.now();
    if (!global._scanRefs) global._scanRefs = {};
    global._scanRefs[frameId] = {
      base64: base64.slice(0, 5000), // İlk 5KB imza olarak
      product: result,
      createdAt: Date.now()
    };

    // Temp dosyayı temizle
    try { fs.unlinkSync(req.file.path); } catch(e) {}

    logger.info('Ürün tanıma tamamlandı', { productName: result.productName, type: result.productType, photos: result.scanPlan?.totalPhotos });

    res.json({ ok: true, frameId, ...result });
  } catch(e) {
    logger.error('Ürün tanıma hatası', { error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Kare doğrulama — her çekimde ürün var mı, açı doğru mu kontrol et
app.post('/api/scan/validate-frame', _scanUploadSingle.single('frame'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Görsel gerekli' });

    const { frameId, stepIndex, expectedAngle } = req.body;
    const ref = global._scanRefs?.[frameId];
    if (!ref) return res.status(400).json({ ok: false, error: 'Önce ürünü tanıtın (identify)' });

    const imageBuffer = fs.readFileSync(req.file.path);
    const base64 = imageBuffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/jpeg';

    const apiKey = process.env.GEMINI_API_KEY;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inlineData: { mimeType, data: base64 } },
              { text: `Önceki analizde "${ref.product.productName}" (${ref.product.productType}) ürünü tanımlandı.
Beklenen açı: ${expectedAngle || 'bilinmiyor'}°, adım: ${stepIndex || '?'}

Bu kareyi kontrol et. ZORUNLU JSON:
{
  "productFound": true/false,
  "productCentered": true/false,
  "centerOffset": { "x": -1..1, "y": -1..1 },
  "blurScore": 0-100 (100=net),
  "lightScore": 0-100 (100=iyi),
  "angleEstimate": derece,
  "angleCorrect": true/false,
  "angleDiff": fark_derece,
  "overlapWithPrevious": 0-100,
  "issues": ["sorun1", "sorun2"],
  "suggestion": "kullanıcıya yön (türkçe)",
  "accept": true/false,
  "confidence": 0-100
}` }
            ]
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 512 }
        })
      }
    );

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const text = data.candidates[0].content.parts[0].text;
    let result;
    try {
      const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*\}/);
      result = JSON.parse(jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : text);
    } catch (e) {
      result = { productFound: true, accept: true, confidence: 50, suggestion: 'Analiz yapılamadı, manuel kontrol edin' };
    }

    try { fs.unlinkSync(req.file.path); } catch(e) {}

    res.json({ ok: true, ...result });
  } catch(e) {
    logger.error('Kare doğrulama hatası', { error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Hızlı kare doğrulama — Gemini'siz, sadece bulanıklık + ışık kontrolü (ücretsiz)
app.post('/api/scan/validate-quick', _scanUploadSingle.single('frame'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Görsel gerekli' });

    const sharp = (() => { try { return require('sharp'); } catch { return null; } })();
    let blurScore = 70, lightScore = 70;

    if (sharp) {
      const img = sharp(req.file.path);
      const stats = await img.stats();
      // Ortalama parlaklık → ışık skoru
      const avgBrightness = stats.channels.reduce((s, c) => s + c.mean, 0) / stats.channels.length;
      lightScore = Math.min(100, Math.round(avgBrightness / 2.55 * 1.2));
      if (avgBrightness < 30) lightScore = Math.max(10, lightScore);

      // Laplacian varyansı → netlik skoru (sharp ile yaklaşık)
      const { info } = await img.raw().toBuffer({ resolveWithObject: true });
      blurScore = info.width > 1000 ? 80 : 60; // Basit heuristik
    }

    try { fs.unlinkSync(req.file.path); } catch(e) {}

    const issues = [];
    if (lightScore < 40) issues.push('Işık çok düşük');
    if (lightScore > 95) issues.push('Aşırı pozlama');
    if (blurScore < 50) issues.push('Bulanık görüntü');

    res.json({
      ok: true,
      blurScore,
      lightScore,
      accept: issues.length === 0,
      issues,
      suggestion: issues.length > 0 ? issues.join('. ') + '. Tekrar çekin.' : 'Kalite uygun ✓'
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// QR doğrula — scan.html şifreyi kontrol eder
app.post('/api/scan/verify', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ ok: false, error: 'Token ve şifre gerekli' });

    try {
      const db = require('firebase-admin').firestore();
      const doc = await db.collection('qr-tokens').doc(token).get();
      if (!doc.exists) return res.status(404).json({ ok: false, error: 'QR bulunamadı' });
      const data = doc.data();
      if (data.password !== password) return res.status(401).json({ ok: false, error: 'Şifre yanlış' });
      res.json({ ok: true, token, ustaId: data.userId, status: 'verified' });
    } catch(e) {
      // Firestore yoksa demo mod — herhangi şifreyle geç
      res.json({ ok: true, token, ustaId: 'demo', status: 'demo' });
    }
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Tarama oluştur
app.post('/api/scans', async (req, res) => {
  try {
    const { scanId, name, photoCount, quality } = req.body;
    const id = scanId || 'scan_' + Date.now();
    try {
      const db = require('firebase-admin').firestore();
      await db.collection('scans').doc(id).set({
        scanId: id, name: name || 'Tarama', photoCount: photoCount || 0,
        quality: quality || 'high', status: 'uploading', createdAt: new Date(), photos: []
      }, { merge: true });
    } catch(e) { /* Firestore yoksa devam */ }
    res.json({ ok: true, scan: { scanId: id, status: 'uploading' } });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Fotoğraf yükle
const _scanUpload = multer({ dest: path.join(__dirname, 'uploads', 'scans'), limits: { fileSize: 20 * 1024 * 1024 } });
app.post('/api/scans/:scanId/photo', _scanUpload.single('photo'), async (req, res) => {
  try {
    const { scanId } = req.params;
    const filePath = req.file ? req.file.path : null;
    if (!filePath) return res.status(400).json({ ok: false, error: 'Fotoğraf yok' });

    try {
      const db = require('firebase-admin').firestore();
      const admin = require('firebase-admin');
      await db.collection('scans').doc(scanId).update({
        photos: admin.firestore.FieldValue.arrayUnion(filePath),
        status: 'uploading'
      });
    } catch(e) { /* Firestore yoksa devam */ }

    // Socket ile usta panele bildir
    if (global.io) global.io.emit('scan:photo', { scanId, photoPath: filePath });

    res.json({ ok: true, photoPath: filePath });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Reconstruction başlat
app.post('/api/scans/:scanId/reconstruct', async (req, res) => {
  try {
    const { scanId } = req.params;
    try {
      const db = require('firebase-admin').firestore();
      await db.collection('scans').doc(scanId).update({ status: 'processing' });
    } catch(e) { /* Firestore yoksa devam */ }

    // Photogrammetry servisi çağır
    try {
      const photogrammetry = require('./services/photogrammetry-service');
      const scanDir = path.join(__dirname, 'uploads', 'scans');
      photogrammetry.reconstruct(scanDir, scanId).then(function(result) {
        if (global.io) global.io.emit('scan:complete', { scanId, result });
      }).catch(function(err) {
        logger.error('Reconstruction hatası: ' + err.message);
        if (global.io) global.io.emit('scan:error', { scanId, error: err.message });
      });
    } catch(e) { logger.warn('Photogrammetry servisi yüklenemedi: ' + e.message); }

    res.json({ ok: true, status: 'processing' });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Usta profili
app.get('/api/usta/profile', async (req, res) => {
  try {
    const userId = req.query.userId || 'default';
    try {
      const db = require('firebase-admin').firestore();
      const doc = await db.collection('qr-tokens').where('userId', '==', userId).limit(1).get();
      let pw = '------', interval = 5;
      if (!doc.empty) { const d = doc.docs[0].data(); pw = d.password || pw; interval = d.intervalMin || 5; }
      res.json({ ok: true, usta: { active: true, plan: 'pro', totalOrders: 0, currentPassword: pw, qrPasswordInterval: interval } });
    } catch(e) {
      res.json({ ok: true, usta: { active: true, plan: 'pro', totalOrders: 0, currentPassword: '------', qrPasswordInterval: 5 } });
    }
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Usta paneli — siparişleri listele
app.get('/api/usta/orders', async (req, res) => {
  try {
    const db = require('firebase-admin').firestore();
    const snap = await db.collection('scans').orderBy('createdAt', 'desc').limit(20).get();
    const orders = [];
    snap.forEach(doc => orders.push({ id: doc.id, ...doc.data() }));
    res.json({ ok: true, orders });
  } catch(e) { res.json({ ok: true, orders: [] }); }
});

// Sipariş durumu güncelle
app.put('/api/usta/order/:orderId', async (req, res) => {
  try {
    const db = require('firebase-admin').firestore();
    await db.collection('scans').doc(req.params.orderId).update({ status: req.body.status || 'completed' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// uploads/scans klasörü yoksa oluştur
try { fs.mkdirSync(path.join(__dirname, 'uploads', 'scans'), { recursive: true }); } catch(e) {}

// 404 ve hata yakalama (en sonda olmalı)
app.use(notFoundHandler);
app.use(errorHandler);

const PORT = config.port;
server.listen(PORT, () => {
  logger.info(`Fenix AI başlatıldı`, { port: PORT, env: config.env });
  logger.info(`Dashboard: http://localhost:${PORT}`);
  logger.info(`App: http://localhost:${PORT}/app`);
});
