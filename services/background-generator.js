/**
 * Fenix AI — Dinamik Arka Plan Seçici/Oluşturucu
 * Ürün analizine göre arka plan teması, renkler ve objeler belirler.
 *
 * Çıktı: Arka plan yapılandırması (Gemini image gen veya hazır şablonlar ile kullanılacak)
 */

const logger = require('../utils/logger');
const config = require('../config');

// Renk harmonisi — ürün rengine göre uyumlu arka plan renkleri
const COLOR_HARMONIES = {
  siyah: { bg: '#F5F0E8', accent: '#C9A84C', base: '#2C2C2C' },
  beyaz: { bg: '#1A1A2E', accent: '#E8D49A', base: '#F0F0F0' },
  kirmizi: { bg: '#FFF5F0', accent: '#8B0000', base: '#D4A5A5' },
  mavi: { bg: '#F0F5FF', accent: '#1E3A5F', base: '#A5B4C4' },
  yesil: { bg: '#F0FFF0', accent: '#2D5A2D', base: '#A5C4A5' },
  sari: { bg: '#FFFFF0', accent: '#8B8000', base: '#D4D4A5' },
  turuncu: { bg: '#FFF8F0', accent: '#8B4500', base: '#D4B4A5' },
  pembe: { bg: '#FFF0F5', accent: '#8B0045', base: '#D4A5B4' },
  mor: { bg: '#F5F0FF', accent: '#4B0082', base: '#B4A5D4' },
  kahverengi: { bg: '#FAF5F0', accent: '#5C3D2E', base: '#C4A585' },
  gri: { bg: '#F8F8F8', accent: '#4A4A4A', base: '#C0C0C0' },
  altin: { bg: '#1A1A1A', accent: '#C9A84C', base: '#F5F0E8' },
};

// Arka plan temaları
const BG_THEMES = {
  ofis: {
    name: 'Ofis',
    description: 'Hafif ofis görünümü, profesyonel',
    objects: [
      { type: 'vazo', position: 'right', content: 'çiçek', style: 'zarif' },
      { type: 'kalemlik', position: 'right_back', style: 'minimal' },
    ],
    blur: 20, // %20
    base_surface: 'mermer',
    mood: 'profesyonel'
  },
  studyo: {
    name: 'Stüdyo',
    description: 'Temiz stüdyo arka planı, ürün odaklı',
    objects: [],
    blur: 0,
    base_surface: 'granit',
    mood: 'temiz'
  },
  dogal: {
    name: 'Doğal',
    description: 'Doğal ışık, sıcak tonlar',
    objects: [
      { type: 'bitki', position: 'left_back', style: 'küçük' },
    ],
    blur: 15,
    base_surface: 'ahsap',
    mood: 'sicak'
  },
  modern: {
    name: 'Modern',
    description: 'Minimalist, geometrik',
    objects: [
      { type: 'geometrik_obje', position: 'right_back', style: 'metal' },
    ],
    blur: 10,
    base_surface: 'beton',
    mood: 'cool'
  },
  luks: {
    name: 'Lüks',
    description: 'Premium, koyu tonlar, altın aksan',
    objects: [
      { type: 'vazo', position: 'right', content: 'orkide', style: 'premium' },
    ],
    blur: 25,
    base_surface: 'mermer_siyah',
    mood: 'premium'
  }
};

// Alt yüzey tipleri
const BASE_SURFACES = {
  mermer: { color: '#E8E0D8', texture: 'mermer', reflection: 0.3 },
  granit: { color: '#6B6B6B', texture: 'granit', reflection: 0.1 },
  ahsap: { color: '#8B6F47', texture: 'ahşap', reflection: 0.05 },
  beton: { color: '#A0A0A0', texture: 'beton', reflection: 0.02 },
  mermer_siyah: { color: '#2C2C2C', texture: 'mermer', reflection: 0.4 },
  dogal_tas: { color: '#B8A88A', texture: 'doğal taş', reflection: 0.15 },
};

