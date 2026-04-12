/**
 * Fenix AI — Reels Pipeline API
 * Fotoğraf → Arka Plan Silme → Sahne Üretme → Slideshow + Geçişler + Müzik → Export
 *
 * POST /api/pipeline/remove-bg      — Tek fotoğraf arka plan sil
 * POST /api/pipeline/scene-generate  — Gemini ile ürüne uygun sahne üret
 * POST /api/pipeline/reels           — FFmpeg slideshow + geçiş + müzik + LUT
 * POST /api/pipeline/auto-produce    — Hepsini zincirle (tam otonom)
 * GET  /api/pipeline/status/:jobId   — Job durumu sorgula
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const logger = require('../utils/logger');

const PIPELINE_DIR = path.join(os.tmpdir(), 'fenix-pipeline');
const MUSIC_DIR = path.join(__dirname, '..', 'public', 'music');
try { fs.mkdirSync(PIPELINE_DIR, { recursive: true }); } catch(e) {}
try { fs.mkdirSync(path.join(PIPELINE_DIR, 'scenes'), { recursive: true }); } catch(e) {}
try { fs.mkdirSync(path.join(PIPELINE_DIR, 'reels'), { recursive: true }); } catch(e) {}

// ═══════════════════════════════════════════
//  PRODUCTION GUARDS — Binlerce kullanıcı için
// ═══════════════════════════════════════════

// Concurrency limiter — aynı anda max N paralel işlem (OOM koruması)
function pLimit(concurrency) {
  let active = 0;
  const queue = [];
  function next() {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  }
  return function(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

// BG removal: max 3 paralel (her biri ~200MB RAM kullanır)
const bgLimit = pLimit(3);
// FFmpeg: max 2 paralel (CPU-yoğun)
const ffmpegLimit = pLimit(2);
// Gemini API: max 3 paralel (rate limit koruması)
const geminiLimit = pLimit(3);

// Aktif job limiti
const MAX_ACTIVE_JOBS = 20;
const MAX_JOBS_HISTORY = 200;
const JOB_TTL_MS = 2 * 60 * 60 * 1000;       // 2 saat
const FILE_TTL_MS = 2 * 60 * 60 * 1000;       // 2 saat
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;    // 5 dk'da bir temizlik

// Aktif job'lar (LRU eviction ile)
const _pipelineJobs = {};
let _activeJobCount = 0;

// Pipeline rate limiter — IP başına 5 req/dk (auto-produce ve reels için)
const pipelineRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] || 'unknown',
  handler: (_req, res) => res.status(429).json({ ok: false, error: 'Çok fazla istek — 1 dakika bekleyin' }),
  standardHeaders: true,
  legacyHeaders: false,
});

// Hafif endpoint'ler için daha yüksek limit
const lightRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.ip || req.headers['x-forwarded-for'] || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
});

// ═══════════════════════════════════════════
//  CLEANUP — Bellek sızıntısı koruması
// ═══════════════════════════════════════════

/** Job ve dosya temizliği (5 dk'da bir çalışır) */
function cleanupExpiredResources() {
  const now = Date.now();

  // 1) Eski job'ları temizle (2 saatten eski + tamamlanmış/hatalı)
  const jobIds = Object.keys(_pipelineJobs);
  let cleaned = 0;
  for (const id of jobIds) {
    const job = _pipelineJobs[id];
    const age = now - (job.created || 0);
    if (age > JOB_TTL_MS || (jobIds.length > MAX_JOBS_HISTORY && age > 10 * 60 * 1000)) {
      if (job.status === 'processing') _activeJobCount = Math.max(0, _activeJobCount - 1);
      delete _pipelineJobs[id];
      cleaned++;
    }
  }

  // 2) Eski dosya referanslarını temizle
  let filesCleaned = 0;
  if (global._pipeFiles) {
    for (const [id, file] of Object.entries(global._pipeFiles)) {
      if (now - (file.created || 0) > FILE_TTL_MS) {
        try { fs.unlinkSync(file.path); } catch(e) {}
        delete global._pipeFiles[id];
        filesCleaned++;
      }
    }
  }

  // 3) Orphan temp dosyaları temizle (pipeline dizinindeki 2 saatten eski dosyalar)
  try {
    const files = fs.readdirSync(PIPELINE_DIR);
    for (const f of files) {
      if (f === 'scenes' || f === 'reels') continue;
      const fp = path.join(PIPELINE_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > FILE_TTL_MS) {
          fs.unlinkSync(fp);
          filesCleaned++;
        }
      } catch(e) {}
    }
  } catch(e) {}

  if (cleaned > 0 || filesCleaned > 0) {
    logger.info(`Pipeline temizlik: ${cleaned} job, ${filesCleaned} dosya silindi. Aktif: ${_activeJobCount}`);
  }
}

// Periyodik temizlik başlat
const _cleanupTimer = setInterval(cleanupExpiredResources, CLEANUP_INTERVAL_MS);
if (_cleanupTimer.unref) _cleanupTimer.unref(); // Process'i canlı tutmasın

// Multer — çoklu fotoğraf yükleme (maks 20 dosya, 10MB/dosya)
const _pipeUpload = multer({
  dest: PIPELINE_DIR,
  limits: { fileSize: 10 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Sadece görsel dosyaları kabul edilir'));
  }
});

