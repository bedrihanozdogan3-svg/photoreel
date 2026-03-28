/**
 * Fenix AI — Müzik Servisi
 * Jamendo API ile telif hakkı olmayan müzik arama ve seçme.
 * Ürün analizine göre otomatik müzik önerisi.
 */

const logger = require('../utils/logger');

// Jamendo API (ücretsiz, telif hakkı yok)
const JAMENDO_BASE = 'https://api.jamendo.com/v3.0';
const JAMENDO_CLIENT_ID = 'b0a3a4a0'; // Public client ID

// Ürün tipine göre müzik kategorileri
const PRODUCT_MUSIC_MAP = {
  ayakkabi: { tags: 'energetic+upbeat', speed: 'high', mood: 'happy' },
  canta: { tags: 'fashion+stylish', speed: 'medium', mood: 'groovy' },
  saat: { tags: 'luxury+elegant', speed: 'low', mood: 'dark' },
  gozluk: { tags: 'cool+trendy', speed: 'medium', mood: 'happy' },
  altin: { tags: 'luxury+classical', speed: 'low', mood: 'romantic' },
  elmas: { tags: 'luxury+elegant', speed: 'low', mood: 'romantic' },
  telefon: { tags: 'electronic+modern', speed: 'high', mood: 'energetic' },
  bilgisayar: { tags: 'electronic+tech', speed: 'medium', mood: 'energetic' },
  beyaz_esya: { tags: 'ambient+calm', speed: 'low', mood: 'relaxed' },
  araba: { tags: 'rock+powerful', speed: 'high', mood: 'energetic' },
  motor: { tags: 'rock+aggressive', speed: 'high', mood: 'dark' },
  giyim: { tags: 'fashion+pop', speed: 'medium', mood: 'happy' },
  kozmetik: { tags: 'beauty+soft', speed: 'low', mood: 'romantic' },
  mobilya: { tags: 'ambient+lounge', speed: 'low', mood: 'relaxed' },
  yemek: { tags: 'jazz+lounge', speed: 'low', mood: 'happy' },
  diger: { tags: 'pop+instrumental', speed: 'medium', mood: 'happy' }
};

// Video stiline göre müzik tercihi
const STYLE_MUSIC_MAP = {
  sinematik: { tags: 'cinematic+orchestral', speed: 'medium' },
  enerjik: { tags: 'energetic+dance', speed: 'high' },
  minimalist: { tags: 'ambient+minimal', speed: 'low' },
  luks: { tags: 'luxury+classical+jazz', speed: 'low' },
  eglenceli: { tags: 'fun+upbeat+pop', speed: 'high' }
};

/**
 * Ürün analizine göre müzik ara
 * @param {object} analysis - product-analyzer çıktısı
 * @param {object} options - { duration, limit }
 * @returns {Array} Müzik listesi
 */
async function searchMusic(analysis, options = {}) {
  const productType = analysis?.product_type || 'diger';
  const style = analysis?.suggested_style || 'minimalist';
  const duration = options.duration || 30;
  const limit = options.limit || 5;

  // Ürün tipine ve stile göre tag belirle
  const productPrefs = PRODUCT_MUSIC_MAP[productType] || PRODUCT_MUSIC_MAP.diger;
  const stylePrefs = STYLE_MUSIC_MAP[style] || {};

  const tags = (stylePrefs.tags || productPrefs.tags).replace(/\+/g, '+');

  const url = `${JAMENDO_BASE}/tracks/?client_id=${JAMENDO_CLIENT_ID}` +
    `&format=json&limit=${limit}&include=musicinfo` +
    `&tags=${tags}&type=instrumental` +
    `&duration_between=${Math.max(duration - 15, 10)}_${duration + 30}` +
    `&order=popularity_total_desc`;

  try {
    logger.info('Müzik aranıyor', { tags, productType, style });

    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await response.json();

    if (!data.results || data.results.length === 0) {
      // Fallback: daha genel arama
      return await searchMusicFallback(duration, limit);
    }

    return data.results.map(track => {
      // Gerçek BPM — Jamendo musicinfo.audio.tempo alanından
      let bpm = 110; // fallback
      if (track.musicinfo?.audio?.speed) {
        // speed: "low" | "medium" | "high" | "very_high"
        const speedMap = { very_low: 60, low: 80, medium: 110, high: 130, very_high: 150 };
        bpm = speedMap[track.musicinfo.audio.speed] || 110;
      }
      // Jamendo bazı parçalarda direkt tempo verir
      if (track.musicinfo?.audio?.tempo) bpm = track.musicinfo.audio.tempo;

      return {
        id: track.id,
        name: track.name,
        artist: track.artist_name,
        duration: track.duration,
        url: track.audio,
        downloadUrl: track.audiodownload,
        image: track.image,
        bpm,
        speed: track.musicinfo?.audio?.speed || 'medium',
        energy: track.musicinfo?.audio?.energy || null,
        license: 'CC',
        source: 'jamendo',
        // Beat sync bilgisi (frontend kullanacak)
        beatSync: calculateBeatSync(bpm, 2, 5) // 2sn sahne, 5 sahne varsayılan
      };
    });

  } catch (err) {
    logger.error('Müzik arama hatası', { error: err.message });
    return await searchMusicFallback(duration, limit);
  }
}

/**
 * Fallback müzik arama (genel instrumental)
 */
async function searchMusicFallback(duration, limit) {
  const url = `${JAMENDO_BASE}/tracks/?client_id=${JAMENDO_CLIENT_ID}` +
    `&format=json&limit=${limit}&type=instrumental` +
    `&duration_between=${Math.max(duration - 10, 10)}_${duration + 30}` +
    `&order=popularity_total_desc`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await response.json();

    return (data.results || []).map(track => ({
      id: track.id,
      name: track.name,
      artist: track.artist_name,
      duration: track.duration,
      url: track.audio,
      downloadUrl: track.audiodownload,
      bpm: 110,
      license: 'CC',
      source: 'jamendo'
    }));
  } catch (err) {
    logger.error('Müzik fallback hatası', { error: err.message });
    return [];
  }
}

/**
 * Beat senkronizasyonu — geçişleri müziğin vuruşlarına hizala
 * @param {number} bpm - Müziğin BPM'i
 * @param {number} sceneDuration - Sahne süresi (saniye)
 * @returns {object} { beatInterval, alignedDuration, transitionPoints }
 */
function calculateBeatSync(bpm, sceneDuration, sceneCount) {
  const beatInterval = 60 / bpm; // Saniye cinsinden vuruş aralığı
  const beatsPerScene = Math.round(sceneDuration / beatInterval);
  const alignedDuration = beatsPerScene * beatInterval;

  // Geçiş noktalarını beat'e hizala
  const transitionPoints = [];
  for (let i = 1; i < sceneCount; i++) {
    transitionPoints.push(i * alignedDuration);
  }

  return {
    bpm,
    beatInterval: parseFloat(beatInterval.toFixed(3)),
    alignedDuration: parseFloat(alignedDuration.toFixed(3)),
    transitionPoints,
    totalDuration: parseFloat((sceneCount * alignedDuration).toFixed(3))
  };
}

module.exports = { searchMusic, calculateBeatSync, PRODUCT_MUSIC_MAP };
