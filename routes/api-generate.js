/**
 * Fenix AI — Video Üretim API
 * fal.ai Kling v2.1 ile ürün fotoğrafından reels video üretir.
 * Luma Dream Machine Ray-2 ile 360° orbit ürün videosu üretir.
 * POST /api/generate
 * POST /api/generate/360
 */

const express = require('express');
const router  = express.Router();
const logger  = require('../utils/logger');
const { rateLimiter } = require('../middleware/rateLimiter');
const { auditLogger } = require('../middleware/auditLog');

const FAL_KEY  = process.env.FAL_KEY;
const LUMA_KEY = process.env.LUMA_KEY;

// Kategori → Türkçe prompt şablonu
const KATEGORI_PROMPT = {
  gida:       'Professional food product video, golden warm lighting, slow zoom in, appetizing presentation, clean white surface, cinematic quality',
  icecek:     'Dynamic beverage product video, dramatic dark background, condensation drops, fast flash cuts, cinematic lighting',
  kozmetik:   'Luxury cosmetics product video, soft white background, gentle fade, elegant lighting, premium feel',
  parfum:     'Mysterious perfume product video, dark dramatic background, smoke effect, slow rotation, luxury atmosphere',
  giyim:      'Fashion clothing product video, clean studio background, dynamic slide transitions, trendy aesthetic',
  ayakkabi:   'Sneaker product video, urban background, zoom punch effect, teal orange color grade, powerful energy',
  elektronik: 'Tech product video, dark background, blue glow effects, glitch transition, futuristic cinematic',
  spor:       'Sports product video, dynamic action background, shake zoom effect, high energy, teal orange grade',
  taki:       'Jewelry product video, black velvet background, sparkle light effects, slow close-up rotation, luxury',
  aksesuar:   'Accessories product video, cream background, soft lighting, elegant slow zoom, premium quality',
  'ev-yasam': 'Home decor product video, warm wooden background, slow pan, cozy atmosphere, golden hour lighting',
  genel:      'Professional product video, clean background, smooth motion, high quality, commercial style'
};

// Komut → prompt eki
const KOMUT_EKI = {
  'sade-arka-plan':    'clean minimal background, studio lighting',
  'luks-hissiyat':     'luxury premium atmosphere, elegant lighting, high-end feel',
  'urunu-one-cikar':   'product in focus, macro detail, sharp clarity',
  'dinamik-gecisler':  'dynamic transitions, energetic movement, fast cuts',
  'dogal-atmosfer':    'natural lighting, organic feel, authentic atmosphere',
  'studyo':            'professional studio setup, perfect lighting, commercial quality'
};

/**
 * POST /api/generate
 * Body: {
 *   imageBase64: string,   // base64 ürün fotoğrafı
 *   kategori: string,
 *   komutlar: string[],
 *   sirketAdi: string,
 *   customerId: string
 * }
 */
// Firestore'dan paket kontrolü (basit)
async function checkCustomerPkg(customerId, requiredPkg) {
  const PKG_TIERS = ['free','reels','pro','360','ses','full'];
  // GÜVENLİK: 'admin' string bypass kaldırıldı
  if (!customerId || typeof customerId !== 'string') return false;
  try {
    const admin = require('firebase-admin');
    const db = admin.firestore();
    const snap = await db.collection('fenix-customers').doc(customerId).get();
    if (!snap.exists) return false;
    const pkg = snap.data().pkg || 'free';
    return PKG_TIERS.indexOf(pkg) >= PKG_TIERS.indexOf(requiredPkg);
  } catch(e) {
    // GÜVENLİK: Firestore hatası → ENGELLE (fail-closed), loglama yap
    logger.warn('Paket kontrolü Firestore hatası — erişim engellendi', { customerId, error: e.message });
    return false;
  }
}