// ═══════════════════════════════════════════
//  LUT Presetleri (Kategori bazlı renk grading)
// ═══════════════════════════════════════════
const CATEGORY_LUT = {
  gida:       { vf: 'eq=contrast=1.08:saturation=1.3:brightness=0.04,colorbalance=rs=0.12:gs=0.06:bs=-0.08', label: 'Golden Hour' },
  icecek:     { vf: 'eq=contrast=1.1:saturation=1.15:brightness=0.0,colorbalance=rs=-0.04:gs=0.02:bs=0.1', label: 'Cool Teal' },
  kozmetik:   { vf: 'eq=contrast=1.05:saturation=0.9:brightness=0.05,colorbalance=rs=0.06:gs=0.0:bs=0.04', label: 'Soft Pastel' },
  giyim:      { vf: 'eq=contrast=1.12:saturation=1.05:brightness=0.0,colorbalance=rs=0.04:gs=0.02:bs=-0.03', label: 'Natural' },
  elektronik: { vf: 'eq=contrast=1.2:saturation=1.4:brightness=-0.02,colorbalance=rs=-0.05:gs=-0.02:bs=0.15', label: 'Cyberpunk' },
  spor:       { vf: 'eq=contrast=1.18:saturation=1.2:brightness=0.0,colorbalance=rs=0.06:gs=-0.03:bs=0.08:rm=0.04', label: 'Teal-Orange' },
  ev:         { vf: 'eq=contrast=1.06:saturation=1.15:brightness=0.03,colorbalance=rs=0.08:gs=0.04:bs=-0.05', label: 'Warm Natural' },
  otomotiv:   { vf: 'eq=contrast=1.25:saturation=1.1:brightness=-0.05,vignette=PI/4,colorbalance=bs=0.05:ms=0.02', label: 'Cinema Dark' },
  pet:        { vf: 'eq=contrast=1.06:saturation=1.2:brightness=0.04,colorbalance=rs=0.08:gs=0.05:bs=-0.04', label: 'Warm Soft' },
  taki:       { vf: 'eq=contrast=1.2:saturation=0.95:brightness=-0.03,vignette=PI/3,colorbalance=rs=0.1:gs=0.06:bs=-0.02', label: 'Rich Gold' },
  oyuncak:    { vf: 'eq=contrast=1.1:saturation=1.5:brightness=0.05', label: 'Vivid Pop' },
  aksesuar:   { vf: 'eq=contrast=1.1:saturation=1.05:brightness=0.02,colorbalance=rs=0.03:gs=0.01:bs=0.01', label: 'Clean Natural' },
  default:    { vf: 'eq=contrast=1.1:saturation=1.1:brightness=0.0', label: 'Standard' }
};

// Geçiş tipleri (FFmpeg xfade)
const TRANSITIONS = {
  fade:       { xfade: 'fade', duration: 0.5 },
  dissolve:   { xfade: 'dissolve', duration: 0.6 },
  wipeleft:   { xfade: 'wipeleft', duration: 0.4 },
  wiperight:  { xfade: 'wiperight', duration: 0.4 },
  wipeup:     { xfade: 'wipeup', duration: 0.4 },
  wipedown:   { xfade: 'wipedown', duration: 0.4 },
  slideleft:  { xfade: 'slideleft', duration: 0.3 },
  slideright: { xfade: 'slideright', duration: 0.3 },
  smoothleft: { xfade: 'smoothleft', duration: 0.5 },
  smoothright:{ xfade: 'smoothright', duration: 0.5 },
  circlecrop: { xfade: 'circlecrop', duration: 0.4 },
  rectcrop:   { xfade: 'rectcrop', duration: 0.4 },
  distance:   { xfade: 'distance', duration: 0.4 },
  fadeblack:  { xfade: 'fadeblack', duration: 0.5 },
  fadewhite:  { xfade: 'fadewhite', duration: 0.4 },
  radial:     { xfade: 'radial', duration: 0.5 },
  smoothup:   { xfade: 'smoothup', duration: 0.4 },
  smoothdown: { xfade: 'smoothdown', duration: 0.4 },
};

// Kategori → varsayılan geçiş sırası
const CATEGORY_TRANSITIONS = {
  gida:       ['fade', 'dissolve', 'smoothleft', 'fade'],
  icecek:     ['fadewhite', 'slideleft', 'fade', 'dissolve'],
  kozmetik:   ['fadewhite', 'smoothleft', 'fade', 'dissolve'],
  giyim:      ['slideleft', 'wipeleft', 'slideright', 'smoothleft'],
  elektronik: ['distance', 'slideleft', 'rectcrop', 'distance'],
  spor:       ['wipeleft', 'slideleft', 'distance', 'wipeup'],
  ev:         ['dissolve', 'fade', 'smoothleft', 'dissolve'],
  otomotiv:   ['wipeleft', 'distance', 'radial', 'fade'],
  pet:        ['dissolve', 'fade', 'smoothleft', 'dissolve'],
  taki:       ['fadewhite', 'fade', 'smoothleft', 'fadewhite'],
  oyuncak:    ['circlecrop', 'slideleft', 'distance', 'circlecrop'],
  aksesuar:   ['fadewhite', 'slideleft', 'smoothleft', 'fade'],
};

// SAHNE PROMPT KURALI: Sadece YÜZEY + ARKA PLAN + IŞIK.
// Kesinlikle insan, model, manken, el, ürün YOK.
const _NO_ITEMS = 'STRICT RULE: The image must contain ONLY an empty surface and background. Absolutely NO people, NO human models, NO mannequins, NO hands, NO products, NO objects, NO items. Just an empty backdrop ready for product placement.';

