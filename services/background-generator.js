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
    lighting: {
      direction: 'top_left',
      intensity: analysis.product_quality === 'yuksek' ? 0.7 : 0.9,
      shadow: {
        enabled: true,
        angle: 135,
        softness: 0.6,
        opacity: 0.3
      }
    },
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

module.exports = { generateBackgroundConfig, BG_THEMES, BASE_SURFACES, COLOR_HARMONIES };
