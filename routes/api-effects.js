/**
 * Fenix AI — Video Efektleri API
 * Transloadit FFmpeg ile: kamera titreşimi, motion blur, speed ramp, barrel distortion
 * fal.ai Topaz ile: AI slow motion
 * POST /api/effects/apply
 */

const express = require('express');
const router  = express.Router();
const logger  = require('../utils/logger');

const FAL_KEY         = process.env.FAL_KEY;
const TRANSLOADIT_KEY = process.env.TRANSLOADIT_KEY;
const TRANSLOADIT_SEC = process.env.TRANSLOADIT_SECRET;

// Efekt tanımları — her biri FFmpeg filter_complex şablonu
const EFFECTS = {
  // 1. Kamera titreşimi — sinüs dalgası ile rastgele crop
  'kamera-titresim': {
    label: 'Kamera Titreşimi',
    emoji: '📳',
    desc:  'Dinamik, enerji dolu hissiyat',
    ffmpeg_filter: '[0:v]scale=iw*1.06:ih*1.06,crop=iw/1.06:ih/1.06:(iw-out_w)/2+((iw-out_w)/2)*0.5*sin(n*0.8):(ih-out_h)/2+((ih-out_h)/2)*0.5*sin(n*0.9+0.5)[v]',
    map: '[v]'
  },
  // 2. Yoğun titreşim (daha sert)
  'guclu-titresim': {
    label: 'Güçlü Titreşim',
    emoji: '⚡',
    desc:  'Aksiyon, spor videoları için',
    ffmpeg_filter: '[0:v]scale=iw*1.1:ih*1.1,crop=iw/1.1:ih/1.1:(iw-out_w)/2+((iw-out_w)/2)*sin(n*1.2)*0.8:(ih-out_h)/2+((ih-out_h)/2)*sin(n*1.5+1)*0.8[v]',
    map: '[v]'
  },
  // 3. Motion blur — çerçeve karıştırma
  'motion-blur': {
    label: 'Motion Blur',
    emoji: '💨',
    desc:  'Sinematik hareket bulanıklığı',
    ffmpeg_filter: '[0:v]tblend=all_mode=average:all_opacity=0.6[v]',
    map: '[v]'
  },
  // 4. Speed ramp — yavaş başlayıp hızlanan (2 segment)
  'speed-ramp': {
    label: 'Speed Ramp',
    emoji: '🚀',
    desc:  'Yavaştan hıza dramatik geçiş',
    // setpts: ilk yarı 0.3x hız (yavaş), ikinci yarı 2x hız (hızlı)
    ffmpeg_filter: null, // Özel işlem — iki segment halinde encode
    special: 'speed_ramp'
  },
  // 5. Barrel distortion — geniş açı, içinde gibi hissiyat
  'barrel-distortion': {
    label: 'Geniş Açı / Balık Gözü',
    emoji: '🌀',
    desc:  'POV, içinde gibi immersive hissiyat',
    ffmpeg_filter: '[0:v]lenscorrection=cx=0.5:cy=0.5:k1=-0.22:k2=-0.08[v]',
    map: '[v]'
  },
  // 6. Sinematik vinyette + kontrast
  'sinematik': {
    label: 'Sinematik',
    emoji: '🎬',
    desc:  'Koyu kenarlar, film gibi görünüm',
    ffmpeg_filter: '[0:v]vignette=PI/4,eq=contrast=1.15:saturation=1.2:brightness=-0.05[v]',
    map: '[v]'
  },
  // 7. Buhar efekti — sıcak içecekler, yemek
  'buhar': {
    label: 'Buhar / Duman',
    emoji: '♨️',
    desc:  'Sıcak içecek ve yemek ürünleri için',
    ffmpeg_filter: '[0:v]split[a][b];[b]boxblur=15:5,format=rgba,colorchannelmixer=aa=0.3,lutrgb=r=val*1.1:g=val*1.1:b=val*1.15[fog];[a][fog]overlay=0:0:shortest=1[v]',
    map: '[v]'
  },
  // 8. Parlama / Glint — ürün yüzeyinde ışık çakması
  'parlama': {
    label: 'Parlama / Glint',
    emoji: '✨',
    desc:  'Ürün yüzeyinde ışık yansıması, premium hissiyat',
    ffmpeg_filter: '[0:v]split[a][b];[b]eq=brightness=0.4:contrast=2,format=rgba,colorchannelmixer=aa=0.15*sin(n*0.3)[glow];[a][glow]blend=all_mode=screen[v]',
    map: '[v]'
  },
  // 9. Mikro-titreşim — dikkat çekici ince sarsıntı
  'mikro-titresim': {
    label: 'Mikro Titreşim',
    emoji: '📳',
    desc:  'Dikkat çekici ince sarsıntı, beat sync için ideal',
    ffmpeg_filter: '[0:v]scale=iw*1.02:ih*1.02,crop=iw/1.02:ih/1.02:(iw-out_w)/2+2*sin(n*2.5):(ih-out_h)/2+2*cos(n*3.1)[v]',
    map: '[v]'
  },
  // 10. Ken Burns — yavaş zoom + pan (donmuş resim hissi yok)
  'ken-burns': {
    label: 'Ken Burns',
    emoji: '🎞️',
    desc:  'Yavaş zoom ve kaydırma, profesyonel fotoğraf gösterimi',
    ffmpeg_filter: '[0:v]scale=iw*1.2:ih*1.2,zoompan=z=\'min(zoom+0.0005,1.2)\':d=125:x=\'iw/2-(iw/zoom/2)+10*sin(on*0.02)\':y=\'ih/2-(ih/zoom/2)\':s=1080x1920:fps=30[v]',
    map: '[v]'
  },
  // 11. Flulaşan arka plan — zamanla blur artar
  'flu-arkaplan': {
    label: 'Flulaşan Arka Plan',
    emoji: '🌫️',
    desc:  'Arka plan zamanla bulanıklaşır, ürün net kalır',
    ffmpeg_filter: '[0:v]split[fg][bg];[bg]boxblur=luma_radius=min(n/3\\,25):luma_power=2[blurred];[fg][blurred]blend=all_mode=normal:all_opacity=0.5[v]',
    map: '[v]'
  },
  // 12. Hız kontrolü — yavaş çekim
  'slow-motion-soft': {
    label: 'Yumuşak Yavaş Çekim',
    emoji: '🐌',
    desc:  'Yumuşak interpolasyonlu yavaş çekim',
    ffmpeg_filter: '[0:v]setpts=2.0*PTS,minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1[v]',
    map: '[v]'
  }
};