const SCENE_PROMPTS = {
  gida:       `Empty food photography backdrop: rustic wooden table surface, warm golden hour lighting from window, soft bokeh background, no food. ${_NO_ITEMS}`,
  icecek:     `Empty beverage photography backdrop: dark surface with subtle water droplets, cool blue rim light, dark gradient background. ${_NO_ITEMS}`,
  kozmetik:   `Empty cosmetic photography backdrop: white marble surface, soft pink fabric draped in background, gold shimmer, diffuse lighting. ${_NO_ITEMS}`,
  giyim:      `Empty product photography backdrop: clean white seamless studio paper, soft even lighting from both sides, light gray gradient, minimal. ${_NO_ITEMS}`,
  elektronik: `Empty tech photography backdrop: matte black surface, blue-purple neon ambient glow from edges, dark background. ${_NO_ITEMS}`,
  spor:       `Empty sports photography backdrop: concrete floor surface, outdoor natural bright light, blurred green trees in background. ${_NO_ITEMS}`,
  ev:         `Empty home decor photography backdrop: light wood table surface, natural window light, blurred plants in background, Scandinavian style. ${_NO_ITEMS}`,
  otomotiv:   `Empty automotive photography backdrop: dark polished floor, dramatic rim lighting from sides, dark background. ${_NO_ITEMS}`,
  pet:        `Empty pet product photography backdrop: soft green grass surface, warm natural sunlight, soft focus flowers in background. ${_NO_ITEMS}`,
  taki:       `Empty jewelry photography backdrop: black velvet surface, single spotlight from above, soft bokeh lights in dark background. ${_NO_ITEMS}`,
  oyuncak:    `Empty children product photography backdrop: bright pastel colored surface, even soft lighting, colorful blurred confetti in background. ${_NO_ITEMS}`,
  aksesuar:   `Empty accessory photography backdrop: clean white surface with subtle shadow, soft directional light, light gray gradient background. ${_NO_ITEMS}`,
};