router.post('/', rateLimiter, auditLogger('video_generate'), async (req, res) => {
  if (!FAL_KEY) {
    return res.status(503).json({ ok: false, error: 'Video servisi henüz yapılandırılmadı.' });
  }

  const { imageBase64, imageUrl, kategori, komutlar, sirketAdi, customerId } = req.body || {};

  if (!imageBase64 && !imageUrl) {
    return res.status(400).json({ ok: false, error: 'Ürün fotoğrafı gerekli.' });
  }
  if (!customerId) {
    return res.status(400).json({ ok: false, error: 'Müşteri kimliği gerekli.' });
  }

  // Paket kontrolü — reels paketi gerekli
  const hasAccess = await checkCustomerPkg(customerId, 'reels');
  if (!hasAccess) {
    return res.status(403).json({ ok: false, error: 'Bu özellik için Reels paketi gerekli.', requirePkg: 'reels' });
  }

  try {
    // 1. Fotoğrafı fal.ai storage'a yükle (base64 ise)
    let falImageUrl = imageUrl;
    if (imageBase64 && !imageUrl) {
      falImageUrl = await uploadToFal(imageBase64);
    }

    // 2. Prompt oluştur
    const kategoriPrompt = KATEGORI_PROMPT[kategori] || KATEGORI_PROMPT.genel;
    const komutEkleri = (komutlar || [])
      .map(k => KOMUT_EKI[k])
      .filter(Boolean)
      .join(', ');

    const sirketEki = sirketAdi ? `, branded for ${sirketAdi}` : '';
    const finalPrompt = [kategoriPrompt, komutEkleri, sirketEki]
      .filter(Boolean).join(', ');

    logger.info('Video üretimi başlatıldı', { customerId, kategori, prompt: finalPrompt.slice(0, 80) });

    // 3. fal.ai Kling v2.1 çağrısı
    const falRes = await fetch('https://fal.run/fal-ai/kling-video/v2.1/standard/image-to-video', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${FAL_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: finalPrompt,
        image_url: falImageUrl,
        duration: '5',
        negative_prompt: 'blur, distort, low quality, text, watermark, ugly, deformed',
        cfg_scale: 0.5
      })
    });

    if (!falRes.ok) {
      const errText = await falRes.text();
      logger.error('fal.ai hatası', { status: falRes.status, body: errText.slice(0, 200) });
      return res.status(502).json({ ok: false, error: `Video servisi hatası (${falRes.status})` });
    }

    const falData = await falRes.json();
    const videoUrl = falData?.video?.url;

    if (!videoUrl) {
      logger.error('fal.ai video URL yok', { falData });
      return res.status(502).json({ ok: false, error: 'Video üretilemedi, tekrar deneyin.' });
    }

    logger.info('Video üretildi', { customerId, videoUrl: videoUrl.slice(0, 60) });

    return res.json({
      ok: true,
      videoUrl,
      duration: falData?.video?.duration || 5,
      prompt: finalPrompt
    });

  } catch (e) {
    logger.error('Generate hatası', { error: e.message, stack: e.stack?.slice(0, 200) });
    return res.status(500).json({ ok: false, error: 'Video üretimi sırasında hata oluştu.' });
  }
});

/**
 * Base64 görseli fal.ai storage'a yükle
 */