/**
 * GET /api/effects/list
 * Kullanılabilir efektleri listeler
 */
router.get('/list', (req, res) => {
  const list = Object.entries(EFFECTS).map(([id, e]) => ({
    id,
    label: e.label,
    emoji: e.emoji,
    desc:  e.desc
  }));
  res.json({ ok: true, effects: list });
});

/**
 * POST /api/effects/apply
 * Body: {
 *   videoUrl: string,    // fal.ai veya Luma'dan gelen video URL
 *   effectId: string,    // 'kamera-titresim' | 'motion-blur' | ...
 *   customerId: string
 * }
 */
router.post('/apply', async (req, res) => {
  const { videoUrl, effectId, customerId } = req.body || {};

  if (!videoUrl)  return res.status(400).json({ ok: false, error: 'Video URL gerekli.' });
  if (!effectId)  return res.status(400).json({ ok: false, error: 'Efekt ID gerekli.' });
  if (!customerId) return res.status(400).json({ ok: false, error: 'Müşteri kimliği gerekli.' });

  const effect = EFFECTS[effectId];
  if (!effect) return res.status(400).json({ ok: false, error: 'Geçersiz efekt.' });

  // Slow motion → fal.ai Topaz
  if (effectId === 'slow-motion') {
    return applySlowMotion(videoUrl, customerId, res);
  }

  // Diğerleri → Transloadit FFmpeg
  if (!TRANSLOADIT_KEY) {
    // Transloadit yoksa — videoyu olduğu gibi döndür, efekt uygulanamadı
    logger.warn('Transloadit key yok — efekt atlandı', { effectId });
    return res.json({
      ok: true,
      videoUrl,
      effectId,
      skipped: true,
      message: 'Transloadit API key gerekli. Video değiştirilmeden döndürüldü.'
    });
  }

  try {
    logger.info('Efekt uygulanıyor', { customerId, effectId, videoUrl: videoUrl.slice(0,50) });

    // Speed ramp özel işlem
    if (effect.special === 'speed_ramp') {
      return applySpeedRamp(videoUrl, customerId, res);
    }

    // Standart FFmpeg efekti — Transloadit Assembly
    const assembly = await createTransloaditAssembly(videoUrl, effect);
    const resultUrl = await pollTransloaditAssembly(assembly.assembly_id);

    logger.info('Efekt tamamlandı', { customerId, effectId, resultUrl: resultUrl.slice(0,50) });

    return res.json({ ok: true, videoUrl: resultUrl, effectId, original: videoUrl });

  } catch (e) {
    logger.error('Efekt hatası', { effectId, error: e.message });
    // Hata durumunda orijinal video döndür
    return res.json({
      ok: true,
      videoUrl,
      effectId,
      skipped: true,
      message: 'Efekt uygulanamadı, orijinal video döndürüldü.'
    });
  }
});

/**
 * Transloadit Assembly oluştur — FFmpeg efekti uygula
 */