// ═══════════════════════════════════════════
//  1) ARKA PLAN SİLME (proxy → /api/pro/remove-bg)
// ═══════════════════════════════════════════
router.post('/remove-bg', lightRateLimit, _pipeUpload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Görsel dosyası gerekli' });

    const bgRemover = require('../services/background-remover');
    const imageBuffer = fs.readFileSync(req.file.path);
    const result = await bgRemover.processProductImage(imageBuffer, {});

    try { fs.unlinkSync(req.file.path); } catch(e) {}

    if (result.success && Buffer.isBuffer(result.removed)) {
      const outId = crypto.randomBytes(4).toString('hex') + Date.now().toString(36);
      const outPath = path.join(PIPELINE_DIR, `nobg-${outId}.png`);
      fs.writeFileSync(outPath, result.removed);

      // 1 saat sonra sil
      setTimeout(() => { try { fs.unlinkSync(outPath); } catch(e) {} }, 60 * 60 * 1000);

      if (!global._pipeFiles) global._pipeFiles = {};
      global._pipeFiles[outId] = { path: outPath, created: Date.now() };

      res.json({ ok: true, fileId: outId, downloadUrl: `/api/pipeline/download/${outId}`, size: result.removed.length });
    } else {
      res.status(500).json({ ok: false, error: 'Arka plan silinemedi' });
    }
  } catch(e) {
    logger.error('pipeline/remove-bg hatası', { error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════
//  2) SAHNE ÜRETME (Gemini Imagen)
// ═══════════════════════════════════════════
router.post('/scene-generate', lightRateLimit, express.json(), async (req, res) => {
  try {
    const { category, customPrompt, width, height } = req.body;
    const cat = (category || 'default').toLowerCase();

    const prompt = customPrompt || SCENE_PROMPTS[cat] || SCENE_PROMPTS.giyim;
    const finalPrompt = `${prompt}. Vertical 9:16 aspect ratio, photorealistic, high quality. 1080x1920 vertical format, photorealistic.`;

    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_KEY) return res.status(500).json({ ok: false, error: 'Gemini API key tanımlı değil' });

    // Imagen 4.0 Fast ile sahne üret
    const geminiResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-fast-generate-001:predict?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{ prompt: finalPrompt }],
          parameters: {
            sampleCount: 1,
            aspectRatio: '9:16'
          }
        })
      }
    );

    if (!geminiResp.ok) {
      const errText = await geminiResp.text();
      logger.error('Gemini Imagen hatası', { status: geminiResp.status, body: errText });

      // Fallback: Gemini ile text-to-image prompt oluştur, sade renk arka plan üret
      const fallbackId = crypto.randomBytes(4).toString('hex') + Date.now().toString(36);
      const fallbackPath = path.join(PIPELINE_DIR, 'scenes', `scene-${fallbackId}.png`);

      // FFmpeg ile solid gradient arka plan üret (bedava fallback)
      await generateGradientBg(fallbackPath, cat);

      if (!global._pipeFiles) global._pipeFiles = {};
      global._pipeFiles[fallbackId] = { path: fallbackPath, created: Date.now() };

      return res.json({
        ok: true,
        fileId: fallbackId,
        downloadUrl: `/api/pipeline/download/${fallbackId}`,
        method: 'gradient-fallback',
        prompt: finalPrompt
      });
    }

    const data = await geminiResp.json();
    const predictions = data.predictions || [];

    if (predictions.length === 0 || !predictions[0].bytesBase64Encoded) {
      return res.status(500).json({ ok: false, error: 'Gemini görsel üretemedi' });
    }

    const imgBuffer = Buffer.from(predictions[0].bytesBase64Encoded, 'base64');
    const sceneId = crypto.randomBytes(4).toString('hex') + Date.now().toString(36);
    const scenePath = path.join(PIPELINE_DIR, 'scenes', `scene-${sceneId}.png`);
    fs.writeFileSync(scenePath, imgBuffer);

    setTimeout(() => { try { fs.unlinkSync(scenePath); } catch(e) {} }, 60 * 60 * 1000);

    if (!global._pipeFiles) global._pipeFiles = {};
    global._pipeFiles[sceneId] = { path: scenePath, created: Date.now() };

    res.json({
      ok: true,
      fileId: sceneId,
      downloadUrl: `/api/pipeline/download/${sceneId}`,
      method: 'gemini-imagen',
      prompt: finalPrompt
    });
  } catch(e) {
    logger.error('pipeline/scene-generate hatası', { error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════
//  3) REELS OLUŞTUR (FFmpeg Slideshow)
// ═══════════════════════════════════════════
router.post('/reels', pipelineRateLimit, _pipeUpload.array('photos', 20), async (req, res) => {
  const jobId = crypto.randomBytes(6).toString('hex');

  try {
    // Aktif job limiti kontrolü
    if (_activeJobCount >= MAX_ACTIVE_JOBS) {
      return res.status(503).json({ ok: false, error: `Sistem yoğun — ${MAX_ACTIVE_JOBS} aktif iş var, lütfen bekleyin` });
    }

    const files = req.files || [];
    if (files.length < 2) return res.status(400).json({ ok: false, error: 'En az 2 fotoğraf gerekli' });

    const {
      category = 'default',
      transition = 'auto',        // auto = kategori bazlı otomatik
      duration = '2.5',           // her fotoğraf kaç saniye
      musicUrl,                   // opsiyonel müzik URL
      lut = 'auto',               // auto = kategoriye göre
      addLogo = 'false',
      logoText = 'Fenix AI'
    } = req.body;

    const photoDuration = parseFloat(duration) || 2.5;
    const cat = category.toLowerCase();

    // Job başlat
    _activeJobCount++;
    _pipelineJobs[jobId] = {
      status: 'processing',
      progress: 0,
      stage: 'preparing',
      created: Date.now(),
      category: cat,
      photoCount: files.length
    };

    res.json({ ok: true, jobId, message: `${files.length} fotoğraftan reels oluşturuluyor...` });

    // Async pipeline
    buildReels(jobId, files, { cat, photoDuration, transition, musicUrl, lut, addLogo: addLogo === 'true', logoText })
      .catch(err => {
        logger.error('Reels pipeline hatası', { jobId, error: err.message });
        _pipelineJobs[jobId] = { ..._pipelineJobs[jobId], status: 'error', error: err.message };
      })
      .finally(() => { _activeJobCount = Math.max(0, _activeJobCount - 1); });

  } catch(e) {
    logger.error('pipeline/reels hatası', { error: e.message });
    if (_pipelineJobs[jobId]) _pipelineJobs[jobId] = { ..._pipelineJobs[jobId], status: 'error', error: e.message };
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════
//  4) TAM OTONOM — Auto Produce
// ═══════════════════════════════════════════
router.post('/auto-produce', pipelineRateLimit, _pipeUpload.array('photos', 20), async (req, res) => {
  const jobId = crypto.randomBytes(6).toString('hex');

  try {
    // Aktif job limiti kontrolü
    if (_activeJobCount >= MAX_ACTIVE_JOBS) {
      return res.status(503).json({ ok: false, error: `Sistem yoğun — ${MAX_ACTIVE_JOBS} aktif iş var, lütfen bekleyin` });
    }

    const files = req.files || [];
    if (files.length < 1) return res.status(400).json({ ok: false, error: 'En az 1 fotoğraf gerekli' });

    const {
      category = 'giyim',
      removeBg = 'true',
      generateScene = 'true',
      transition = 'auto',
      duration = '2.5',
      musicUrl,
      lut = 'auto',
      addLogo = 'true',
      logoText = 'Fenix AI'
    } = req.body;

    const cat = category.toLowerCase();

    _activeJobCount++;
    _pipelineJobs[jobId] = {
      status: 'processing',
      progress: 0,
      stage: 'starting',
      created: Date.now(),
      category: cat,
      photoCount: files.length,
      steps: { removeBg: removeBg === 'true', generateScene: generateScene === 'true' }
    };

    res.json({ ok: true, jobId, message: `Otonom üretim başladı: ${files.length} fotoğraf, kategori: ${cat}` });

    // Tam otonom pipeline
    autoProducePipeline(jobId, files, {
      cat,
      removeBg: removeBg === 'true',
      generateScene: generateScene === 'true',
      transition,
      duration: parseFloat(duration) || 2.5,
      musicUrl,
      lut,
      addLogo: addLogo === 'true',
      logoText
    }).catch(err => {
      logger.error('Auto-produce hatası', { jobId, error: err.message });
      _pipelineJobs[jobId] = { ..._pipelineJobs[jobId], status: 'error', error: err.message };
    }).finally(() => { _activeJobCount = Math.max(0, _activeJobCount - 1); });

  } catch(e) {
    logger.error('pipeline/auto-produce hatası', { error: e.message });
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════
//  STATUS & DOWNLOAD
// ═══════════════════════════════════════════
// Status polling — rate limit YOK (hafif endpoint, sık sorgulanır)
router.get('/status/:jobId', (req, res) => {
  const job = _pipelineJobs[req.params.jobId];
  if (!job) return res.status(404).json({ ok: false, error: 'Job bulunamadı' });
  res.json({ ok: true, ...job });
});

// Pipeline sağlık durumu
router.get('/health', (_req, res) => {
  const jobCount = Object.keys(_pipelineJobs).length;
  const fileCount = global._pipeFiles ? Object.keys(global._pipeFiles).length : 0;
  res.json({
    ok: true,
    activeJobs: _activeJobCount,
    totalJobs: jobCount,
    maxJobs: MAX_ACTIVE_JOBS,
    trackedFiles: fileCount,
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    uptime: Math.round(process.uptime())
  });
});

router.get('/download/:fileId', (req, res) => {
  const file = global._pipeFiles?.[req.params.fileId];
  if (!file || !fs.existsSync(file.path)) {
    return res.status(404).json({ ok: false, error: 'Dosya bulunamadı veya süresi doldu' });
  }
  res.sendFile(file.path);
});

// ═══════════════════════════════════════════
//  OTONOM PİPELINE FONKSİYONLARI
// ═══════════════════════════════════════════

/**
 * Tam otonom pipeline: Fotoğraflar → Gemini sahne yerleştirme → Reels
 * Gemini tek adımda: BG sil + yeni sahneye yerleştir
 */
async function autoProducePipeline(jobId, files, opts) {
  const job = _pipelineJobs[jobId];
  const processedPhotos = [];
  let finalCategory = opts.cat; // Gemini tespit ederse güncellenir

  try {
    // ADIM 1+2: Gemini ile direkt sahneye yerleştir (BG silme + sahne + composite TEK ADIM)
    if (opts.generateScene) {
      job.stage = 'detecting-category';
      job.progress = 3;

      const GEMINI_KEY = process.env.GEMINI_API_KEY;

      // Kategori otomatik tespit — ilk fotoğrafı Gemini'ye sor
      let detectedCat = opts.cat;
      if (opts.cat === 'giyim' || opts.cat === 'default' || !SCENE_PROMPTS[opts.cat]) {
        try {
          const firstImg = fs.readFileSync(files[0].path);
          const catResp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [
                  { text: `Look at this product photo. What category does this product belong to? Reply with ONLY ONE of these exact words, nothing else: gida, icecek, kozmetik, giyim, elektronik, spor, ev, otomotiv, pet, taki, oyuncak, aksesuar` },
                  { inlineData: { mimeType: files[0].mimetype || 'image/jpeg', data: firstImg.toString('base64') } }
                ]}]
              })
            }
          );
          if (catResp.ok) {
            const catData = await catResp.json();
            const catText = (catData.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().toLowerCase();
            const validCats = Object.keys(SCENE_PROMPTS);
            if (validCats.includes(catText)) {
              detectedCat = catText;
              logger.info(`[${jobId}] Kategori otomatik tespit: ${detectedCat}`);
            }
          }
        } catch(e) {
          logger.warn(`[${jobId}] Kategori tespit hatası: ${e.message}`);
        }
      }

      finalCategory = detectedCat;
      job.category = detectedCat;
      job.stage = 'generating-scene';
      job.progress = 5;
      logger.info(`[${jobId}] Gemini sahne yerleştirme başlıyor — ${files.length} fotoğraf, kategori: ${detectedCat}`);

      let done = 0;

      const scenePrompt = SCENE_PROMPTS[detectedCat] || SCENE_PROMPTS.giyim;

      const results = await Promise.all(files.map((file, i) => geminiLimit(async () => {
        const imgBuf = fs.readFileSync(file.path);
        const b64 = imgBuf.toString('base64');
        const mimeType = file.mimetype || 'image/jpeg';

        try {
          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${GEMINI_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [
                  { text: `This is a product photo. Keep the product EXACTLY as it is — do NOT modify, remove, or regenerate the product. Only change the BACKGROUND behind and around the product. Replace the background with: ${scenePrompt}. The product must be clearly visible, centered, and prominent in the final image. Output a vertical 9:16 product photography image.` },
                  { inlineData: { mimeType, data: b64 } }
                ]}],
                generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
              })
            }
          );

          if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}`);
          const data = await resp.json();
          const parts = data.candidates?.[0]?.content?.parts || [];
          const imgPart = parts.find(p => p.inlineData);

          if (imgPart) {
            const outBuf = Buffer.from(imgPart.inlineData.data, 'base64');
            const outPath = path.join(PIPELINE_DIR, `scene-${jobId}-${i}.png`);
            fs.writeFileSync(outPath, outBuf);
            done++;
            job.progress = 5 + Math.round(done / files.length * 50);
            logger.info(`[${jobId}] Gemini sahne ${done}/${files.length} hazır (${outBuf.length} bytes)`);
            return outPath;
          }
          throw new Error('Gemini görsel döndürmedi');
        } catch(e) {
          done++;
          job.progress = 5 + Math.round(done / files.length * 50);
          logger.warn(`[${jobId}] Gemini sahne hata #${i}: ${e.message}, orijinal kullanılıyor`);
          return file.path; // Fallback: orijinal fotoğraf
        }
      })));

      results.forEach(p => processedPhotos.push(p));
      logger.info(`[${jobId}] Sahne yerleştirme tamamlandı: ${processedPhotos.length}/${files.length}`);

    } else if (opts.removeBg) {
      // Sadece BG silme istendi (sahne yok)
      job.stage = 'removing-bg';
      job.progress = 5;
      logger.info(`[${jobId}] Sadece BG silme — ${files.length} fotoğraf`);

      const bgRemover = require('../services/background-remover');
      let done = 0;

      const results = await Promise.all(files.map((file, i) => bgLimit(async () => {
        const imgBuf = fs.readFileSync(file.path);
        try {
          const result = await bgRemover.processProductImage(imgBuf, {});
          done++;
          job.progress = 5 + Math.round(done / files.length * 50);
          if (result.success && Buffer.isBuffer(result.removed)) {
            const noBgPath = path.join(PIPELINE_DIR, `nobg-${jobId}-${i}.png`);
            fs.writeFileSync(noBgPath, result.removed);
            logger.info(`[${jobId}] BG silindi: ${done}/${files.length}`);
            return noBgPath;
          }
        } catch(bgErr) {
          done++;
          job.progress = 5 + Math.round(done / files.length * 50);
          logger.warn(`[${jobId}] BG hata: ${bgErr.message}`);
        }
        return file.path;
      })));

      results.forEach(p => processedPhotos.push(p));
    } else {
      files.forEach(f => processedPhotos.push(f.path));
      job.progress = 55;
    }

    // ADIM 3: Reels oluştur (FFmpeg)
    job.stage = 'building-reels';
    job.progress = 55;
    logger.info(`[${jobId}] Reels oluşturuluyor: ${processedPhotos.length} fotoğraf`);

    const reelsPath = path.join(PIPELINE_DIR, 'reels', `reels-${jobId}.mp4`);

    await buildSlideshowWithTransitions(processedPhotos, reelsPath, {
      cat: finalCategory,
      photoDuration: opts.duration,
      transition: opts.transition,
      lut: opts.lut,
      musicUrl: opts.musicUrl,
      addLogo: opts.addLogo,
      logoText: opts.logoText
    });

    job.stage = 'done';
    job.progress = 100;
    job.status = 'done';

    const fileId = crypto.randomBytes(4).toString('hex') + Date.now().toString(36);
    if (!global._pipeFiles) global._pipeFiles = {};
    global._pipeFiles[fileId] = { path: reelsPath, created: Date.now() };
    job.downloadUrl = `/api/pipeline/download/${fileId}`;
    job.fileId = fileId;

    // 2 saat sonra sil
    setTimeout(() => {
      try { fs.unlinkSync(reelsPath); } catch(e) {}
      delete global._pipeFiles[fileId];
    }, 2 * 60 * 60 * 1000);

    // Temp dosyaları temizle
    cleanupTempFiles(jobId, files);

    logger.info(`[${jobId}] Reels hazır!`, { category: opts.cat, photos: files.length });

  } catch(e) {
    job.status = 'error';
    job.error = e.message;
    cleanupTempFiles(jobId, files);
    throw e;
  }
}