/**
 * Ürün analizine göre arka plan konfigürasyonu oluştur
 * @param {object} analysis - analyzeProduct çıktısı
 * @param {object} userPrefs - Kullanıcı tercihleri { theme, isimlik, sirketIsmi }
 * @returns {object} Arka plan konfigürasyonu
 */
function generateBackgroundConfig(analysis, userPrefs = {}) {
  // Fenix önce kendi karar vermeyi denesin
  try {
    const fenixBrain = require('./fenix-brain');
    const fenixDecision = fenixBrain.fenixDecide('background_generation', {
      productType: analysis.product_type,
      primaryColor: analysis.main_colors?.[0],
      texture: analysis.texture,
      audience: analysis.target_audience
    });
    if (fenixDecision && fenixDecision.handler === 'fenix' && fenixDecision.decision) {
      logger.info('🧠 Fenix arka plan kararını kendi verdi!', { confidence: fenixDecision.confidence });
      // Fenix'in geçmiş deneyiminden gelen karar — direkt kullan
      if (typeof fenixDecision.decision === 'object') return fenixDecision.decision;
    }
  } catch(e) { /* Fenix henüz hazır değil, normal akışa devam */ }

  const primaryColor = analysis.main_colors?.[0] || 'gri';
  const productType = analysis.product_type || 'diger';
  const suggestedTheme = userPrefs.theme || analysis.suggested_bg_theme || 'studyo';

  // Renk harmonisi
  const harmony = COLOR_HARMONIES[primaryColor] || COLOR_HARMONIES.gri;

  // Tema seç
  const theme = BG_THEMES[suggestedTheme] || BG_THEMES.studyo;

  // Alt yüzey — ürün rengine uyumlu
  const baseSurface = selectBaseSurface(primaryColor, productType, theme);

  // Arka plan konfigürasyonu
  const bgConfig = {
    theme: suggestedTheme,
    themeName: theme.name,
    colors: {
      background: harmony.bg,
      accent: harmony.accent,
      base: harmony.base,
    },
    surface: {
      type: baseSurface.texture,
      color: baseSurface.color,
      reflection: baseSurface.reflection,
      position: 'bottom_20percent' // Alt %20
    },
    objects: theme.objects.map(obj => ({
      ...obj,
      color: harmony.accent // Objeler aksan rengiyle uyumlu
    })),
    blur: theme.blur,
    // ── FAZA 4.1: Shadow-Match — Gerçekçi Gölge + Yansıma ──
    lighting: {
      direction: analysis.light_direction || 'sol_ust',
      intensity: analysis.product_quality === 'yuksek' ? 0.7 : 0.9,
      shadow: {
        enabled: true,
        angle: _lightDirToAngle(analysis.light_direction),
        softness: analysis.texture === 'yumusak' ? 0.8 : 0.4,
        opacity: { guclu: 0.5, orta: 0.3, hafif: 0.15, yok: 0 }[analysis.shadow_intensity] || 0.3
      },
      reflection: {
        enabled: analysis.needs_reflection === true,
        intensity: baseSurface.reflection || 0.1,
        blur: 8
      }
    },
    // ── FAZA 4.2: HDRi — Çevre rengi ürüne yansıma ──
    hdri: {
      enabled: analysis.needs_reflection === true || ['metal', 'cam', 'parlak'].includes(analysis.texture),
      envColor: harmony.bg,
      envIntensity: 0.2,
      reflectionStrength: baseSurface.reflection || 0.1
    },
    // ── FAZA 4.3: Auto-Persona — Hedef kitleye göre atmosfer ──
    persona: _buildPersona(analysis, harmony),
    // ── FAZA 4.4: Psikolojik Renk Grading ──
    colorGrading: _buildColorGrading(analysis),
    // Kullanıcı özel alanlar
    nameplate: userPrefs.sirketIsmi ? {
      text: userPrefs.sirketIsmi,
      position: 'right_back',
      style: 'metal_plaka'
    } : null,
    productPlacement: {
      centerX: 0.45, // Ürün biraz sola (objeler sağda)
      centerY: 0.5,
      scale: analysis.has_stand ? 0.7 : 0.8,
      preserveStand: analysis.has_stand,
      preserveModel: analysis.has_model
    },
    // Gemini prompt'u için açıklama
    aiPrompt: buildAiPrompt(analysis, theme, harmony, baseSurface, userPrefs)
  };

  logger.info('Arka plan konfigürasyonu oluşturuldu', {
    theme: suggestedTheme,
    primaryColor,
    productType
  });

  return bgConfig;
}

