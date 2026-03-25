/**
 * Fenix AI — Video Kurgu Motoru
 * Ürün fotoğraflarından reels video üretir.
 *
 * Başlangıç: Basit sekans (fotoğraf sıralama + fade geçiş)
 * İleride: Efektler, müzik, metin overlay
 *
 * Not: Bu modül server-side video üretimi için temel yapıyı kurar.
 * Gerçek render frontend Canvas API veya FFmpeg ile yapılacak.
 * Bu servis kurgu planını (storyboard) oluşturur.
 */

const logger = require('../utils/logger');

// Video boyut presetleri
const PRESETS = {
  'reels': { width: 1080, height: 1920, ratio: '9:16', fps: 60 },
  'tiktok': { width: 1080, height: 1920, ratio: '9:16', fps: 60 },
  'post': { width: 1080, height: 1080, ratio: '1:1', fps: 30 },
  'story': { width: 1080, height: 1920, ratio: '9:16', fps: 30 },
};

// Geçiş tipleri
const TRANSITIONS = {
  fade: { name: 'Fade', duration: 0.5, type: 'opacity' },
  slide_left: { name: 'Slide Left', duration: 0.4, type: 'transform' },
  slide_right: { name: 'Slide Right', duration: 0.4, type: 'transform' },
  zoom_in: { name: 'Zoom In', duration: 0.6, type: 'scale' },
  zoom_out: { name: 'Zoom Out', duration: 0.6, type: 'scale' },
  flash: { name: 'Flash', duration: 0.3, type: 'flash' },
  glitch: { name: 'Glitch', duration: 0.4, type: 'glitch' },
  spin: { name: 'Spin', duration: 0.5, type: 'rotate' },
  dissolve: { name: 'Dissolve', duration: 0.7, type: 'dissolve' },
  wipe: { name: 'Wipe', duration: 0.5, type: 'wipe' },
};

/**
 * Ürün analizine göre storyboard oluştur
 * @param {Array} images - [{ url/base64, analysis }] — analyzeProduct çıktıları
 * @param {object} options - { preset, style, brandName, brandPosition, userText, userTextPosition }
 * @returns {object} Storyboard — video kurgu planı
 */
function createStoryboard(images, options = {}) {
  const preset = PRESETS[options.preset || 'reels'];
  const analysis = images[0]?.analysis || {};
  const style = options.style || analysis.suggested_style || 'minimalist';
  const transitionSpeed = analysis.suggested_transition_speed || 'orta';
  const sceneDuration = options.sceneDuration || analysis.suggested_duration_per_scene || 2;

  // Geçiş seçimi — ürün yapısına göre
  const transitionType = selectTransition(analysis.texture, transitionSpeed);

  // Sahneleri oluştur
  const scenes = [];
  let currentTime = 0;

  // Sahne 0: Intro (ürünün öne çıkan özelliği)
  if (analysis.special_features?.length > 0) {
    scenes.push({
      id: 'intro',
      type: 'text_overlay',
      text: analysis.special_features[0],
      duration: 1.5,
      startTime: currentTime,
      animation: 'fade_in',
      style: { fontSize: 48, fontWeight: 'bold', color: '#FFFFFF', textAlign: 'center' }
    });
    currentTime += 1.5;
  }

  // Ürün sahneleri
  images.forEach((img, i) => {
    const scene = {
      id: `scene_${i}`,
      type: 'product',
      imageIndex: i,
      duration: sceneDuration,
      startTime: currentTime,
      effects: [],
      transition: i > 0 ? { ...transitionType } : { name: 'Fade In', duration: 0.5, type: 'opacity' },
    };

    // Zoom efekti — ürün detayı göster
    if (i === 0) {
      scene.effects.push({
        type: 'zoom',
        from: 1.2, // Biraz yakın başla
        to: 1.0,   // Normal'e dön
        duration: sceneDuration
      });
    } else {
      // Ken Burns efekti (hafif hareket)
      scene.effects.push({
        type: 'pan',
        direction: i % 2 === 0 ? 'left' : 'right',
        amount: 20, // piksel
        duration: sceneDuration
      });
    }

    scenes.push(scene);
    currentTime += sceneDuration;

    // Sahneler arası duraklama (ürünü göster)
    if (i < images.length - 1) {
      currentTime += transitionType.duration;
    }
  });

  // Outro (bitiş kartı)
  scenes.push({
    id: 'outro',
    type: 'outro',
    duration: 1.5,
    startTime: currentTime,
    brandName: options.brandName || 'Fenix AI',
    animation: 'fade_in'
  });
  currentTime += 1.5;

  // Marka ismi overlay (sürekli görünen)
  const overlays = [];
  if (options.brandName) {
    overlays.push({
      type: 'brand',
      text: options.brandName,
      position: options.brandPosition || 'bottom_left', // sol alt veya sağ alt
      style: { fontSize: 14, color: '#FFFFFF', opacity: 0.7 },
      startTime: 0,
      endTime: currentTime
    });
  }

  // Kullanıcı metin kancası
  if (options.userText) {
    overlays.push({
      type: 'hook_text',
      text: options.userText,
      position: options.userTextPosition || 'bottom_right',
      style: { fontSize: 24, fontWeight: 'bold', color: '#FFFFFF', background: 'rgba(0,0,0,0.5)', padding: 8 },
      startTime: 0.5,
      endTime: currentTime - 2
    });
  }

  const storyboard = {
    id: 'sb_' + Date.now(),
    preset,
    style,
    totalDuration: currentTime,
    sceneCount: scenes.length,
    scenes,
    overlays,
    audio: {
      source: null, // İleride müzik eklenecek
      volume: 0.8,
      fadeIn: 0.5,
      fadeOut: 0.5
    },
    metadata: {
      productType: analysis.product_type,
      productName: analysis.product_name,
      colors: analysis.main_colors,
      createdAt: new Date().toISOString()
    }
  };

  logger.info('Storyboard oluşturuldu', {
    scenes: scenes.length,
    duration: currentTime.toFixed(1) + 's',
    style,
    transition: transitionType.name
  });

  return storyboard;
}

/**
 * Ürün yapısına göre geçiş seç
 */
function selectTransition(texture, speed) {
  // Sert/teknoloji ürünler → hızlı, keskin geçişler
  if (['metal', 'cam', 'sert', 'parlak'].includes(texture)) {
    return speed === 'hizli' ? TRANSITIONS.glitch : TRANSITIONS.flash;
  }
  // Yumuşak/kumaş ürünler → akıcı geçişler
  if (['yumusak', 'kumas', 'deri'].includes(texture)) {
    return speed === 'yavas' ? TRANSITIONS.dissolve : TRANSITIONS.fade;
  }
  // Varsayılan
  if (speed === 'hizli') return TRANSITIONS.slide_left;
  if (speed === 'yavas') return TRANSITIONS.fade;
  return TRANSITIONS.zoom_in;
}

/**
 * Storyboard'u doğrula
 */
function validateStoryboard(storyboard) {
  const errors = [];
  if (!storyboard.scenes || storyboard.scenes.length === 0) errors.push('Sahne yok');
  if (storyboard.totalDuration <= 0) errors.push('Süre geçersiz');
  if (storyboard.totalDuration > 60) errors.push('Video 60 saniyeyi aşıyor');
  if (!storyboard.preset) errors.push('Preset tanımsız');
  return { valid: errors.length === 0, errors };
}

module.exports = {
  createStoryboard,
  validateStoryboard,
  PRESETS,
  TRANSITIONS
};