/**
 * Reels oluştur (sadece slideshow — arka plan silme/sahne üretme yok)
 */
async function buildReels(jobId, files, opts) {
  const job = _pipelineJobs[jobId];
  const photos = files.map(f => f.path);

  job.stage = 'building-reels';
  job.progress = 10;

  const reelsPath = path.join(PIPELINE_DIR, 'reels', `reels-${jobId}.mp4`);

  await buildSlideshowWithTransitions(photos, reelsPath, opts);

  job.stage = 'done';
  job.progress = 100;
  job.status = 'done';

  const fileId = crypto.randomBytes(4).toString('hex') + Date.now().toString(36);
  if (!global._pipeFiles) global._pipeFiles = {};
  global._pipeFiles[fileId] = { path: reelsPath, created: Date.now() };
  job.downloadUrl = `/api/pipeline/download/${fileId}`;
  job.fileId = fileId;

  setTimeout(() => {
    try { fs.unlinkSync(reelsPath); } catch(e) {}
    delete global._pipeFiles[fileId];
  }, 2 * 60 * 60 * 1000);

  cleanupTempFiles(jobId, files);
  logger.info(`[${jobId}] Reels (slideshow) hazır`);
}

// ═══════════════════════════════════════════
//  FFmpeg SLİDESHOW + GEÇİŞLER
// ═══════════════════════════════════════════

