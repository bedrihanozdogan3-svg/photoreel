/**
 * Fenix AI — Kategori-Özel Modüller (FAZA 6)
 * 6.1 Araç: 360° dönen platform, plaka bulanıklaştırma, galeri arka plan
 * 6.2 Emlak: Dağınık ev → profesyonel, watermark, düzenleme önerileri
 * 6.3 Yemek: Buhar efekti, sıcaklık hissi, nesne sabitliği
 * 6.4 Mini Katalog: Tek fotoğraftan 4 sayfalık görsel dizi
 *
 * Her modül ürün analizine göre özel parametreler üretir.
 * Tüm kararlar Fenix brain'e loglanır.
 */

const logger = require('../utils/logger');

// ── 6.1 ARAÇ MODÜLÜ ──
function getVehicleConfig(analysis) {
  return {
    module: 'arac',
    platform360: {
      enabled: true,
      rotationSpeed: 'slow', // Yavaş dönüş — premium his
      background: 'garaj_studyo', // Garaj/stüdyo arka plan
      floorReflection: true,
      lighting: 'three_point_dramatic'
    },
    plateBlur: {
      enabled: true,
      blurRadius: 15,
      detectMethod: 'gemini_vision' // Plaka tespiti Gemini ile
    },
    branding: {
      logoPosition: 'bottom_right',
      watermarkOpacity: 0.15
    },
    videoStyle: {
      transitions: ['dynamic_pan', 'zoom_in_snap', 'flash_scale'],
      music_mood: 'enerjik',
      duration_per_scene: 2.5,
      fps: 60
    },
    aiPrompt_extra: 'Professional car showroom, polished floor reflection, dramatic three-point lighting, automotive photography style.'
  };
}

// ── 6.2 EMLAK MODÜLÜ ──
function getRealEstateConfig(analysis) {
  return {
    module: 'emlak',
    cleanup: {
      enabled: true, // Dağınıklık temizleme
      removeClutter: true,
      enhanceLighting: true,
      virtualStaging: false // İleride eklenecek
    },
    watermark: {
      enabled: true,
      text: 'Fenix AI', // Kullanıcı değiştirebilir
      position: 'bottom_right',
      opacity: 0.2
    },
    suggestions: {
      enabled: true,
      types: ['mobilya_yerlesim', 'isik_iyilestirme', 'renk_duzeltme', 'perspektif']
    },
    videoStyle: {
      transitions: ['dynamic_pan', 'fade_dissolve', 'slide'],
      music_mood: 'sicak',
      duration_per_scene: 3,
      fps: 30
    },
    aiPrompt_extra: 'Real estate photography, bright natural lighting, clean and spacious feel, professional property showcase.'
  };
}

// ── 6.3 YEMEK MODÜLÜ ──
function getFoodConfig(analysis) {
  const isHotBeverage = (analysis.product_name || '').match(/çay|kahve|chai|latte|espresso|sıcak/i);
  const isHotFood = (analysis.product_name || '').match(/çorba|pizza|kebap|et|ızgara|fırın/i);

  return {
    module: 'yemek',
    effects: {
      steam: {
        enabled: !!(isHotBeverage || isHotFood),
        intensity: isHotBeverage ? 'hafif' : 'orta',
        color: 'beyaz',
        direction: 'up'
      },
      warmth: {
        enabled: true,
        temperature: 15, // Sıcak renk tonu
        saturation: 1.15
      },
      microMotion: {
        enabled: true, // Donmuş resim hissi yok
        type: 'ken_burns_slow'
      }
    },
    stability: {
      objectTracking: true, // Nesne sabitliği
      smoothTransitions: true
    },
    videoStyle: {
      transitions: ['soft_zoom', 'fade_dissolve', 'liquid_transition'],
      music_mood: 'sicak',
      duration_per_scene: 2,
      fps: 60
    },
    aiPrompt_extra: 'Food photography, golden warm lighting, appetizing presentation, shallow depth of field, steam rising naturally.'
  };
}

// ── 6.4 MİNİ KATALOG ÜRETİCİ ──
function getCatalogConfig(analysis) {
  return {
    module: 'katalog',
    pages: [
      {
        type: 'hero',
        title: 'Ana Görsel',
        content: 'Profesyonel arka plan + ürün hero shot',
        layout: 'center_product_gradient_bg'
      },
      {
        type: 'specs',
        title: 'Teknik Özellikler',
        content: 'Ürün detayları, boyut, malzeme',
        layout: 'left_image_right_text',
        autoExtract: true // Gemini ile otomatik özellik çıkarma
      },
      {
        type: 'lifestyle',
        title: 'Kullanım Sahneleri',
        content: 'AI üretilmiş kullanım görselleri',
        layout: 'grid_2x2',
        aiGenerate: true
      },
      {
        type: 'cta',
        title: 'Satın Al',
        content: 'QR kod + iletişim + fiyat',
        layout: 'center_qr_bottom_info',
        qrEnabled: true
      }
    ],
    format: {
      size: 'A4',
      orientation: 'portrait',
      outputFormats: ['pdf', 'png_set']
    },
    aiPrompt_extra: 'Product catalog page, clean layout, professional typography, minimal design.'
  };
}

/**
 * Ürün analizine göre kategori modülü seç
 * @param {Object} analysis — product-analyzer çıktısı
 * @returns {Object|null} — kategori-özel konfigürasyon
 */
function getCategoryModule(analysis) {
  // Fenix önce kendi karar versin
  try {
    const fenixBrain = require('./fenix-brain');
    const decision = fenixBrain.fenixDecide('category_module_selection', { productType: analysis.product_type });
    if (decision && decision.handler === 'fenix' && decision.decision) {
      logger.info('🧠 Fenix kategori kararını kendi verdi!');
      return decision.decision;
    }
  } catch(e) {}

  const type = analysis.product_type || 'diger';

  let config = null;
  if (['araba', 'motor'].includes(type)) {
    config = getVehicleConfig(analysis);
  } else if (type === 'mobilya' || type === 'emlak') {
    config = getRealEstateConfig(analysis);
  } else if (type === 'yemek') {
    config = getFoodConfig(analysis);
  }

  // Katalog her ürün için kullanılabilir
  const catalog = getCatalogConfig(analysis);

  // Fenix'e öğret
  try {
    const fenixBrain = require('./fenix-brain');
    if (fenixBrain && fenixBrain.logShadow) {
      fenixBrain.logShadow({
        task: 'category_module_selection',
        productType: type,
        selectedModule: config?.module || 'genel',
        hasCatalog: true
      });
    }
  } catch(e) {}

  return {
    category: config,
    catalog,
    productType: type
  };
}

module.exports = { getCategoryModule, getVehicleConfig, getRealEstateConfig, getFoodConfig, getCatalogConfig };
