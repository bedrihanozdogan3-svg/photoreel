/**
 * Fenix AI — PRO Studio API
 * FFmpeg ile video post-processing: LUT, renk, ses, branding, kamera
 * POST /api/pro/process  — anlık işleme (URL kaynaklı)
 * POST /api/pro/upload   — video dosyası yükle
 * POST /api/pro/render   — 4K timeline render (async, job tabanlı)
 * GET  /api/pro/render-progress/:jobId — ilerleme sorgula
 */

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const logger = require('../utils/logger');

const TEMP_DIR = path.join(os.tmpdir(), 'fenix-pro');
try { fs.mkdirSync(TEMP_DIR, { recursive: true }); } catch(e) {}

// Multer — video yükleme (maks 2GB)
const _upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('video/') || file.mimetype === 'application/octet-stream')
      cb(null, true);
    else
      cb(new Error('Sadece video dosyaları kabul edilir'));
  }
});

// Aktif render job'larını takip et
const _renderJobs = {};

// ── LUT Presetleri (FFmpeg eq + colorbalance) ──
const LUT_PRESETS = {
  cinematic: {
    label: 'Sinematik',
    vf: 'eq=contrast=1.15:saturation=1.1:brightness=-0.03,vignette=PI/4,colorbalance=bs=0.05:ms=0.02:hs=-0.02'
  },
  golden: {
    label: 'Altın Saat',
    vf: 'eq=contrast=1.08:saturation=1.3:brightness=0.04,colorbalance=rs=0.12:gs=0.06:bs=-0.08:rm=0.06:gm=0.03:bm=-0.04'
  },
  moody: {
    label: 'Karanlık',
    vf: 'eq=contrast=1.25:saturation=0.7:brightness=-0.08,vignette=PI/3,colorbalance=bs=0.1:ms=0.06:hs=0.04'
  },
  vintage: {
    label: 'Vintage',
    vf: 'eq=contrast=1.1:saturation=0.6:brightness=0.02,colorbalance=rs=0.08:gs=0.04:bs=-0.06,noise=c0s=12:allf=t'
  },
  neon: {
    label: 'Neon',
    vf: 'eq=contrast=1.3:saturation=1.8:brightness=0.02,colorbalance=bs=0.15:ms=-0.05:rs=-0.05'
  },
  bw: {
    label: 'Siyah Beyaz',
    vf: 'eq=contrast=1.2:brightness=-0.02,hue=s=0,vignette=PI/4'
  }
};

// ── Kamera Hareketi Presetleri ──
const CAMERA_PRESETS = {
  zoom_in: {
    label: 'Zoom In',
    // Yavaş zoom in: 1.0x → 1.2x
    vf: "scale=iw*1.2:ih*1.2,zoompan=z='min(zoom+0.002,1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=150:s=1080x1920:fps=30"
  },
  zoom_out: {
    label: 'Zoom Out',
    vf: "scale=iw*1.3:ih*1.3,zoompan=z='if(eq(on,1),1.3,max(zoom-0.002,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=150:s=1080x1920:fps=30"
  },
  pan_left: {
    label: 'Sola Pan',
    vf: "scale=iw*1.15:ih*1.15,crop=iw/1.15:ih/1.15:'(iw-out_w)*(1-t/5)':'(ih-out_h)/2'"
  },
  pan_right: {
    label: 'Sağa Pan',
    vf: "scale=iw*1.15:ih*1.15,crop=iw/1.15:ih/1.15:'(iw-out_w)*(t/5)':'(ih-out_h)/2'"
  }
};

/**
 * Video URL'den dosyaya indir
 */