async function uploadToFal(base64String) {
  // data:image/jpeg;base64,... formatından ayır
  const matches = base64String.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
  if (!matches) throw new Error('Geçersiz base64 formatı');

  const mimeType = matches[1];
  const base64Data = matches[2];
  const buffer = Buffer.from(base64Data, 'base64');

  const ext = mimeType.split('/')[1] || 'jpg';
  const filename = `fenix-${Date.now()}.${ext}`;

  // fal.ai storage upload
  const uploadRes = await fetch('https://fal.run/storage/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Key ${FAL_KEY}`,
      'Content-Type': mimeType,
      'X-Filename': filename
    },
    body: buffer
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Fotoğraf yükleme hatası: ${uploadRes.status} ${err.slice(0, 100)}`);
  }

  const uploadData = await uploadRes.json();
  return uploadData.url || uploadData.access_url;
}

/**
 * POST /api/generate/360
 * Body: {
 *   imageBase64: string,   // base64 ürün fotoğrafı
 *   imageUrl: string,      // veya direkt URL
 *   kategori: string,
 *   sirketAdi: string,
 *   customerId: string,
 *   yon: 'sol'|'sag'       // orbit yönü (varsayılan: sol)
 * }
 * Luma Dream Machine Ray-2 ile 360° orbit video üretir.
 */
router.post('/360', rateLimiter, auditLogger('video_generate_360'), async (req, res) => {
  if (!LUMA_KEY) {
    return res.status(503).json({ ok: false, error: '360° video servisi henüz yapılandırılmadı. Luma API key gerekli.' });
  }

  const { imageBase64, imageUrl, kategori, sirketAdi, customerId, yon } = req.body || {};

  if (!imageBase64 && !imageUrl) {
    return res.status(400).json({ ok: false, error: 'Ürün fotoğrafı gerekli.' });
  }
  if (!customerId) {
    return res.status(400).json({ ok: false, error: 'Müşteri kimliği gerekli.' });
  }

  // Paket kontrolü — 360° paketi gerekli
  const has360Access = await checkCustomerPkg(customerId, '360');
  if (!has360Access) {
    return res.status(403).json({ ok: false, error: 'Bu özellik için 360° paketi gerekli.', requirePkg: '360' });
  }

  try {
    // 1. Fotoğrafı fal.ai storage'a yükle (base64 ise — Luma da URL kabul eder)
    let productImageUrl = imageUrl;
    if (imageBase64 && !imageUrl) {
      if (!FAL_KEY) {
        return res.status(503).json({ ok: false, error: 'Fotoğraf yükleme için FAL_KEY gerekli.' });
      }
      productImageUrl = await uploadToFal(imageBase64);
    }

    // 2. 360° orbit prompt oluştur
    const orbitYon  = yon === 'sag' ? 'right' : 'left';
    const katPrompt = KATEGORI_360_PROMPT[kategori] || KATEGORI_360_PROMPT.genel;
    const sirketEki = sirketAdi ? `, branded for ${sirketAdi}` : '';
    const finalPrompt = `Camera slowly orbits 360 degrees ${orbitYon} around the product, smooth cinematic motion, ${katPrompt}${sirketEki}`;

    logger.info('360° video üretimi başlatıldı', { customerId, kategori, yon: orbitYon });

    // 3. Luma Dream Machine Ray-2 çağrısı
    const lumaRes = await fetch('https://api.lumalabs.ai/dream-machine/v1/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LUMA_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: finalPrompt,
        model: 'ray-2',
        resolution: '720p',
        duration: '5s',
        aspect_ratio: '1:1',
        loop: true,
        keyframes: {
          frame0: {
            type: 'image',
            url: productImageUrl
          }
        }
      })
    });

    if (!lumaRes.ok) {
      const errText = await lumaRes.text();
      logger.error('Luma API hatası', { status: lumaRes.status, body: errText.slice(0, 200) });
      return res.status(502).json({ ok: false, error: `360° video servisi hatası (${lumaRes.status})` });
    }

    const lumaData = await lumaRes.json();
    const generationId = lumaData?.id;

    if (!generationId) {
      logger.error('Luma generation ID yok', { lumaData });
      return res.status(502).json({ ok: false, error: '360° video başlatılamadı.' });
    }

    // 4. Luma asenkron — polling ile sonucu bekle (max 120sn)
    const videoUrl = await pollLumaResult(generationId);

    logger.info('360° video üretildi', { customerId, videoUrl: videoUrl.slice(0, 60) });

    return res.json({
      ok: true,
      videoUrl,
      type: '360-orbit',
      duration: 5,
      prompt: finalPrompt
    });

  } catch (e) {
    logger.error('360° Generate hatası', { error: e.message, stack: e.stack?.slice(0, 200) });
    return res.status(500).json({ ok: false, error: '360° video üretimi sırasında hata oluştu.' });
  }
});

/**
 * Luma generation tamamlanana kadar poll et (max 120sn)
 */
async function pollLumaResult(generationId, maxWaitMs = 120000) {
  const startTime = Date.now();
  const pollInterval = 4000; // 4sn aralıklarla kontrol

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise(r => setTimeout(r, pollInterval));

    const pollRes = await fetch(`https://api.lumalabs.ai/dream-machine/v1/generations/${generationId}`, {
      headers: { 'Authorization': `Bearer ${LUMA_KEY}` }
    });

    if (!pollRes.ok) continue;

    const data = await pollRes.json();
    const state = data?.state;

    if (state === 'completed') {
      const url = data?.assets?.video;
      if (url) return url;
      throw new Error('Luma video URL boş');
    }

    if (state === 'failed') {
      const reason = data?.failure_reason || 'Bilinmeyen hata';
      throw new Error(`Luma üretim başarısız: ${reason}`);
    }

    logger.info('Luma polling...', { generationId, state, elapsed: Date.now() - startTime });
  }

  throw new Error('360° video zaman aşımı (120sn)');
}