async function createTransloaditAssembly(videoUrl, effect) {
  const steps = {
    imported: {
      robot: '/http/import',
      url: videoUrl
    },
    effect_applied: {
      robot: '/video/encode',
      use: 'imported',
      ffmpeg_stack: 'v7.0.0',
      preset: 'empty',
      ffmpeg: {
        filter_complex: effect.ffmpeg_filter,
        map: [effect.map || '[v]', '0:a?'],
        'c:v': 'libx264',
        'c:a': 'aac',
        'preset': 'fast',
        'crf': '23',
        'movflags': '+faststart'
      },
      result: true,
      format: 'mp4'
    }
  };

  const params = JSON.stringify({
    auth: { key: TRANSLOADIT_KEY },
    steps
  });

  const body = new URLSearchParams();
  body.append('params', params);

  if (TRANSLOADIT_SEC) {
    // HMAC imzası (production güvenliği) — burada basit key-only (dev mod)
    // Production'da HMAC-SHA384 imzası gerekir
  }

  const res = await fetch('https://api2.transloadit.com/assemblies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Transloadit hata ${res.status}: ${err.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * Transloadit Assembly tamamlanana kadar bekle
 */
async function pollTransloaditAssembly(assemblyId, maxWaitMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 3000));

    const res = await fetch(`https://api2.transloadit.com/assemblies/${assemblyId}`, {
      headers: { 'Transloadit-Client': 'fenix-ai/1.0' }
    });
    if (!res.ok) continue;

    const data = await res.json();
    const status = data.ok;

    if (status === 'ASSEMBLY_COMPLETED') {
      const results = data.results?.effect_applied;
      if (results && results[0]) return results[0].ssl_url || results[0].url;
      throw new Error('Transloadit sonuç URL yok');
    }

    if (status === 'ASSEMBLY_ERROR' || data.error) {
      throw new Error(`Transloadit hata: ${data.error || data.message || 'bilinmiyor'}`);
    }

    logger.info('Transloadit polling...', { assemblyId, status, elapsed: Date.now() - start });
  }
  throw new Error('Efekt zaman aşımı (120sn)');
}

/**
 * Speed ramp — iki segment: yavaş + hızlı
 * fal.ai'de yoksa Transloadit'e 2 aşamalı gönder
 */
async function applySpeedRamp(videoUrl, customerId, res) {
  if (!TRANSLOADIT_KEY) {
    return res.json({ ok: true, videoUrl, effectId: 'speed-ramp', skipped: true });
  }

  const steps = {
    imported: { robot: '/http/import', url: videoUrl },
    slow_part: {
      robot: '/video/encode', use: 'imported',
      ffmpeg_stack: 'v7.0.0', preset: 'empty',
      ffmpeg: {
        filter_complex: '[0:v]trim=0:2,setpts=3.0*PTS[slow];[0:v]trim=2,setpts=PTS-STARTPTS*0.4[fast];[slow][fast]concat=n=2:v=1[v]',
        map: '[v]', 'c:v': 'libx264', 'c:a': 'aac', preset: 'fast', crf: '23'
      },
      result: true, format: 'mp4'
    }
  };

  try {
    const params = JSON.stringify({ auth: { key: TRANSLOADIT_KEY }, steps });
    const body = new URLSearchParams();
    body.append('params', params);
    const r = await fetch('https://api2.transloadit.com/assemblies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const data = await r.json();
    const resultUrl = await pollTransloaditAssembly(data.assembly_id);
    return res.json({ ok: true, videoUrl: resultUrl, effectId: 'speed-ramp', original: videoUrl });
  } catch (e) {
    return res.json({ ok: true, videoUrl, effectId: 'speed-ramp', skipped: true });
  }
}

/**
 * fal.ai Topaz Slow Motion
 */
async function applySlowMotion(videoUrl, customerId, res) {
  if (!FAL_KEY) {
    return res.json({ ok: true, videoUrl, effectId: 'slow-motion', skipped: true, message: 'FAL_KEY gerekli.' });
  }
  try {
    const r = await fetch('https://fal.run/fal-ai/topaz/slowmotion/video', {
      method: 'POST',
      headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_url: videoUrl, slowdown_factor: 2, upscale_factor: 1 })
    });
    const data = await r.json();
    const resultUrl = data?.video?.url;
    if (!resultUrl) throw new Error('Topaz URL yok');
    logger.info('Slow motion tamamlandı', { customerId, resultUrl: resultUrl.slice(0,50) });
    return res.json({ ok: true, videoUrl: resultUrl, effectId: 'slow-motion', original: videoUrl });
  } catch (e) {
    return res.json({ ok: true, videoUrl, effectId: 'slow-motion', skipped: true });
  }
}

/**
 * GET /api/effects/status
 */
router.get('/status', (req, res) => {
  res.json({
    ok: true,
    transloadit: !!TRANSLOADIT_KEY,
    fal: !!FAL_KEY,
    effectsAvailable: Object.keys(EFFECTS)
  });
});

module.exports = router;