function downloadVideo(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return downloadVideo(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`İndirme hatası: HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
    }).on('error', (err) => {
      file.close();
      try { fs.unlinkSync(dest); } catch(e) {}
      reject(err);
    });
  });
}

/**
 * FFmpeg komutunu çalıştır
 */
function runFFmpeg(cmd, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, shell: false }, (err, stdout, stderr) => {
      if (err) {
        logger.error('FFmpeg hatası', { cmd: cmd.slice(0, 200), error: err.message });
        return reject(new Error('FFmpeg işlem hatası'));
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Temp dosyaları temizle
 */
function cleanupFiles(...files) {
  files.forEach(f => {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch(e) {}
  });
}

/**
 * FFmpeg filtre zinciri oluştur
 */
function buildFilterChain(params) {
  const filters = [];

  // 1. Kamera hareketi
  if (params.camera && CAMERA_PRESETS[params.camera]) {
    filters.push(CAMERA_PRESETS[params.camera].vf);
  }

  // 2. LUT preset
  if (params.lut && LUT_PRESETS[params.lut]) {
    filters.push(LUT_PRESETS[params.lut].vf);
  }

  // 3. Renk ayarları (kullanıcı slider'ları)
  if (params.color) {
    const c = params.color;
    const eqParts = [];
    if (c.brightness !== undefined && c.brightness !== 0) eqParts.push(`brightness=${(c.brightness / 100).toFixed(2)}`);
    if (c.contrast !== undefined && c.contrast !== 0) eqParts.push(`contrast=${(1 + c.contrast / 100).toFixed(2)}`);
    if (c.saturation !== undefined && c.saturation !== 0) eqParts.push(`saturation=${(1 + c.saturation / 100).toFixed(2)}`);
    if (eqParts.length > 0) filters.push(`eq=${eqParts.join(':')}`);

    // Sıcaklık → colorbalance
    if (c.temperature && c.temperature !== 0) {
      const t = c.temperature / 100;
      if (t > 0) filters.push(`colorbalance=rs=${(t * 0.15).toFixed(2)}:gs=${(t * 0.05).toFixed(2)}:bs=${(-t * 0.1).toFixed(2)}`);
      else filters.push(`colorbalance=rs=${(t * 0.1).toFixed(2)}:gs=${(t * 0.02).toFixed(2)}:bs=${(-t * 0.15).toFixed(2)}`);
    }

    // Keskinlik
    if (c.sharpness && c.sharpness > 0) {
      const s = Math.min(c.sharpness / 50, 2);
      filters.push(`unsharp=5:5:${s.toFixed(1)}:5:5:0`);
    }
  }

  // 4. Hız
  if (params.speed && params.speed !== 1) {
    const spd = Math.max(0.25, Math.min(4, params.speed));
    filters.push(`setpts=${(1 / spd).toFixed(3)}*PTS`);
  }

  return filters;
}

/**
 * Ses filtre zinciri
 */
function buildAudioFilters(audio) {
  if (!audio) return [];
  const af = [];

  // Ses seviyesi
  if (audio.volume !== undefined && audio.volume !== 100) {
    af.push(`volume=${(audio.volume / 100).toFixed(2)}`);
  }

  // Fade giriş
  if (audio.fadeIn && audio.fadeIn > 0) {
    af.push(`afade=t=in:d=${audio.fadeIn}`);
  }

  // Fade çıkış (duration bilgisi lazım, sonra eklenecek)
  if (audio.fadeOut && audio.fadeOut > 0) {
    af.push(`areverse,afade=t=in:d=${audio.fadeOut},areverse`);
  }

  // Bas boost
  if (audio.bass && audio.bass > 0) {
    af.push(`bass=g=${Math.min(audio.bass, 20)}`);
  }

  // Echo
  if (audio.echo) {
    af.push('aecho=0.8:0.7:60:0.3');
  }

  // Reverb
  if (audio.reverb) {
    af.push('aecho=0.8:0.88:40|80:0.4|0.25');
  }

  // Gürültü azaltma
  if (audio.noiseReduce) {
    af.push('highpass=f=100,lowpass=f=8000');
  }

  // Hız değişikliği varsa ses de senkron olmalı
  if (audio._speed && audio._speed !== 1) {
    af.push(`atempo=${Math.max(0.5, Math.min(2, audio._speed))}`);
  }

  return af;
}

/**
 * POST /api/pro/process
 * Video post-processing pipeline
 *
 * Body: {
 *   videoUrl: string,       // kaynak video
 *   customerId: string,
 *   lut?: string,           // cinematic | golden | moody | vintage | neon | bw
 *   color?: { brightness, contrast, saturation, temperature, sharpness },
 *   audio?: { volume, fadeIn, fadeOut, echo, reverb, bass, noiseReduce },
 *   branding?: { logoBase64, slogan, position },
 *   camera?: string,        // zoom_in | zoom_out | pan_left | pan_right
 *   speed?: number           // 0.25 - 4.0
 * }
 */
router.post('/process', async (req, res) => {
  const { videoUrl, customerId, lut, color, audio, branding, camera, speed } = req.body || {};

  if (!videoUrl) return res.status(400).json({ ok: false, error: 'Video URL gerekli.' });
  if (!customerId) return res.status(400).json({ ok: false, error: 'Müşteri kimliği gerekli.' });

  // Validasyon
  if (lut && !LUT_PRESETS[lut]) return res.status(400).json({ ok: false, error: 'Geçersiz LUT: ' + lut });
  if (camera && !CAMERA_PRESETS[camera]) return res.status(400).json({ ok: false, error: 'Geçersiz kamera: ' + camera });

  const jobId = `pro_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const inputPath = path.join(TEMP_DIR, `${jobId}_input.mp4`);
  const outputPath = path.join(TEMP_DIR, `${jobId}_output.mp4`);
  let logoPath = null;

  try {
    logger.info('PRO process başladı', { jobId, customerId, lut, camera, speed });

    // 1. Video indir
    await downloadVideo(videoUrl, inputPath);
    if (!fs.existsSync(inputPath) || fs.statSync(inputPath).size < 1000) {
      throw new Error('Video indirilemedi veya çok küçük');
    }

    // 2. Logo varsa kaydet
    if (branding?.logoBase64) {
      logoPath = path.join(TEMP_DIR, `${jobId}_logo.png`);
      const base64Data = branding.logoBase64.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(logoPath, Buffer.from(base64Data, 'base64'));
    }

    // 3. Video filtreleri oluştur
    const videoFilters = buildFilterChain({ lut, color, camera, speed });

    // 4. Ses filtreleri
    const audioParams = audio ? { ...audio } : {};
    if (speed && speed !== 1) audioParams._speed = speed;
    const audioFilters = buildAudioFilters(audioParams);

    // 5. FFmpeg komutu oluştur
    const cmdParts = ['ffmpeg', '-y', '-i', `"${inputPath}"`];

    // Logo overlay
    if (logoPath && fs.existsSync(logoPath)) {
      cmdParts.push('-i', `"${logoPath}"`);
    }

    // Video filtreleri
    let vfChain = videoFilters.length > 0 ? videoFilters.join(',') : null;

    // Branding overlay + drawtext
    if (logoPath && fs.existsSync(logoPath)) {
      const pos = branding?.position || 'sol-alt';
      let overlayPos;
      switch (pos) {
        case 'sol-ust': overlayPos = 'x=20:y=20'; break;
        case 'sag-ust': overlayPos = 'x=W-w-20:y=20'; break;
        case 'sag-alt': overlayPos = 'x=W-w-20:y=H-h-20'; break;
        case 'merkez': overlayPos = 'x=(W-w)/2:y=(H-h)/2'; break;
        default: overlayPos = 'x=20:y=H-h-20'; // sol-alt
      }
      // Logo küçült + overlay
      const logoFilter = `[1:v]scale=120:-1[logo];[0:v]${vfChain ? vfChain + '[vtmp];[vtmp]' : ''}[logo]overlay=${overlayPos}`;
      vfChain = logoFilter;

      // Slogan yazı
      if (branding?.slogan) {
        const safeSlogan = branding.slogan.replace(/['"\\:]/g, '');
        vfChain += `,drawtext=text='${safeSlogan}':fontsize=28:fontcolor=white:borderw=2:bordercolor=black:x=20:y=H-30`;
      }
    } else if (branding?.slogan) {
      // Sadece slogan (logo yok)
      const safeSlogan = branding.slogan.replace(/['"\\:]/g, '');
      const sloganFilter = `drawtext=text='${safeSlogan}':fontsize=28:fontcolor=white:borderw=2:bordercolor=black:x=20:y=H-30`;
      vfChain = vfChain ? `${vfChain},${sloganFilter}` : sloganFilter;
    }

    if (vfChain) cmdParts.push('-vf', `"${vfChain}"`);

    // Audio filtreleri
    if (audioFilters.length > 0) {
      cmdParts.push('-af', `"${audioFilters.join(',')}"`);
    }

    // Çıktı ayarları
    cmdParts.push(
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      `"${outputPath}"`
    );

    const fullCmd = cmdParts.join(' ');
    logger.info('FFmpeg komutu', { jobId, cmd: fullCmd.slice(0, 300) });

    // 6. FFmpeg çalıştır
    await new Promise((resolve, reject) => {
      exec(fullCmd, { timeout: 180000 }, (err, stdout, stderr) => {
        if (err) {
          logger.error('FFmpeg hatası', { jobId, stderr: (stderr || '').slice(0, 500) });
          return reject(new Error('Video işleme hatası'));
        }
        resolve();
      });
    });

    // 7. Çıktı kontrolü
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
      throw new Error('İşlenmiş video oluşturulamadı');
    }

    // 8. Base64 olarak döndür (küçük videolar için) veya dosya serve et
    const outputSize = fs.statSync(outputPath).size;
    logger.info('PRO process tamamlandı', { jobId, outputSize });

    // Dosyayı serve et
    const fileId = jobId;
    // Global store for processed videos (cleaned up after 10 min)
    if (!global._proFiles) global._proFiles = {};
    global._proFiles[fileId] = { path: outputPath, createdAt: Date.now() };

    // 10dk sonra temizle
    setTimeout(() => {
      cleanupFiles(inputPath, outputPath, logoPath);
      if (global._proFiles) delete global._proFiles[fileId];
    }, 600000);

    return res.json({
      ok: true,
      fileId,
      downloadUrl: `/api/pro/download/${fileId}`,
      size: outputSize,
      settings: { lut, camera, speed, hasColor: !!color, hasAudio: !!audio, hasBranding: !!branding }
    });

  } catch (err) {
    logger.error('PRO process hatası', { jobId, error: err.message });
    cleanupFiles(inputPath, outputPath, logoPath);
    return res.status(500).json({ ok: false, error: err.message || 'Video işleme hatası' });
  }
});

/**
 * GET /api/pro/download/:fileId
 * İşlenmiş videoyu indir
 */
router.get('/download/:fileId', (req, res) => {
  const { fileId } = req.params;
  if (!fileId || !/^pro_\d+_[a-z0-9]+$/.test(fileId)) {
    return res.status(400).json({ ok: false, error: 'Geçersiz dosya ID' });
  }

  const fileInfo = global._proFiles?.[fileId];
  if (!fileInfo || !fs.existsSync(fileInfo.path)) {
    return res.status(404).json({ ok: false, error: 'Dosya bulunamadı veya süresi dolmuş' });
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="fenix-pro-${fileId}.mp4"`);
  fs.createReadStream(fileInfo.path).pipe(res);
});

/**
 * GET /api/pro/presets
 * Kullanılabilir LUT ve kamera presetlerini listele
 */
router.get('/presets', (req, res) => {
  res.json({
    ok: true,
    luts: Object.entries(LUT_PRESETS).map(([id, p]) => ({ id, label: p.label })),
    cameras: Object.entries(CAMERA_PRESETS).map(([id, p]) => ({ id, label: p.label }))
  });
});

/**
 * GET /api/pro/status
 */
router.get('/status', async (req, res) => {
  try {
    const check = await new Promise((resolve) => {
      exec('ffmpeg -version', { timeout: 5000 }, (err, stdout) => {
        resolve(err ? false : true);
      });
    });
    res.json({ ok: true, ffmpeg: check, presets: Object.keys(LUT_PRESETS).length, cameras: Object.keys(CAMERA_PRESETS).length });
  } catch(e) {
    res.json({ ok: false, ffmpeg: false });
  }
});

// ════════════════════════════════════════════════════════════
//  UPLOAD — Video dosyası yükle, temp fileId döndür
//  POST /api/pro/upload
// ════════════════════════════════════════════════════════════
router.post('/upload', _upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Video dosyası gerekli' });

  const ext    = path.extname(req.file.originalname || '.mp4').toLowerCase() || '.mp4';
  const fileId = 'upload_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const dest   = path.join(TEMP_DIR, fileId + ext);

  try {
    fs.renameSync(req.file.path, dest);
  } catch(e) {
    fs.copyFileSync(req.file.path, dest);
    fs.unlinkSync(req.file.path);
  }

  if (!global._proFiles) global._proFiles = {};
  global._proFiles[fileId] = { path: dest, createdAt: Date.now(), type: 'upload' };

  // 30 dk sonra temizle
  setTimeout(() => {
    cleanupFiles(dest);
    if (global._proFiles) delete global._proFiles[fileId];
  }, 30 * 60 * 1000);

  logger.info('Video yüklendi', { fileId, size: req.file.size });
  res.json({ ok: true, fileId, size: req.file.size });
});


// ════════════════════════════════════════════════════════════
//  PARALLEL RENDER QUEUE — Sunucu yükünü sınırla
// ════════════════════════════════════════════════════════════
const MAX_CONCURRENT_RENDERS = 4;
let _activeRenderCount = 0;
const _renderQueue = [];

function _acquireRenderSlot() {
  return new Promise(resolve => {
    if (_activeRenderCount < MAX_CONCURRENT_RENDERS) { _activeRenderCount++; resolve(); }
    else _renderQueue.push(resolve);
  });
}
function _releaseRenderSlot() {
  _activeRenderCount = Math.max(0, _activeRenderCount - 1);
  if (_renderQueue.length > 0) { _activeRenderCount++; _renderQueue.shift()(); }
}

// Valid xfade transitions
const XFADE_TRANSITIONS = new Set([
  'fade','wipeleft','wiperight','wipeup','wipedown','slideleft','slideright',
  'slideup','slidedown','circlecrop','rectcrop','distance','fadeblack','fadewhite',
  'radial','smoothleft','smoothright','smoothup','smoothdown','circleopen',
  'circleclose','dissolve','pixelize','diagtl','diagtr','diagbl','diagbr'
]);

// ════════════════════════════════════════════════════════════
//  RENDER — 4K timeline segmentli async render
//  POST /api/pro/render
//  Body: { sourceFileId|videoUrl, segments, resolution,
//          lut, color, audio, branding, speed }
// ════════════════════════════════════════════════════════════

/**
 * Video efektlerini FFmpeg filter string'ine çevir (vf için inline kullanım)
 */
function buildVideoEffectString(params) {
  const parts = [];
  if (params.lut && LUT_PRESETS[params.lut]) parts.push(LUT_PRESETS[params.lut].vf);
  if (params.color) {
    const c = params.color;
    const eq = [];
    if (c.brightness) eq.push(`brightness=${(c.brightness / 100).toFixed(2)}`);
    if (c.contrast)   eq.push(`contrast=${(1 + c.contrast / 100).toFixed(2)}`);
    if (c.saturation) eq.push(`saturation=${(1 + c.saturation / 100).toFixed(2)}`);
    if (eq.length)    parts.push('eq=' + eq.join(':'));
    if (c.temperature) {
      const t = c.temperature / 100;
      parts.push(t > 0
        ? `colorbalance=rs=${(t * 0.15).toFixed(2)}:gs=${(t * 0.05).toFixed(2)}:bs=${(-t * 0.1).toFixed(2)}`
        : `colorbalance=rs=${(t * 0.1).toFixed(2)}:gs=${(t * 0.02).toFixed(2)}:bs=${(-t * 0.15).toFixed(2)}`);
    }
    if (c.sharpness > 0) {
      const s = Math.min(c.sharpness / 50, 2);
      parts.push(`unsharp=5:5:${s.toFixed(1)}:5:5:0`);
    }
  }
  if (params.camera && CAMERA_PRESETS[params.camera]) parts.push(CAMERA_PRESETS[params.camera].vf);
  if (params.speed && params.speed !== 1) {
    parts.push(`setpts=${(1 / Math.max(0.25, Math.min(4, params.speed))).toFixed(3)}*PTS`);
  }
  return parts.join(',');
}

function getOverlayCoords(pos) {
  switch (pos) {
    case 'sol-ust': return 'x=20:y=20';
    case 'sag-ust': return 'x=W-w-20:y=20';
    case 'sag-alt': return 'x=W-w-20:y=H-h-20';
    case 'merkez':  return 'x=(W-w)/2:y=(H-h)/2';
    default:        return 'x=20:y=H-h-20'; // sol-alt
  }
}

router.post('/render', async (req, res) => {
  const {
    sourceFileId, videoUrl, segments, resolution = '1080',
    lut, color, audio, branding, speed, crop, customerId = 'anon'
  } = req.body || {};

  if (!sourceFileId && !videoUrl)
    return res.status(400).json({ ok: false, error: 'sourceFileId veya videoUrl gerekli' });

  if (!['720', '1080', '4k'].includes(resolution))
    return res.status(400).json({ ok: false, error: 'Geçersiz çözünürlük. 720|1080|4k' });

  const jobId     = `render_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const inputPath = path.join(TEMP_DIR, `${jobId}_in.mp4`);
  const outputPath= path.join(TEMP_DIR, `${jobId}_out.mp4`);
  let logoPath    = null;
  let filterFile  = null;

  // Job kaydı — response hemen dön, işlem arka planda sürsün
  _renderJobs[jobId] = { status: 'queued', progress: 0, startedAt: Date.now() };
  res.json({ ok: true, jobId, pollUrl: `/api/pro/render-progress/${jobId}` });

  // ── Async işlem ──
  (async () => {
    try {
      // 1. Video kaynağını al
      _renderJobs[jobId] = { ..._renderJobs[jobId], status: 'downloading', progress: 5 };
      if (sourceFileId && global._proFiles?.[sourceFileId]) {
        const src = global._proFiles[sourceFileId].path;
        fs.copyFileSync(src, inputPath);
      } else {
        await downloadVideo(videoUrl, inputPath);
      }
      if (!fs.existsSync(inputPath) || fs.statSync(inputPath).size < 1000)
        throw new Error('Video kaynağı alınamadı');

      // 2. Logo varsa kaydet
      if (branding?.logoBase64) {
        logoPath = path.join(TEMP_DIR, `${jobId}_logo.png`);
        fs.writeFileSync(logoPath, Buffer.from(
          branding.logoBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64'
        ));
      }

      // 3. Çözünürlük
      const scaleW = resolution === '4k' ? 3840 : resolution === '1080' ? 1920 : 1280;
      const scaleH = resolution === '4k' ? 2160 : resolution === '1080' ? 1080 : 720;
      const scaleAlgo = resolution === '4k' ? 'lanczos' : 'bicubic';

      // 4. FFmpeg filter_complex dosyası (shell kaçış sorunlarından kaçınmak için)
      const segs = Array.isArray(segments) && segments.length > 0
        ? segments.filter(s => typeof s.start === 'number' && typeof s.end === 'number' && s.end > s.start)
        : null;

      const effectStr = buildVideoEffectString({ lut, color, speed });
      const filterLines = [];
      let finalVStream = '0:v';
      let finalAStream = '0:a';

      if (segs && segs.length > 1) {
        // Birden fazla segment: trim + concat
        segs.forEach((seg, i) => {
          filterLines.push(
            `[0:v]trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS[vseg${i}]`
          );
          filterLines.push(
            `[0:a]atrim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},asetpts=PTS-STARTPTS[aseg${i}]`
          );
        });
        const vConcat = segs.map((_, i) => `[vseg${i}]`).join('');
        const aConcat = segs.map((_, i) => `[aseg${i}]`).join('');
        filterLines.push(`${vConcat}${aConcat}concat=n=${segs.length}:v=1:a=1[vcat][acat]`);
        finalVStream = 'vcat';
        finalAStream = 'acat';
      } else if (segs && segs.length === 1) {
        // Tek segment trim
        const s = segs[0];
        filterLines.push(`[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS[vtrim]`);
        filterLines.push(`[0:a]atrim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},asetpts=PTS-STARTPTS[atrim]`);
        finalVStream = 'vtrim';
        finalAStream = 'atrim';
      }

      // Crop (before scale so coordinates are in source resolution)
      if (crop && typeof crop.x === 'number' && crop.w > 4 && crop.h > 4) {
        const cx = Math.max(0, Math.round(crop.x));
        const cy = Math.max(0, Math.round(crop.y));
        const cw = Math.round(crop.w);
        const ch = Math.round(crop.h);
        filterLines.push(`[${finalVStream}]crop=${cw}:${ch}:${cx}:${cy}[vcrop]`);
        finalVStream = 'vcrop';
      }

      // Scale
      filterLines.push(`[${finalVStream}]scale=${scaleW}:${scaleH}:flags=${scaleAlgo}[vscaled]`);
      finalVStream = 'vscaled';

      // Efektler
      if (effectStr) {
        filterLines.push(`[vscaled]${effectStr}[vfx]`);
        finalVStream = 'vfx';
      }

      // Logo overlay
      const logoInput = logoPath ? 1 : -1;
      if (logoPath) {
        const overlayCoords = getOverlayCoords(branding?.position);
        filterLines.push(`[${logoInput}:v]scale=120:-1[logo]`);
        filterLines.push(`[${finalVStream}][logo]overlay=${overlayCoords}[vlogo]`);
        finalVStream = 'vlogo';
      }

      // Slogan
      if (branding?.slogan) {
        const safe = branding.slogan.replace(/['"\\:\[\]]/g, '');
        filterLines.push(`[${finalVStream}]drawtext=text='${safe}':fontsize=28:fontcolor=white:borderw=2:bordercolor=black:x=20:y=H-30[vfinal]`);
        finalVStream = 'vfinal';
      }

      // Filter_complex dosyasına yaz
      filterFile = path.join(TEMP_DIR, `${jobId}_filter.txt`);
      fs.writeFileSync(filterFile, filterLines.join(';\n'));

      // Ses filtreleri
      const afParts = buildAudioFilters(audio ? { ...audio, _speed: speed } : null);

      // 5. FFmpeg komutu
      const cmdParts = ['ffmpeg', '-y', '-i', inputPath];
      if (logoPath) cmdParts.push('-i', logoPath);

      if (filterLines.length > 0) {
        cmdParts.push('-filter_complex_script', filterFile);
        cmdParts.push('-map', `[${finalVStream}]`);
        cmdParts.push('-map', `[${finalAStream}]`);
      } else {
        // Sadece scale
        cmdParts.push('-vf', `scale=${scaleW}:${scaleH}:flags=${scaleAlgo}`);
      }

      if (afParts.length > 0) cmdParts.push('-af', afParts.join(','));

      const crf = resolution === '4k' ? '18' : resolution === '1080' ? '20' : '23';
      const preset = resolution === '4k' ? 'medium' : 'fast';
      cmdParts.push(
        '-c:v', 'libx264',
        '-preset', preset,
        '-crf', crf,
        '-c:a', 'aac',
        '-b:a', resolution === '4k' ? '320k' : '192k',
        '-movflags', '+faststart',
        outputPath
      );

      _renderJobs[jobId] = { ..._renderJobs[jobId], status: 'rendering', progress: 20 };
      logger.info('4K render başladı', { jobId, resolution, segCount: segs?.length || 0, customerId });

      // 6. FFmpeg çalıştır — stderr'den ilerleme parse et
      const timeoutMs = resolution === '4k' ? 600000 : resolution === '1080' ? 300000 : 180000;

      await new Promise((resolve, reject) => {
        const proc = exec(
          cmdParts.map(p => (p.includes(' ') ? `"${p}"` : p)).join(' '),
          { timeout: timeoutMs },
          (err, _out, stderr) => {
            if (err) {
              logger.error('FFmpeg render hatası', { jobId, stderr: (stderr || '').slice(0, 600) });
              return reject(new Error('FFmpeg render hatası'));
            }
            resolve();
          }
        );
        // İlerleme: FFmpeg stderr'de "time=HH:MM:SS" yazar
        if (proc.stderr) {
          proc.stderr.on('data', chunk => {
            const m = chunk.match(/time=(\d{2}):(\d{2}):(\d{2})/);
            if (m) {
              const s = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
              _renderJobs[jobId].progress = Math.min(92, 20 + Math.round(s * 1.5));
            }
          });
        }
      });

      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000)
        throw new Error('Çıktı video oluşturulamadı');

      const outSize = fs.statSync(outputPath).size;

      // 7. Sonucu kaydet
      if (!global._proFiles) global._proFiles = {};
      global._proFiles[jobId] = { path: outputPath, createdAt: Date.now() };
      setTimeout(() => {
        cleanupFiles(inputPath, outputPath, logoPath, filterFile);
        if (global._proFiles) delete global._proFiles[jobId];
        delete _renderJobs[jobId];
      }, 30 * 60 * 1000);

      _renderJobs[jobId] = {
        status: 'done',
        progress: 100,
        fileId: jobId,
        downloadUrl: `/api/pro/download/${jobId}`,
        size: outSize,
        resolution
      };
      logger.info('4K render tamamlandı', { jobId, outSize, resolution });

    } catch (err) {
      logger.error('Render hatası', { jobId, error: err.message });
      cleanupFiles(inputPath, outputPath, logoPath, filterFile);
      _renderJobs[jobId] = { status: 'error', progress: 0, error: err.message };
    }
  })();
});


// ════════════════════════════════════════════════════════════
//  RENDER PROGRESS — Job ilerleme sorgula
//  GET /api/pro/render-progress/:jobId
// ════════════════════════════════════════════════════════════
router.get('/render-progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!jobId || !/^render_\d+_[a-z0-9]+$/.test(jobId))
    return res.status(400).json({ ok: false, error: 'Geçersiz jobId' });

  const job = _renderJobs[jobId];
  if (!job) return res.status(404).json({ ok: false, error: 'Job bulunamadı veya süresi dolmuş' });

  res.json({ ok: true, ...job });
});

// ════════════════════════════════════════════════════════════
//  MULTI-CLIP RENDER  —  Birden fazla kaynak video + overlay + geçiş
//  POST /api/pro/render-multi
//  Body: {
//    clips: [{ sourceFileId?, videoUrl?, start?, end?, transition?, transDur? }],
//    overlays?: [{ sourceFileId?, videoUrl?, startAt, endAt, x, y, scale }],
//    resolution?, lut?, color?, audio?, branding?, customerId?
//  }
// ════════════════════════════════════════════════════════════
router.post('/render-multi', async (req, res) => {
  const {
    clips, overlays = [],
    resolution = '1080', lut, color, audio, branding,
    customerId = 'anon'
  } = req.body || {};

  if (!Array.isArray(clips) || clips.length < 1)
    return res.status(400).json({ ok: false, error: 'clips dizisi gerekli (min 1)' });
  if (clips.length > 20)
    return res.status(400).json({ ok: false, error: 'Maksimum 20 klip desteklenir' });
  if (!['720', '1080', '4k'].includes(resolution))
    return res.status(400).json({ ok: false, error: 'Geçersiz çözünürlük: 720|1080|4k' });

  const jobId      = `multi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const outputPath = path.join(TEMP_DIR, `${jobId}_out.mp4`);
  _renderJobs[jobId] = { status: 'queued', progress: 0, startedAt: Date.now() };
  res.json({ ok: true, jobId, pollUrl: `/api/pro/render-progress/${jobId}` });

  (async () => {
    // Wait for a render slot (parallel limiter)
    await _acquireRenderSlot();

    const tempFiles = [];
    let filterFile = null;
    let logoPath   = null;

    try {
      _renderJobs[jobId] = { ..._renderJobs[jobId], status: 'downloading', progress: 5 };

      const scaleW     = resolution === '4k' ? 3840 : resolution === '1080' ? 1920 : 1280;
      const scaleH     = resolution === '4k' ? 2160 : resolution === '1080' ? 1080 : 720;
      const scaleAlgo  = resolution === '4k' ? 'lanczos' : 'bicubic';
      // Force aspect ratio → letterbox/pillarbox → uniform resolution
      const normVF = `scale=${scaleW}:${scaleH}:force_original_aspect_ratio=decrease:flags=${scaleAlgo},` +
                     `pad=${scaleW}:${scaleH}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

      // ── 1. Download all clip sources ──
      const clipPaths = [];
      for (let i = 0; i < clips.length; i++) {
        const c = clips[i];
        const p = path.join(TEMP_DIR, `${jobId}_clip${i}.mp4`);
        tempFiles.push(p);
        if (c.sourceFileId && global._proFiles?.[c.sourceFileId]) {
          fs.copyFileSync(global._proFiles[c.sourceFileId].path, p);
        } else if (c.videoUrl) {
          await downloadVideo(c.videoUrl, p);
        } else {
          throw new Error(`Klip ${i}: sourceFileId veya videoUrl gerekli`);
        }
        if (!fs.existsSync(p) || fs.statSync(p).size < 100)
          throw new Error(`Klip ${i} kaynağı alınamadı`);
        clipPaths.push(p);
        _renderJobs[jobId].progress = 5 + Math.round((i + 1) / clips.length * 18);
      }

      // ── 2. Download all overlay sources ──
      const overlayPaths = [];
      for (let i = 0; i < overlays.length; i++) {
        const ov = overlays[i];
        const p  = path.join(TEMP_DIR, `${jobId}_ov${i}.mp4`);
        tempFiles.push(p);
        if (ov.sourceFileId && global._proFiles?.[ov.sourceFileId]) {
          fs.copyFileSync(global._proFiles[ov.sourceFileId].path, p);
        } else if (ov.videoUrl) {
          await downloadVideo(ov.videoUrl, p);
        } else {
          throw new Error(`Overlay ${i}: sourceFileId veya videoUrl gerekli`);
        }
        overlayPaths.push(p);
      }

      // ── 3. Logo ──
      if (branding?.logoBase64) {
        logoPath = path.join(TEMP_DIR, `${jobId}_logo.png`);
        tempFiles.push(logoPath);
        fs.writeFileSync(logoPath, Buffer.from(
          branding.logoBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64'
        ));
      }

      _renderJobs[jobId] = { ..._renderJobs[jobId], status: 'processing', progress: 28 };

      // ── 4. Build filter_complex ──
      const filterLines = [];
      const vRefs = [];   // normalized video stream labels per clip
      const aRefs = [];   // audio stream labels per clip

      for (let i = 0; i < clips.length; i++) {
        const c = clips[i];
        const hasStart = typeof c.start === 'number';
        const hasEnd   = typeof c.end   === 'number' && c.end > (c.start || 0);
        let vSrc = `[${i}:v]`, aSrc = `[${i}:a]`;

        // Trim if start/end provided
        if (hasStart || hasEnd) {
          const ts = hasStart ? `start=${(+c.start).toFixed(3)}` : '';
          const te = hasEnd   ? `end=${(+c.end).toFixed(3)}`     : '';
          const trimOpts = [ts, te].filter(Boolean).join(':');
          filterLines.push(`${vSrc}trim=${trimOpts},setpts=PTS-STARTPTS[vt${i}]`);
          filterLines.push(`${aSrc}atrim=${trimOpts},asetpts=PTS-STARTPTS[at${i}]`);
          vSrc = `[vt${i}]`; aSrc = `[at${i}]`;
        }

        // Normalize resolution (auto-equalize different source resolutions)
        filterLines.push(`${vSrc}${normVF}[vn${i}]`);
        vRefs.push(`[vn${i}]`);
        aRefs.push(aSrc);
      }

      // ── 5. Concat or xfade chain ──
      let finalV, finalA;

      if (clips.length === 1) {
        finalV = `vn0`; finalA = aRefs[0].replace(/[\[\]]/g, '');
      } else {
        const hasTransitions = clips.some((c, i) => i > 0 && c.transition && c.transition !== 'none');

        if (hasTransitions) {
          // xfade chain — pair by pair
          let curV = `vn0`;
          let curA = aRefs[0].replace(/[\[\]]/g, '');
          let cumOffset = 0;

          for (let i = 1; i < clips.length; i++) {
            const c = clips[i];
            const tDur   = (c.transDur > 0 && c.transDur <= 2) ? +c.transDur : 0.5;
            const prevDur = (typeof clips[i-1].end === 'number' && typeof clips[i-1].start === 'number')
              ? (clips[i-1].end - clips[i-1].start) : 5; // safe fallback
            cumOffset += prevDur;
            const offset  = Math.max(0, cumOffset - tDur).toFixed(3);
            const trans   = XFADE_TRANSITIONS.has(c.transition) ? c.transition : 'fade';
            const nextV   = vRefs[i].replace(/[\[\]]/g, '');
            const nextA   = aRefs[i].replace(/[\[\]]/g, '');

            filterLines.push(`[${curV}][${nextV}]xfade=transition=${trans}:duration=${tDur}:offset=${offset}[xfv${i}]`);
            filterLines.push(`[${curA}][${nextA}]acrossfade=d=${tDur}[xfa${i}]`);
            curV = `xfv${i}`; curA = `xfa${i}`;
          }
          finalV = curV; finalA = curA;

        } else {
          // Simple concat (fastest — no transitions)
          filterLines.push(`${vRefs.join('')}${aRefs.join('')}concat=n=${clips.length}:v=1:a=1[vcat][acat]`);
          finalV = 'vcat'; finalA = 'acat';
        }
      }

      // ── 6. Global color / LUT effects ──
      const effectStr = buildVideoEffectString({ lut, color });
      if (effectStr) {
        filterLines.push(`[${finalV}]${effectStr}[vfx]`);
        finalV = 'vfx';
      }

      // ── 7. Overlay PiP (Hollywood composite) ──
      // Input indices: clips[0..n-1] = 0..n-1, overlays[0..m-1] = n..n+m-1, logo = n+m
      const overlayInputBase = clips.length;
      for (let i = 0; i < overlays.length; i++) {
        const ov    = overlays[i];
        const scale = Math.max(0.05, Math.min(1, ov.scale || 0.3));
        const ovW   = Math.round(scaleW * scale);
        const xPct  = Math.max(0, Math.min(100, ov.x || 50));
        const yPct  = Math.max(0, Math.min(100, ov.y || 50));
        const ovX   = Math.round((scaleW - ovW) * xPct / 100);
        const ovY   = Math.round(scaleH * yPct / 100);
        const inIdx = overlayInputBase + i;

        filterLines.push(`[${inIdx}:v]scale=${ovW}:-1[pip${i}]`);
        const enableExpr = (typeof ov.startAt === 'number' && typeof ov.endAt === 'number')
          ? `:enable='between(t,${ov.startAt.toFixed(2)},${ov.endAt.toFixed(2)})'`
          : '';
        filterLines.push(`[${finalV}][pip${i}]overlay=${ovX}:${ovY}${enableExpr}[vov${i}]`);
        finalV = `vov${i}`;
      }

      // ── 8. Logo + Slogan branding ──
      const logoIdx = clips.length + overlays.length;
      if (logoPath) {
        const coords = getOverlayCoords(branding?.position);
        filterLines.push(`[${logoIdx}:v]scale=120:-1[logo]`);
        filterLines.push(`[${finalV}][logo]overlay=${coords}[vlogo]`);
        finalV = 'vlogo';
      }
      if (branding?.slogan) {
        const safe = branding.slogan.replace(/['"\\:\[\]]/g, '');
        filterLines.push(`[${finalV}]drawtext=text='${safe}':fontsize=28:fontcolor=white:borderw=2:bordercolor=black:x=20:y=H-30[vfinal]`);
        finalV = 'vfinal';
      }

      // ── 9. Write filter_complex to file ──
      filterFile = path.join(TEMP_DIR, `${jobId}_filter.txt`);
      fs.writeFileSync(filterFile, filterLines.join(';\n'));

      const afParts = buildAudioFilters(audio || null);

      // ── 10. Build FFmpeg command ──
      const cmdParts = ['ffmpeg', '-y'];
      for (const p of clipPaths)    cmdParts.push('-i', p);
      for (const p of overlayPaths) cmdParts.push('-i', p);
      if (logoPath)                  cmdParts.push('-i', logoPath);

      cmdParts.push('-filter_complex_script', filterFile);
      cmdParts.push('-map', `[${finalV}]`);
      cmdParts.push('-map', `[${finalA}]`);
      if (afParts.length > 0) cmdParts.push('-af', afParts.join(','));

      const crf    = resolution === '4k' ? '18' : resolution === '1080' ? '20' : '23';
      const preset = resolution === '4k' ? 'medium' : 'fast';
      cmdParts.push(
        '-c:v', 'libx264', '-preset', preset, '-crf', crf,
        '-c:a', 'aac', '-b:a', resolution === '4k' ? '320k' : '192k',
        '-movflags', '+faststart',
        outputPath
      );

      _renderJobs[jobId] = { ..._renderJobs[jobId], status: 'rendering', progress: 35 };
      logger.info('Multi-clip render başladı', { jobId, clipCount: clips.length, overlayCount: overlays.length, resolution });

      const timeoutMs = resolution === '4k' ? 900000 : resolution === '1080' ? 450000 : 240000;
      await new Promise((resolve, reject) => {
        const proc = exec(
          cmdParts.map(p => (p.includes(' ') ? `"${p}"` : p)).join(' '),
          { timeout: timeoutMs },
          (err, _out, stderr) => {
            if (err) {
              logger.error('Multi-clip FFmpeg hatası', { jobId, stderr: (stderr || '').slice(-600) });
              return reject(new Error('FFmpeg hatası: ' + (stderr || '').slice(-200)));
            }
            resolve();
          }
        );
        if (proc.stderr) {
          proc.stderr.on('data', chunk => {
            const m = chunk.match(/time=(\d{2}):(\d{2}):(\d{2})/);
            if (m) {
              const s = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
              _renderJobs[jobId].progress = Math.min(95, 35 + Math.round(s * 1.2));
            }
          });
        }
      });

      if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000)
        throw new Error('Çıktı video oluşturulamadı');

      const outSize = fs.statSync(outputPath).size;
      if (!global._proFiles) global._proFiles = {};
      global._proFiles[jobId] = { path: outputPath, createdAt: Date.now() };

      // Clean up temp input files
      tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch(_) {} });
      if (filterFile) { try { fs.unlinkSync(filterFile); } catch(_) {} }

      // Auto-clean output after 30 min
      setTimeout(() => {
        cleanupFiles(outputPath);
        if (global._proFiles) delete global._proFiles[jobId];
        delete _renderJobs[jobId];
      }, 30 * 60 * 1000);

      _renderJobs[jobId] = {
        status: 'done', progress: 100,
        fileId: jobId,
        downloadUrl: `/api/pro/download/${jobId}`,
        size: outSize, resolution,
        clipCount: clips.length,
        overlayCount: overlays.length
      };
      logger.info('Multi-clip render tamamlandı', { jobId, outSize, clipCount: clips.length });

    } catch (err) {
      logger.error('Multi-clip render hatası', { jobId, error: err.message });
      tempFiles.forEach(f => { try { fs.unlinkSync(f); } catch(_) {} });
      if (filterFile) { try { fs.unlinkSync(filterFile); } catch(_) {} }
      _renderJobs[jobId] = { status: 'error', progress: 0, error: err.message };
    } finally {
      _releaseRenderSlot();
    }
  })();
});

