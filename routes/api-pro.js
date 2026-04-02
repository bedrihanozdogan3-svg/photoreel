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
    lut, color, audio, branding, speed, customerId = 'anon'
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

module.exports = router;