// Kategori → 360° orbit arka plan / atmosfer ipuçları
const KATEGORI_360_PROMPT = {
  gida:       'clean white table surface, appetizing warm lighting',
  icecek:     'dark bar counter, dramatic backlight, condensation',
  kozmetik:   'soft white marble surface, elegant studio lighting',
  parfum:     'black velvet surface, moody dramatic atmosphere, smoke wisps',
  giyim:      'minimal clean studio, neutral grey background',
  ayakkabi:   'concrete urban surface, teal-orange color grade',
  elektronik: 'dark tech surface, blue LED ambient lighting',
  spor:       'gym floor, high-energy lighting, teal-orange grade',
  taki:       'black velvet, sparkle highlights, luxury atmosphere',
  aksesuar:   'cream linen surface, soft natural light',
  'ev-yasam': 'warm wooden surface, golden hour window light',
  genel:      'clean minimal studio, professional lighting'
};

/**
 * GET /api/generate/status
 * fal.ai + Luma bağlantı testi
 */
router.get('/status', (req, res) => {
  res.json({
    ok: true,
    reels: {
      connected: !!FAL_KEY,
      model: 'kling-v2.1-standard',
      pricePerVideo: '$0.35 (5sn)',
      modelsAvailable: ['kling-v2.1-standard', 'wan-v2.5', 'kling-v2.1-pro']
    },
    orbit360: {
      connected: !!LUMA_KEY,
      model: 'luma-ray-2',
      pricePerVideo: '~$0.30-0.50 (5sn)',
      features: ['360° orbit', '3D volumetric', 'loop support', '720p']
    }
  });
});

/**
 * POST /api/generate/dublaj
 *
 * Akış:
 *  1. Kullanıcının klonlanmış sesini Firestore'dan al (voiceId)
 *  2. Video dosyasını fal.ai storage'a yükle
 *  3. ElevenLabs ile hedef dilde seslendirme üret
 *  4. (Opsiyonel) Sync Labs ile dudak okuma uygula
 *  5. Sonuç URL'ini döndür
 *
 * Body (multipart/form-data):
 *  - video: File        — dublaj yapılacak video
 *  - userId: string     — müşteri kimliği
 *  - targetLang: string — hedef dil kodu (tr, en, de, ...)
 *  - lipsync: '0'|'1'  — dudak okuma açık mı?
 *  - lipDuration: number — dudak okuma süresi (saniye)
 */
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const SYNCLABS_KEY   = process.env.SYNCLABS_API_KEY;

// Dil kodu → ElevenLabs dil ID eşlemesi
const LANG_MAP = {
  tr: 'tr', en: 'en', de: 'de', fr: 'fr',
  es: 'es', ar: 'ar', it: 'it', pt: 'pt', ru: 'ru'
};