/**
 * Gemini image generation için prompt oluştur
 */
function buildAiPrompt(analysis, theme, harmony, baseSurface, userPrefs) {
  let prompt = `Professional product photography background for ${analysis.product_name || 'product'}.`;
  prompt += ` Theme: ${theme.description}.`;
  prompt += ` Color palette: background ${harmony.bg}, accent ${harmony.accent}.`;
  prompt += ` Surface: ${baseSurface.texture} texture, ${baseSurface.color} color.`;
  prompt += ` Bottom 20% is ${baseSurface.texture} surface.`;

  if (theme.objects.length > 0) {
    const objDescs = theme.objects.map(o => `${o.style} ${o.type}${o.content ? ' with ' + o.content : ''} on ${o.position}`);
    prompt += ` Decorative objects: ${objDescs.join(', ')}.`;
  }

  prompt += ` Blur: ${theme.blur}%. Product centered, prominent.`;
  prompt += ` NO text, NO watermarks, NO logos on background.`;
  prompt += ` Elegant, minimal, ${theme.mood} mood.`;

  if (analysis.has_model) {
    prompt += ` Professional studio lighting for model photography.`;
  }

  // FAZA 4: Gelişmiş ışık + persona + renk
  if (analysis.light_direction && analysis.light_direction !== 'belirsiz') {
    prompt += ` Light coming from ${analysis.light_direction.replace('_', ' ')}.`;
  }
  if (analysis.needs_reflection) {
    prompt += ` Reflective surface below product, subtle mirror reflection.`;
  }
  if (analysis.shadow_intensity === 'guclu') {
    prompt += ` Strong dramatic shadows, high contrast.`;
  }
  if (analysis.target_audience === 'genc') {
    prompt += ` Youthful, vibrant, urban energy atmosphere.`;
  } else if (analysis.target_audience === 'premium') {
    prompt += ` Ultra luxury, dark elegant, gold accents, premium feel.`;
  }
  if (analysis.color_grading === 'sinematik') {
    prompt += ` Cinematic teal-orange color grading.`;
  } else if (analysis.color_grading === 'agresif' || analysis.is_discount_product) {
    prompt += ` Bold red-yellow tones, attention-grabbing, sale vibes.`;
  }

  return prompt;
}

/**
 * Ürün rengine ve tipine göre alt yüzey seç
 */
function selectBaseSurface(color, productType, theme) {
  // Lüks ürünler → siyah mermer
  if (['altin', 'elmas', 'saat'].includes(productType)) {
    return BASE_SURFACES.mermer_siyah;
  }
  // Tema tercihi
  if (theme.base_surface && BASE_SURFACES[theme.base_surface]) {
    return BASE_SURFACES[theme.base_surface];
  }
  // Koyu ürün → açık yüzey
  if (['siyah', 'kahverengi', 'mor'].includes(color)) {
    return BASE_SURFACES.mermer;
  }
  // Açık ürün → doğal taş
  if (['beyaz', 'sari', 'pembe'].includes(color)) {
    return BASE_SURFACES.dogal_tas;
  }
  return BASE_SURFACES.granit;
}

/**
 * Gerçek arka plan görseli üret
 * Öncelik: fal.ai Flux → Gemini fallback → CSS gradient fallback
 * @param {Object} analysis — product-analyzer çıktısı
 * @param {Object} userPrefs — kullanıcı tercihleri
 * @returns {Promise<Object>} — bgConfig + imageUrl veya generatedStyle
 */