// Fix download endpoint to accept both upload_ and multi_ and render_ fileIds
router.get('/download/:fileId', (req, res) => {
  const { fileId } = req.params;
  if (!fileId || !/^(pro_|upload_|render_|multi_)\d+_[a-z0-9]+$/.test(fileId))
    return res.status(400).json({ ok: false, error: 'Geçersiz dosya ID' });
  const fileInfo = global._proFiles?.[fileId];
  if (!fileInfo || !fs.existsSync(fileInfo.path))
    return res.status(404).json({ ok: false, error: 'Dosya bulunamadı veya süresi dolmuş' });
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="fenix-${fileId}.mp4"`);
  fs.createReadStream(fileInfo.path).pipe(res);
});

// ═══════════════════════════════════════════
//  ARKA PLAN SİLME — POST /api/pro/remove-bg
// ═══════════════════════════════════════════
const _imgUpload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Sadece görsel dosyaları kabul edilir'));
  }
}).single('image');

router.post('/remove-bg', (req, res) => {
  _imgUpload(req, res, async (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    try {
      if (!req.file) return res.status(400).json({ ok: false, error: 'Görsel dosyası gerekli' });

      const bgRemover = require('../services/background-remover');
      const imageBuffer = fs.readFileSync(req.file.path);

      const result = await bgRemover.processProductImage(imageBuffer, {
        keepStand: req.body.keepStand === 'true',
        keepModel: req.body.keepModel === 'true'
      });

      // Temp dosyayı sil
      try { fs.unlinkSync(req.file.path); } catch(e) {}

      if (result.success && Buffer.isBuffer(result.removed)) {
        // Sonucu temp dosyaya yaz, URL döndür
        const outId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const outPath = path.join(TEMP_DIR, `bg-removed-${outId}.png`);
        fs.writeFileSync(outPath, result.removed);

        // 30 dk sonra sil
        setTimeout(() => { try { fs.unlinkSync(outPath); } catch(e) {} }, 30 * 60 * 1000);

        // Global file store'a ekle (download için)
        if (!global._proFiles) global._proFiles = {};
        global._proFiles[outId] = { path: outPath, created: Date.now() };

        res.json({
          ok: true,
          method: result.method,
          analysis: result.analysis || null,
          downloadUrl: `/api/pro/download-img/${outId}`,
          size: result.removed.length
        });
      } else {
        res.status(500).json({ ok: false, error: 'Arka plan silinemedi' });
      }
    } catch(e) {
      logger.error('remove-bg hatası', { error: e.message });
      res.status(500).json({ ok: false, error: e.message });
    }
  });
});

// ════════════════════════════════════════════════════════════
//  AI QC — Gemini ile video/görsel kalite kontrolü
//  POST /api/pro/ai-qc
//  Gemini kontrol eder → Fenix öğrenir → zamanla devralır
// ════════════════════════════════════════════════════════════
router.post('/ai-qc', async (req, res) => {
  try {
    const { fileUrl, type, checks } = req.body;
    if (!fileUrl) return res.status(400).json({ ok: false, error: 'fileUrl gerekli' });

    const gemini = require('../services/gemini-service');
    const qcType = type || 'video'; // video | image | audio

    const prompt = `Sen Fenix AI kalite kontrol uzmanısın. Şu ${qcType} dosyasını analiz et: ${fileUrl}

Kontrol listesi:
1. Teknik kalite (çözünürlük, netlik, gürültü, renk dengesi)
2. Kompozisyon (çerçeveleme, kural-üçte-bir, boşluklar)
3. Ses kalitesi (${qcType === 'video' ? 'rüzgar gürültüsü, kesme, seviye' : 'N/A'})
4. İçerik uygunluğu (marka güvenliği, hassas içerik)
5. Profesyonellik skoru (1-100)

JSON olarak yanıtla:
{
  "score": number (0-100),
  "grade": "A" | "B" | "C" | "D" | "F",
  "findings": [
    { "type": "warning" | "error" | "info" | "success", "area": string, "message": string, "suggestion": string }
  ],
  "summary": string,
  "autoFixable": [string]
}`;

    const response = await gemini.sendMessage([], prompt, 'analysis');

    // JSON parse — Gemini bazen markdown code block içinde döndürür
    let qcResult;
    try {
      const jsonMatch = response.match(/```json\s*([\s\S]*?)```/) || response.match(/\{[\s\S]*\}/);
      qcResult = JSON.parse(jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : response);
    } catch (parseErr) {
      qcResult = {
        score: 70,
        grade: 'B',
        findings: [{ type: 'info', area: 'genel', message: response.slice(0, 200), suggestion: '' }],
        summary: response.slice(0, 300),
        autoFixable: []
      };
    }

    // Fenix öğrenme — QC sonuçlarını kaydet (zamanla Fenix devralacak)
    const trainLog = {
      timestamp: new Date().toISOString(),
      fileUrl,
      type: qcType,
      score: qcResult.score,
      grade: qcResult.grade,
      findingsCount: qcResult.findings?.length || 0,
      model: 'gemini'
    };
    logger.info('AI-QC tamamlandı', trainLog);

    // Socket ile frontend'e bildir
    if (global.io) {
      global.io.emit('ai_qc_result', { ...qcResult, fileUrl });
    }

    res.json({ ok: true, ...qcResult, source: 'gemini', trainLog });
  } catch (e) {
    logger.error('AI-QC hatası', { error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
//  QUOTA — Kullanıcı kota takibi (aylık video limiti)
//  POST /api/pro/quota/check   — kota sorgula
//  POST /api/pro/quota/use     — kota kullan
// ════════════════════════════════════════════════════════════
const _quotaStore = {}; // Memory-based (prod: Firestore/Redis)

function getQuotaKey(userId) {
  const now = new Date();
  return `${userId}_${now.getFullYear()}_${now.getMonth()}`;
}

router.post('/quota/check', (req, res) => {
  const { userId, plan } = req.body;
  if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });

  const limits = {
    ucretsiz: 2,
    pro: 15,
    '360': 20,
    eticaret: 25,
    dublaj: 10,
    otonom: 999
  };

  const key = getQuotaKey(userId);
  const used = _quotaStore[key] || 0;
  const limit = limits[plan] || limits.ucretsiz;
  const remaining = Math.max(0, limit - used);

  res.json({
    ok: true,
    userId,
    plan: plan || 'ucretsiz',
    limit,
    used,
    remaining,
    canRender: remaining > 0
  });
});

router.post('/quota/use', (req, res) => {
  const { userId, plan, count } = req.body;
  if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli' });

  const limits = {
    ucretsiz: 2,
    pro: 15,
    '360': 20,
    eticaret: 25,
    dublaj: 10,
    otonom: 999
  };

  const key = getQuotaKey(userId);
  const used = _quotaStore[key] || 0;
  const limit = limits[plan] || limits.ucretsiz;
  const useCount = count || 1;

  if (used + useCount > limit) {
    return res.status(403).json({
      ok: false,
      error: 'Aylık kota doldu',
      used,
      limit,
      remaining: Math.max(0, limit - used)
    });
  }

  _quotaStore[key] = used + useCount;
  logger.info('Kota kullanıldı', { userId, plan, used: _quotaStore[key], limit });

  res.json({
    ok: true,
    used: _quotaStore[key],
    limit,
    remaining: limit - _quotaStore[key]
  });
});

/* ═══════════════════════════════════════════════════════
   SES İŞLEME — FFmpeg audio pipeline
   Lovable api.ts: audioWindReduce, audioCut, audioMerge, audioUpdateSettings
═══════════════════════════════════════════════════════ */

// Audio upload multer
const _audioUpload = multer({ dest: TEMP_DIR, limits: { fileSize: 500 * 1024 * 1024 } });

// POST /api/pro/audio/process — Genel ses işleme
router.post('/audio/process', _audioUpload.single('audio'), async (req, res) => {
  try {
    const { action, fileUrl, startMs, endMs, trackA, trackB, settings } = req.body;

    // Maliyet kaydı
    if (global.fenixRecordCost) global.fenixRecordCost('ffmpeg-audio', 0.001, action);

    switch (action) {
      case 'wind-reduce': {
        // FFmpeg highpass + lowpass ile rüzgar gürültüsü azaltma
        const inputPath = req.file ? req.file.path : await downloadToTemp(fileUrl);
        const outId = 'audio_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        const outPath = path.join(TEMP_DIR, outId + '.mp3');

        const ffCmd = `ffmpeg -y -i "${inputPath}" -af "highpass=f=80,lowpass=f=12000,afftdn=nf=-20" "${outPath}"`;
        await execPromise(ffCmd);

        const fileId = outId;
        if (!global._proFiles) global._proFiles = {};
        global._proFiles[fileId] = { path: outPath, created: Date.now() };

        res.json({ ok: true, jobId: fileId, status: 'done', downloadUrl: `/api/pro/download/${fileId}` });
        break;
      }

      case 'cut': {
        const inputPath = req.file ? req.file.path : await downloadToTemp(fileUrl);
        const outId = 'acut_' + Date.now();
        const outPath = path.join(TEMP_DIR, outId + '.mp3');
        const startSec = (startMs || 0) / 1000;
        const duration = ((endMs || 0) - (startMs || 0)) / 1000;

        const ffCmd = `ffmpeg -y -i "${inputPath}" -ss ${startSec} -t ${duration} -acodec copy "${outPath}"`;
        await execPromise(ffCmd);

        const fileId = outId;
        if (!global._proFiles) global._proFiles = {};
        global._proFiles[fileId] = { path: outPath, created: Date.now() };

        res.json({ ok: true, jobId: fileId, status: 'done', downloadUrl: `/api/pro/download/${fileId}` });
        break;
      }

      case 'merge': {
        const pathA = await downloadToTemp(trackA);
        const pathB = await downloadToTemp(trackB);
        const outId = 'amerge_' + Date.now();
        const outPath = path.join(TEMP_DIR, outId + '.mp3');

        const ffCmd = `ffmpeg -y -i "${pathA}" -i "${pathB}" -filter_complex "[0:a][1:a]amix=inputs=2:duration=longest" "${outPath}"`;
        await execPromise(ffCmd);

        const fileId = outId;
        if (!global._proFiles) global._proFiles = {};
        global._proFiles[fileId] = { path: outPath, created: Date.now() };

        res.json({ ok: true, jobId: fileId, status: 'done', downloadUrl: `/api/pro/download/${fileId}` });
        break;
      }

      case 'update-settings': {
        // EQ/ducking ayarları — client-side preview için sadece onay
        // Gerçek uygulama render sırasında yapılır
        res.json({ ok: true, settings: settings || {} });
        break;
      }

      default:
        res.status(400).json({ ok: false, error: 'Geçersiz action: ' + action });
    }
  } catch (e) {
    logger.error('Audio process error', { error: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════
   VİDEO BLUR — Yüz/Plaka algılama + bulanıklaştırma
═══════════════════════════════════════════════════════ */

// POST /api/pro/video/detect-blur — Gemini ile yüz/plaka algılama
router.post('/video/detect-blur', async (req, res) => {
  try {
    const { fileUrl } = req.body;
    if (!fileUrl) return res.status(400).json({ ok: false, error: 'fileUrl gerekli' });

    // Gemini Vision ile analiz
    const gemini = require('../services/gemini-service');
    const prompt = `Bu video/görselda yüz ve plaka bölgelerini tespit et. JSON formatında döndür:
    { "regions": [{ "x": 0-1 normalized, "y": 0-1 normalized, "w": 0-1 normalized, "h": 0-1 normalized, "type": "face" | "plate" }] }
    Sadece JSON döndür, başka metin yazma.`;

    let regions = [];
    try {
      const result = await gemini.generate(prompt, { imageUrl: fileUrl });
      const parsed = JSON.parse(result.replace(/```json?\n?/g, '').replace(/```/g, '').trim());
      regions = parsed.regions || [];
      if (global.fenixRecordCost) global.fenixRecordCost('gemini', 0.003, 'detect-blur');
    } catch (e) {
      // Gemini başarısız olursa boş döndür
      logger.warn('Blur detection fallback', { error: e.message });
    }

    const jobId = 'blur_' + Date.now();
    res.json({ ok: true, jobId, regions });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/pro/video/apply-blur — FFmpeg ile blur uygula
router.post('/video/apply-blur', async (req, res) => {
  try {
    const { fileUrl, regions } = req.body;
    if (!fileUrl || !regions || !regions.length) {
      return res.status(400).json({ ok: false, error: 'fileUrl ve regions gerekli' });
    }

    const inputPath = await downloadToTemp(fileUrl);
    const outId = 'blur_' + Date.now();
    const outPath = path.join(TEMP_DIR, outId + '.mp4');

    // FFmpeg boxblur filter chain
    // Her region için bir drawbox + boxblur overlay
    const filters = regions.map((r, i) => {
      const x = `iw*${r.x}`;
      const y = `ih*${r.y}`;
      const w = `iw*${r.w}`;
      const h = `ih*${r.h}`;
      return `delogo=x=${x}:y=${y}:w=${w}:h=${h}:show=0`;
    });

    // Basit yaklaşım: tüm bölgeleri tek bir boxblur ile kapat
    // Her bölge için crop→blur→overlay pipeline
    let filterComplex = '';
    regions.forEach((r, i) => {
      const x = Math.round(r.x * 1920);
      const y = Math.round(r.y * 1080);
      const w = Math.round(r.w * 1920);
      const h = Math.round(r.h * 1080);
      if (i === 0) {
        filterComplex += `[0:v]drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@0.8:t=fill`;
      } else {
        filterComplex += `,drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@0.8:t=fill`;
      }
    });
    filterComplex += `[out]`;

    const ffCmd = `ffmpeg -y -i "${inputPath}" -filter_complex "${filterComplex}" -map "[out]" -map 0:a? -c:a copy "${outPath}"`;
    await execPromise(ffCmd);

    const fileId = outId;
    if (!global._proFiles) global._proFiles = {};
    global._proFiles[fileId] = { path: outPath, created: Date.now() };
    if (global.fenixRecordCost) global.fenixRecordCost('ffmpeg', 0.002, 'apply-blur');

    res.json({ ok: true, jobId: fileId, status: 'done', downloadUrl: `/api/pro/download/${fileId}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════
   HOTSPOT — Ürün etiketleme metadata embed
═══════════════════════════════════════════════════════ */

// POST /api/pro/video/embed-hotspots — Video metadata'ya hotspot bilgisi göm
router.post('/video/embed-hotspots', (req, res) => {
  try {
    const { hotspots, videoFileId } = req.body;
    if (!hotspots || !hotspots.length) {
      return res.status(400).json({ ok: false, error: 'hotspots gerekli' });
    }

    // Hotspot verisini global state'de tut — render sırasında kullanılır
    if (!global._proHotspots) global._proHotspots = {};
    const hotspotId = 'hs_' + Date.now();
    global._proHotspots[hotspotId] = {
      hotspots,
      videoFileId,
      created: Date.now()
    };

    // Fenix öğrenme: hotspot kullanım paterni
    try {
      const fenixBrain = require('../services/fenix-brain');
      fenixBrain.logShadow({ task: 'hotspot_embed', method: 'metadata', success: true, count: hotspots.length });
    } catch(e) {}

    res.json({ ok: true, hotspotId, count: hotspots.length, message: 'Hotspot verileri kaydedildi' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════
   360° STİTCH — Çoklu görsel birleştirme
═══════════════════════════════════════════════════════ */

const _stitchUpload = multer({ dest: TEMP_DIR, limits: { fileSize: 100 * 1024 * 1024 } });

// POST /api/pro/stitch — 360° görsel birleştirme başlat
router.post('/stitch', _stitchUpload.array('images', 50), async (req, res) => {
  try {
    const { assetIds, order } = req.body;
    const files = req.files || [];

    const jobId = 'stitch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

    // İş kuyruğuna ekle
    if (!global._proStitchJobs) global._proStitchJobs = {};
    global._proStitchJobs[jobId] = {
      status: 'processing',
      progress: 0,
      message: 'Görseller işleniyor...',
      estimatedTime: files.length * 2,
      created: Date.now()
    };

    // Async işleme
    (async () => {
      try {
        const job = global._proStitchJobs[jobId];
        const sharp = require('sharp');

        // Gelen dosyaları sırala
        const sortedFiles = order
          ? JSON.parse(typeof order === 'string' ? order : JSON.stringify(order))
              .map((idx) => files[idx]).filter(Boolean)
          : files;

        if (sortedFiles.length < 2) {
          job.status = 'error';
          job.message = 'En az 2 görsel gerekli';
          return;
        }

        job.progress = 10;
        job.message = 'Görseller yeniden boyutlandırılıyor...';

        // Her görseli aynı yüksekliğe getir
        const TARGET_HEIGHT = 1080;
        const resizedBuffers = [];
        for (let i = 0; i < sortedFiles.length; i++) {
          const buf = await sharp(sortedFiles[i].path)
            .resize({ height: TARGET_HEIGHT })
            .toBuffer();
          resizedBuffers.push(buf);
          job.progress = 10 + Math.round((i / sortedFiles.length) * 40);
        }

        job.progress = 50;
        job.message = 'Panorama oluşturuluyor...';

        // Basit yatay birleştirme (equirectangular yaklaşımı)
        const metas = await Promise.all(resizedBuffers.map(b => sharp(b).metadata()));
        const totalWidth = metas.reduce((sum, m) => sum + (m.width || 0), 0);

        // Composite ile birleştir
        const composites = [];
        let xOffset = 0;
        for (let i = 0; i < resizedBuffers.length; i++) {
          composites.push({ input: resizedBuffers[i], left: xOffset, top: 0 });
          xOffset += metas[i].width || 0;
        }

        const outId = jobId;
        const outPath = path.join(TEMP_DIR, outId + '.jpg');

        await sharp({ create: { width: totalWidth, height: TARGET_HEIGHT, channels: 3, background: { r: 0, g: 0, b: 0 } } })
          .composite(composites)
          .jpeg({ quality: 92 })
          .toFile(outPath);

        job.progress = 100;
        job.status = 'done';
        job.message = 'Panorama hazır';

        if (!global._proFiles) global._proFiles = {};
        global._proFiles[outId] = { path: outPath, created: Date.now() };
        job.outputUrl = `/api/pro/download/${outId}`;

        if (global.fenixRecordCost) global.fenixRecordCost('sharp', 0.001, 'stitch-' + sortedFiles.length);

        // Fenix öğrenme
        try {
          const fenixBrain = require('../services/fenix-brain');
          fenixBrain.logShadow({ task: '360_stitch', method: 'sharp', success: true, imageCount: sortedFiles.length });
        } catch(e) {}

      } catch (e) {
        global._proStitchJobs[jobId].status = 'error';
        global._proStitchJobs[jobId].message = e.message;
        logger.error('Stitch error', { jobId, error: e.message });
      }
    })();

    res.json({ ok: true, jobId, status: 'processing', message: 'Birleştirme başladı', estimatedTime: (files.length || 2) * 2 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/pro/stitch/status/:jobId — Stitch durumu
router.get('/stitch/status/:jobId', (req, res) => {
  const job = global._proStitchJobs?.[req.params.jobId];
  if (!job) return res.status(404).json({ ok: false, error: 'İş bulunamadı' });
  res.json({
    ok: true,
    jobId: req.params.jobId,
    status: job.status,
    progress: job.progress,
    message: job.message,
    outputUrl: job.outputUrl ? `${req.protocol}://${req.get('host')}${job.outputUrl}` : undefined
  });
});

/* ═══════════════════════════════════════════════════════
   YARDIMCI FONKSİYONLAR
═══════════════════════════════════════════════════════ */

function execPromise(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 100 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

function downloadToTemp(url) {
  return new Promise((resolve, reject) => {
    if (!url) return reject(new Error('URL boş'));
    // Lokal dosya ise doğrudan döndür
    if (url.startsWith('/') || url.startsWith(TEMP_DIR)) return resolve(url);

    const outPath = path.join(TEMP_DIR, 'dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(outPath);
    proto.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        return downloadToTemp(response.headers.location).then(resolve).catch(reject);
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(outPath); });
    }).on('error', (e) => { fs.unlink(outPath, () => {}); reject(e); });
  });
}

// Görsel indirme endpoint'i
router.get('/download-img/:fileId', (req, res) => {
  const { fileId } = req.params;
  const fileInfo = global._proFiles?.[fileId];
  if (!fileInfo || !fs.existsSync(fileInfo.path))
    return res.status(404).json({ ok: false, error: 'Dosya bulunamadı veya süresi dolmuş' });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', `attachment; filename="fenix-nobg-${fileId}.png"`);
  fs.createReadStream(fileInfo.path).pipe(res);
});

module.exports = router;