/**
 * FFmpeg ile slideshow oluştur — xfade geçişler + LUT + müzik
 */
function buildSlideshowWithTransitions(photoPaths, outputPath, opts) {
  return new Promise(async (resolve, reject) => {
    const {
      cat = 'default',
      photoDuration = 2.5,
      transition = 'auto',
      lut = 'auto',
      musicUrl,
      addLogo = false,
      logoText = 'Fenix AI'
    } = opts;

    const n = photoPaths.length;
    if (n < 1) return reject(new Error('En az 1 fotoğraf gerekli'));

    // Tek fotoğraf — basit video yap
    if (n === 1) {
      const args = [
        '-loop', '1', '-i', photoPaths[0],
        '-c:v', 'libx264', '-t', '5', '-pix_fmt', 'yuv420p',
        '-vf', `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black`,
        '-y', outputPath
      ];
      return runFFmpeg(args).then(resolve).catch(reject);
    }

    // Geçiş seçimi
    const transitionList = getTransitionList(n, cat, transition);
    const transDuration = getTransitionDuration(cat);

    // FFmpeg karmaşık filter_complex ile xfade zinciri
    const inputs = [];
    const filterParts = [];

    // Her fotoğraf için input + scale + pad (1080x1920)
    for (let i = 0; i < n; i++) {
      inputs.push('-loop', '1', '-t', String(photoDuration + (i < n - 1 ? transDuration : 0)), '-i', photoPaths[i]);
      filterParts.push(`[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuva420p[v${i}]`);
    }

    // xfade zinciri — doğru offset hesabı
    let lastLabel = 'v0';
    let cumulativeOffset = 0;
    for (let i = 1; i < n; i++) {
      const tr = transitionList[(i - 1) % transitionList.length];
      cumulativeOffset = photoDuration * i - transDuration * (i - 1);
      // Her geçiş önceki clip'in sonuna yakın başlar
      const outLabel = i < n - 1 ? `xf${i}` : 'xfinal';
      filterParts.push(`[${lastLabel}][v${i}]xfade=transition=${tr}:duration=${transDuration}:offset=${Math.max(0.1, cumulativeOffset - transDuration).toFixed(2)}[${outLabel}]`);
      lastLabel = outLabel;
      logger.info(`[xfade] ${i}: tr=${tr}, offset=${(cumulativeOffset - transDuration).toFixed(2)}`);
    }

    // LUT (renk grading)
    const lutPreset = lut === 'auto' ? (CATEGORY_LUT[cat] || CATEGORY_LUT.default) : (CATEGORY_LUT[lut] || CATEGORY_LUT.default);
    let finalLabel = lastLabel;

    filterParts.push(`[${finalLabel}]${lutPreset.vf},format=yuv420p[colored]`);
    finalLabel = 'colored';

    // Logo overlay (opsiyonel)
    if (addLogo && logoText) {
      filterParts.push(`[${finalLabel}]drawtext=text='${logoText}':fontsize=28:fontcolor=white@0.7:x=(w-text_w)/2:y=h-60:shadowcolor=black@0.5:shadowx=1:shadowy=1[final]`);
      finalLabel = 'final';
    }

    const ffArgs = [
      ...inputs,
      '-filter_complex', filterParts.join(';'),
      '-map', `[${finalLabel}]`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '20',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y', outputPath
    ];

    // Müzik ekleme
    const musicPath = musicUrl && fs.existsSync(musicUrl) ? musicUrl : null;
    if (musicPath) {
      ffArgs.splice(ffArgs.indexOf('-filter_complex'), 0, '-i', musicPath);
      const mapIdx = ffArgs.indexOf('-map');
      ffArgs.splice(mapIdx + 2, 0, '-map', `${n}:a`, '-c:a', 'aac', '-shortest');
    } else {
      // Müzik yoksa FFmpeg ile ambient ton üret (sine wave + fade)
      const totalDur = (n * photoDuration) - ((n - 1) * transDuration);
      const ambientFilter = `sine=frequency=220:duration=${totalDur.toFixed(1)},volume=0.05,afade=t=in:d=1,afade=t=out:st=${(totalDur - 1.5).toFixed(1)}:d=1.5`;
      ffArgs.splice(ffArgs.indexOf('-filter_complex'), 0, '-f', 'lavfi', '-i', ambientFilter);
      const mapIdx = ffArgs.indexOf('-map');
      ffArgs.splice(mapIdx + 2, 0, '-map', `${n}:a`, '-c:a', 'aac', '-shortest');
    }

    try {
      await runFFmpeg(ffArgs);
      resolve();
    } catch(e) {
      // Fallback: xfade olmadan basit concat
      logger.warn('xfade başarısız, basit concat deneniyor', { error: e.message });
      await buildSimpleConcat(photoPaths, outputPath, opts);
      resolve();
    }
  });
}