async function generateBackground(analysis, userPrefs = {}) {
  const bgConfig = generateBackgroundConfig(analysis, userPrefs);

  // ── YÖNTEM 1: fal.ai Flux ile gerçek arka plan görseli ──
  const FAL_KEY = process.env.FAL_KEY;
  if (FAL_KEY) {
    try {
      logger.info('fal.ai Flux ile arka plan üretiliyor...');
      const falPrompt = bgConfig.aiPrompt + ' Empty product photography background, no product, no people, high quality, 4K, studio lighting.';

      const resp = await fetch('https://queue.fal.run/fal-ai/flux/dev', {
        method: 'POST',
        headers: {
          'Authorization': `Key ${FAL_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt: falPrompt,
          image_size: { width: 1080, height: 1920 }, // 9:16 reels format
          num_images: 1,
          enable_safety_checker: false
        })
      });

      if (resp.ok) {
        const data = await resp.json();
        // Async job — request_id döner
        if (data.request_id) {
          bgConfig.falRequestId = data.request_id;
          bgConfig.method = 'fal-flux-async';

          // Polling ile sonuç bekle (max 60sn)
          let imageUrl = null;
          for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const statusResp = await fetch(`https://queue.fal.run/fal-ai/flux/dev/requests/${data.request_id}`, {
              headers: { 'Authorization': `Key ${FAL_KEY}` }
            });
            if (statusResp.ok) {
              const status = await statusResp.json();
              if (status.status === 'COMPLETED' && status.images?.[0]?.url) {
                imageUrl = status.images[0].url;
                break;
              }
            }
          }

          if (imageUrl) {
            bgConfig.imageUrl = imageUrl;
            bgConfig.method = 'fal-flux';
            logger.info('fal.ai arka plan üretildi', { url: imageUrl });

            _logToFenix('background_generation', bgConfig, analysis, true);
            return bgConfig;
          }
        }
        // Senkron yanıt (bazı modellerde)
        if (data.images?.[0]?.url) {
          bgConfig.imageUrl = data.images[0].url;
          bgConfig.method = 'fal-flux';
          logger.info('fal.ai arka plan üretildi (sync)', { url: bgConfig.imageUrl });

          _logToFenix('background_generation', bgConfig, analysis, true);
          return bgConfig;
        }
      }
      logger.warn('fal.ai yanıt başarısız, Gemini fallback deneniyor');
    } catch(e) {
      logger.warn('fal.ai arka plan hatası, Gemini fallback', { error: e.message });
    }
  }

  // ── YÖNTEM 2: Gemini ile CSS-bazlı arka plan stili ──
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

    const prompt = `Generate a CSS-based product photography background. Specs: ${bgConfig.aiPrompt}

Return ONLY JSON:
{
  "cssGradient": "CSS linear-gradient string",
  "overlayObjects": [{ "emoji": "🌿", "x": 0.8, "y": 0.3, "scale": 1.0, "opacity": 0.4 }],
  "surfaceColor": "#hex",
  "ambientColor": "#hex",
  "lightDirection": "top-left",
  "blur": 20,
  "vignette": true
}`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      bgConfig.generatedStyle = JSON.parse(jsonMatch[0]);
      bgConfig.method = 'gemini-css';
      logger.info('Gemini arka plan stili üretildi');
    }
  } catch(e) {
    logger.warn('Gemini fallback da başarısız', { error: e.message });
  }

  // ── YÖNTEM 3: Varsayılan CSS gradient ──
  if (!bgConfig.generatedStyle && !bgConfig.imageUrl) {
    bgConfig.generatedStyle = {
      cssGradient: `linear-gradient(180deg, ${bgConfig.colors.background} 0%, ${bgConfig.colors.accent}22 60%, ${bgConfig.colors.baseSurface} 100%)`,
      surfaceColor: bgConfig.colors.baseSurface,
      ambientColor: bgConfig.colors.background,
      lightDirection: 'top-left',
      blur: bgConfig.theme.blur || 20,
      vignette: true,
      overlayObjects: []
    };
    bgConfig.method = 'fallback-css';
  }

  _logToFenix('background_generation', bgConfig, analysis, !!bgConfig.generatedStyle || !!bgConfig.imageUrl);
  return bgConfig;
}