router.post('/dublaj', rateLimiter, auditLogger('dublaj'), upload.single('video'), async (req, res) => {
  const { userId, targetLang = 'en', lipsync = '0', lipDuration = 15 } = req.body || {};
  const videoFile = req.file;

  if (!userId) return res.status(400).json({ ok: false, error: 'userId gerekli.' });
  if (!videoFile) return res.status(400).json({ ok: false, error: 'Video dosyası gerekli.' });

  // Paket kontrolü
  const hasAccess = await checkCustomerPkg(userId, 'ses');
  if (!hasAccess) {
    return res.status(403).json({ ok: false, error: 'Dublaj için Ses paketi gerekli.', requirePkg: 'ses' });
  }

  // Lip sync ayrı ödeme zorunlu — quota'dan gitmez
  // lipsync=1 ise ödeme token'ı kontrol et
  if (lipsync === '1' || lipsync === true) {
    const lipToken = req.body.lipToken;
    if (!lipToken) {
      return res.status(402).json({
        ok: false,
        error: 'Lip sync ücretlidir. Ödeme sayfasına yönlendir.',
        redirectTo: `/odeme?service=lipsync&duration=${lipDuration}&cid=${userId}`,
        costs: { '15s': '₺35', '30s': '₺70', '60s': '₺140' }
      });
    }
    // Token doğrulama (Firestore'da ödeme kaydı kontrol et)
    try {
      const admin = require('firebase-admin');
      const db = admin.firestore();
      const tokenSnap = await db.collection('fenix-lipsync-tokens').doc(lipToken).get();
      if (!tokenSnap.exists || tokenSnap.data().used || tokenSnap.data().customerId !== userId) {
        return res.status(402).json({ ok: false, error: 'Geçersiz veya kullanılmış lip sync token.' });
      }
      // Token'ı kullanıldı olarak işaretle
      await db.collection('fenix-lipsync-tokens').doc(lipToken).update({ used: true, usedAt: new Date().toISOString() });
    } catch (e) {
      logger.warn('Lip sync token kontrolü başarısız (dev mode)', { error: e.message });
      // Dev ortamında devam et
    }
  }

  // ElevenLabs key zorunlu
  if (!ELEVENLABS_KEY) {
    return res.status(503).json({ ok: false, error: 'Ses servisi henüz yapılandırılmadı.' });
  }

  try {
    logger.info('Dublaj başlatıldı', { userId, targetLang, lipsync, lipDuration });

    // 1. Kullanıcının klonlanmış voice ID'sini al
    const voiceId = await getUserVoiceId(userId);
    if (!voiceId) {
      return res.status(404).json({ ok: false, error: 'Ses klonu bulunamadı. Önce ses kaydı yapın.' });
    }

    // 2. Videoyu fal.ai storage'a yükle
    const videoUrl = await uploadBufferToFal(videoFile.buffer, videoFile.mimetype, videoFile.originalname);

    // 3. Video transkripsiyon (Deepgram)
    const transcript = await transcribeVideo(videoUrl);
    if (!transcript) {
      return res.status(422).json({ ok: false, error: 'Video transkripsiyon başarısız.' });
    }

    // 4. ElevenLabs ile hedef dilde seslendirme üret
    const lang = LANG_MAP[targetLang] || 'en';
    const audioBuffer = await generateDubbedAudio(voiceId, transcript, lang);

    // 5. Sesi fal.ai storage'a yükle
    const audioUrl = await uploadBufferToFal(audioBuffer, 'audio/mpeg', `dubbed_${userId}_${Date.now()}.mp3`);

    let resultUrl = audioUrl; // varsayılan: ses dosyası

    // 6. Dudak okuma (opsiyonel — ödeme onaylandıysa)
    if (lipsync === '1' && SYNCLABS_KEY) {
      try {
        resultUrl = await applyLipsync(videoUrl, audioUrl, parseInt(lipDuration));
        logger.info('Dudak okuma tamamlandı', { userId, resultUrl: resultUrl?.slice(0, 60) });
      } catch(e) {
        logger.warn('Dudak okuma başarısız, ses devam ediyor', { error: e.message });
        // Lip sync başarısız olsa da devam et — sadece ses döndür
      }
    }

    // 7. Sonucu Firestore'a kaydet
    await saveDublajResult(userId, { targetLang, voiceId, videoUrl, audioUrl, resultUrl, lipsync });

    logger.info('Dublaj tamamlandı', { userId, targetLang, lipsync, resultUrl: resultUrl?.slice(0, 60) });

    return res.json({
      ok: true,
      resultUrl,
      audioUrl,
      type: lipsync === '1' ? 'video_lipsync' : 'audio_only',
      lang: targetLang
    });

  } catch(e) {
    logger.error('Dublaj hatası', { error: e.message, userId });
    return res.status(500).json({ ok: false, error: 'Dublaj sırasında hata oluştu: ' + e.message });
  }
});

// ── Yardımcı fonksiyonlar ──