/**
 * Basit concat fallback (xfade desteklemezse)
 */
async function buildSimpleConcat(photoPaths, outputPath, opts) {
  const listPath = path.join(PIPELINE_DIR, `concat-${Date.now()}.txt`);
  const dur = opts.photoDuration || 2.5;
  const lines = photoPaths.map(p => `file '${p.replace(/\\/g, '/')}'\nduration ${dur}`);
  lines.push(`file '${photoPaths[photoPaths.length - 1].replace(/\\/g, '/')}'`);
  fs.writeFileSync(listPath, lines.join('\n'));

  const lutVf = (CATEGORY_LUT[opts.cat] || CATEGORY_LUT.default).vf;

  await runFFmpeg([
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-vf', `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,${lutVf}`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-y', outputPath
  ]);

  try { fs.unlinkSync(listPath); } catch(e) {}
}

// ═══════════════════════════════════════════
//  YARDIMCI FONKSİYONLAR
// ═══════════════════════════════════════════

/** Gemini Imagen ile sahne görseli üret */
async function generateSceneImage(outputPath, category) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    await generateGradientBg(outputPath, category);
    return true;
  }

  const prompt = SCENE_PROMPTS[category] || SCENE_PROMPTS.giyim;
  const finalPrompt = `${prompt}. Vertical 9:16 aspect ratio, photorealistic, high quality. 1080x1920 vertical, photorealistic.`;

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-fast-generate-001:predict?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{ prompt: finalPrompt }],
          parameters: { sampleCount: 1, aspectRatio: '9:16' }
        })
      }
    );

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`Imagen HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
    }
    const data = await resp.json();
    const b64 = data.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) throw new Error('Imagen boş döndü');

    const imgBuf = Buffer.from(b64, 'base64');
    fs.writeFileSync(outputPath, imgBuf);
    logger.info(`Imagen 4.0 sahne üretildi: ${category}, ${imgBuf.length} bytes`);
    return true;
  } catch(e) {
    logger.warn('Imagen 4.0 başarısız, gradient fallback', { error: e.message });
    await generateGradientBg(outputPath, category);
    return true;
  }
}

/** FFmpeg ile gradient arka plan üret (bedava fallback) */
function generateGradientBg(outputPath, category) {
  const gradients = {
    gida:       { c1: '#2D1810', c2: '#8B6914' },
    icecek:     { c1: '#0A1628', c2: '#1A3A5C' },
    kozmetik:   { c1: '#F5E6F0', c2: '#FFFFFF' },
    giyim:      { c1: '#F0F0F0', c2: '#FFFFFF' },
    elektronik: { c1: '#0A0A1A', c2: '#1A0A2E' },
    spor:       { c1: '#1A2E1A', c2: '#3D5C3D' },
    ev:         { c1: '#F5E6D3', c2: '#FFFFFF' },
    otomotiv:   { c1: '#0A0A0A', c2: '#1A1A2E' },
    pet:        { c1: '#E8F5E9', c2: '#FFFFFF' },
    taki:       { c1: '#0A0A0A', c2: '#1A1A1A' },
    oyuncak:    { c1: '#FFE0B2', c2: '#F8BBD0' },
    default:    { c1: '#1A1A2E', c2: '#16213E' }
  };

  const g = gradients[category] || gradients.default;

  return runFFmpeg([
    '-f', 'lavfi', '-i',
    `color=c=${g.c1}:s=1080x1920:d=1,format=rgb24[a];color=c=${g.c2}:s=1080x1920:d=1,format=rgb24[b];[a][b]blend=all_expr='A*(1-Y/H)+B*(Y/H)'`,
    '-frames:v', '1',
    '-y', outputPath
  ]);
}

/** Ürün fotoğrafını sahne üzerine composite et (FFmpeg overlay + gölge) */
function compositeOnScene(productPath, scenePath, outputPath) {
  // Ürünü sahnenin ortasına yerleştir (max 650px genişlik, max 900px yükseklik)
  // Gölge efekti ile profesyonel görünüm
  return runFFmpeg([
    '-i', scenePath,
    '-i', productPath,
    '-filter_complex',
    `[1:v]scale='min(650,iw)':'min(900,ih)':force_original_aspect_ratio=decrease:flags=lanczos[scaled];` +
    `[scaled]split[shadow_src][prod];` +
    `[shadow_src]colorchannelmixer=aa=0.25,boxblur=10:10[shadow];` +
    `[0:v][shadow]overlay=(W-w)/2:((H-h)/2+12):format=auto[with_shadow];` +
    `[with_shadow][prod]overlay=(W-w)/2:(H-h)/2:format=auto`,
    '-frames:v', '1',
    '-q:v', '2',
    '-y', outputPath
  ]);
}

/** Geçiş listesini belirle */
function getTransitionList(photoCount, category, transition) {
  if (transition !== 'auto' && TRANSITIONS[transition]) {
    return [transition];
  }
  return CATEGORY_TRANSITIONS[category] || CATEGORY_TRANSITIONS.giyim || ['fade'];
}

/** Kategori bazlı geçiş süresi */
function getTransitionDuration(category) {
  const slow = ['gida', 'kozmetik', 'ev', 'pet', 'taki'];
  const fast = ['spor', 'elektronik', 'otomotiv'];
  if (slow.includes(category)) return 0.6;
  if (fast.includes(category)) return 0.25;
  return 0.4;
}

/** FFmpeg çalıştır (120sn timeout) */
function runFFmpeg(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    logger.info('FFmpeg çalıştırılıyor', { args: args.slice(0, 6).join(' ') + '...' });
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
      logger.error('FFmpeg TIMEOUT — 120sn aşıldı, process öldürüldü');
      reject(new Error('FFmpeg timeout: 120 saniye aşıldı'));
    }, timeoutMs);

    proc.stderr.on('data', d => {
      stderr += d.toString();
      // stderr buffer'ı sınırla (bellek koruması)
      if (stderr.length > 10000) stderr = stderr.slice(-5000);
    });
    proc.on('close', code => {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0) resolve();
      else {
        logger.error('FFmpeg hatası', { code, stderr: stderr.slice(-500) });
        reject(new Error(`FFmpeg çıkış kodu: ${code} — ${stderr.slice(-200)}`));
      }
    });
    proc.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`FFmpeg başlatılamadı: ${err.message}`));
    });
  });
}

/** Temp dosyaları temizle */
function cleanupTempFiles(jobId, files) {
  setTimeout(() => {
    // Orijinal upload'ları sil
    (files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch(e) {} });
    // nobg ve comp dosyalarını sil
    for (let i = 0; i < 20; i++) {
      try { fs.unlinkSync(path.join(PIPELINE_DIR, `nobg-${jobId}-${i}.png`)); } catch(e) {}
      try { fs.unlinkSync(path.join(PIPELINE_DIR, `comp-${jobId}-${i}.png`)); } catch(e) {}
    }
  }, 5000);
}

module.exports = router;