// ── FAZA 4 Yardımcı Fonksiyonlar ──

function _lightDirToAngle(dir) {
  const map = { sol_ust: 135, sag_ust: 45, sol_alt: 225, sag_alt: 315, on: 180, arka: 0, belirsiz: 135 };
  return map[dir] || 135;
}

function _buildPersona(analysis, harmony) {
  const audience = analysis.target_audience || 'genel';
  const mood = analysis.audience_mood || 'profesyonel';

  const personas = {
    genc: { palette: 'vibrant', bg_hint: 'neon, urban, streetwear vibes', energy: 'high', accent_boost: 1.3 },
    yetiskin: { palette: 'balanced', bg_hint: 'clean office, natural wood, warm tones', energy: 'medium', accent_boost: 1.0 },
    premium: { palette: 'muted', bg_hint: 'dark luxury, gold accents, velvet, marble', energy: 'low', accent_boost: 0.8 },
    genel: { palette: 'neutral', bg_hint: 'minimal, professional studio', energy: 'medium', accent_boost: 1.0 }
  };

  const p = personas[audience] || personas.genel;
  return {
    audience,
    mood,
    palette: p.palette,
    bgHint: p.bg_hint,
    energy: p.energy,
    accentBoost: p.accent_boost
  };
}

function _buildColorGrading(analysis) {
  const grading = analysis.color_grading || 'notr';
  const isDiscount = analysis.is_discount_product === true;

  const grades = {
    sicak: { lut: 'warm_gold', temperature: 15, saturation: 1.1, contrast: 1.05, tint: '#FFE4B5' },
    soguk: { lut: 'cool_blue', temperature: -10, saturation: 0.95, contrast: 1.1, tint: '#B0C4DE' },
    notr: { lut: 'neutral', temperature: 0, saturation: 1.0, contrast: 1.0, tint: null },
    sinematik: { lut: 'teal_orange', temperature: 5, saturation: 1.15, contrast: 1.2, tint: '#008080' },
    pastel: { lut: 'pastel_soft', temperature: 5, saturation: 0.8, contrast: 0.95, tint: '#FFE4E1' },
    agresif: { lut: 'aggressive_red', temperature: 20, saturation: 1.4, contrast: 1.3, tint: '#FF4444' }
  };

  // İndirim ürünü → agresif renk
  const finalGrade = isDiscount ? 'agresif' : grading;
  const g = grades[finalGrade] || grades.notr;

  return {
    type: finalGrade,
    ...g,
    isDiscount
  };
}

function _logToFenix(task, bgConfig, analysis, success) {
  try {
    const fenixBrain = require('./fenix-brain');
    if (fenixBrain && fenixBrain.logShadow) {
      fenixBrain.logShadow({
        task,
        method: bgConfig.method,
        theme: bgConfig.suggestedTheme || bgConfig.theme,
        productType: analysis.product_type,
        primaryColor: analysis.main_colors?.[0],
        // FAZA 4 — Fenix bunları öğrenecek
        lightDirection: analysis.light_direction,
        shadowIntensity: analysis.shadow_intensity,
        needsReflection: analysis.needs_reflection,
        targetAudience: analysis.target_audience,
        colorGrading: analysis.color_grading,
        isDiscount: analysis.is_discount_product,
        persona: bgConfig.persona,
        success
      });
    }
  } catch(e) { /* opsiyonel */ }
}

module.exports = { generateBackgroundConfig, generateBackground, BG_THEMES, BASE_SURFACES, COLOR_HARMONIES };
