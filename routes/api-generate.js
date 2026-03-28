/**
 * Fenix AI — Video Üretim API
 * fal.ai Kling v2.1 ile ürün fotoğrafından reels video üretir.
 * POST /api/generate
 */

const express = require('express');
const router  = express.Router();
const logger  = require('../utils/logger');

const FAL_KEY = process.env.FAL_KEY;

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
router.post('/', async (req, res) => {
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
 * GET /api/generate/status
 * fal.ai bağlantı testi
 */
router.get('/status', (req, res) => {
  res.json({
    ok: true,
    connected: !!FAL_KEY,
    model: 'kling-v2.1-standard',
    pricePerVideo: '$0.35 (5sn)',
    modelsAvailable: ['kling-v2.1-standard', 'wan-v2.5', 'kling-v2.1-pro']
  });
});

module.exports = router;