async function getUserVoiceId(userId) {
  try {
    const admin = require('firebase-admin');
    const snap = await admin.firestore()
      .collection('fenix-voice-clones')
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    if (snap.empty) return null;
    return snap.docs[0].data().elevenLabsVoiceId || null;
  } catch(e) {
    logger.warn('VoiceId alınamadı', { error: e.message, userId });
    return null;
  }
}

async function uploadBufferToFal(buffer, mimeType, filename) {
  const res = await fetch('https://fal.run/storage/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Key ${FAL_KEY}`,
      'Content-Type': mimeType,
      'X-Filename': filename || 'upload'
    },
    body: buffer
  });
  if (!res.ok) throw new Error(`fal.ai upload hatası: ${res.status}`);
  const d = await res.json();
  return d.url || d.access_url;
}

async function transcribeVideo(videoUrl) {
  const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;
  if (!DEEPGRAM_KEY) {
    logger.warn('Deepgram key yok, transkripsiyon atlanıyor');
    return 'Bu video Fenix AI tarafından seslendirilmiştir.'; // fallback
  }
  try {
    const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&detect_language=true&punctuate=true', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${DEEPGRAM_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: videoUrl })
    });
    if (!res.ok) throw new Error(`Deepgram hatası: ${res.status}`);
    const d = await res.json();
    return d?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
  } catch(e) {
    logger.warn('Transkripsiyon hatası', { error: e.message });
    return '';
  }
}

async function generateDubbedAudio(voiceId, text, lang) {
  if (!text) text = 'Bu içerik Fenix AI tarafından seslendirilmiştir.';
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_KEY,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.3 },
      language_code: lang
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs hatası: ${res.status} ${err.slice(0, 100)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function applyLipsync(videoUrl, audioUrl, durationSec) {
  // Sync Labs via fal.ai
  const res = await fetch('https://fal.run/fal-ai/sync-lipsync/v2', {
    method: 'POST',
    headers: {
      'Authorization': `Key ${FAL_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      video_url: videoUrl,
      audio_url: audioUrl,
      model: 'lipsync-2',
      sync_mode: 'bounce'
    })
  });
  if (!res.ok) throw new Error(`Sync Labs hatası: ${res.status}`);
  const d = await res.json();
  return d?.video?.url || d?.output?.url || null;
}

async function saveDublajResult(userId, data) {
  try {
    const admin = require('firebase-admin');
    await admin.firestore().collection('fenix-dublaj-results').add({
      userId, ...data, createdAt: new Date().toISOString()
    });
  } catch(e) { /* sessizce geç */ }
}

// ═══════════════════════════════════════════
//  FAZA 5 — Trend & Caption API
// ═══════════════════════════════════════════

/**
 * GET /api/generate/trends?category=taki&platform=instagram
 * Ürüne uygun trend müzik + geçiş + efekt döner
 */
router.get('/trends', (req, res) => {
  try {
    const trendService = require('../services/trend-service');
    const { category, platform, mood } = req.query;
    const trend = trendService.getTrendForProduct(category || 'genel', platform || 'both', mood || null);
    if (!trend) return res.status(404).json({ ok: false, error: 'Trend verisi bulunamadı' });
    res.json({ ok: true, trend });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/generate/caption
 * Body: { product_type, product_name, platform, audience_mood }
 * Instagram/TikTok caption + hashtag üretir
 */
router.post('/caption', async (req, res) => {
  try {
    const trendService = require('../services/trend-service');
    const { product_type, product_name, platform, audience_mood } = req.body || {};
    const analysis = { product_type: product_type || 'genel', product_name: product_name || '', audience_mood: audience_mood || 'profesyonel' };
    const caption = await trendService.generateCaption(analysis, platform || 'instagram');
    res.json({ ok: true, ...caption });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/generate/trend-report
 * Haftalık trend raporu döner
 */
router.get('/trend-report', (req, res) => {
  try {
    const trendService = require('../services/trend-service');
    const report = trendService.getWeeklyTrendReport();
    if (!report) return res.status(404).json({ ok: false, error: 'Trend verisi yüklenemedi' });
    res.json({ ok: true, report });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
