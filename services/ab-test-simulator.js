/**
 * Fenix AI — A/B Test Simülatörü (FAZA 5.4)
 * Aynı üründen farklı versiyonlar türetir.
 * İç simülasyonda yarıştırır (hangisi daha etkili?).
 * Sadece en iyi olanı kullanıcıya sunar.
 *
 * Tüm kararlar Fenix brain'e loglanır.
 */

const logger = require('../utils/logger');

/**
 * Ürün analizi + trend verisinden N farklı video konsepti üret
 * @param {Object} analysis — product-analyzer çıktısı
 * @param {Object} trend — trend-service çıktısı
 * @param {number} variants — kaç farklı versiyon (varsayılan 3)
 * @returns {Array} — [{ id, concept, score, params }]
 */
function generateVariants(analysis, trend, variants = 3) {
  const productType = analysis.product_type || 'genel';
  const audience = analysis.target_audience || 'genel';
  const grading = analysis.color_grading || 'notr';

  const pool = [
    {
      id: 'A',
      concept: 'Minimalist — sade, ürün odaklı',
      params: {
        transition: 'fade',
        effect: 'none',
        music_mood: 'minimalist',
        color_grading: 'notr',
        duration_per_scene: 2.5,
        text_hook: false,
        energy: 'low'
      }
    },
    {
      id: 'B',
      concept: 'Enerjik — hızlı geçişler, beat-sync',
      params: {
        transition: 'flash_scale',
        effect: 'mikro-titresim',
        music_mood: 'enerjik',
        color_grading: 'sinematik',
        duration_per_scene: 1.5,
        text_hook: true,
        energy: 'high'
      }
    },
    {
      id: 'C',
      concept: 'Premium — lüks, yavaş, sinematik',
      params: {
        transition: 'zoom_in_snap',
        effect: 'parlama',
        music_mood: 'luks',
        color_grading: 'sicak',
        duration_per_scene: 3,
        text_hook: false,
        energy: 'low'
      }
    },
    {
      id: 'D',
      concept: 'Trend — güncel TikTok/Instagram tarzı',
      params: {
        transition: trend?.transition || 'glitch',
        effect: trend?.effect || 'sinematik',
        music_mood: trend?.music?.vibe || 'enerjik',
        color_grading: 'sinematik',
        duration_per_scene: 2,
        text_hook: true,
        energy: 'medium'
      }
    },
    {
      id: 'E',
      concept: 'Agresif — dikkat çekici, indirim tarzı',
      params: {
        transition: 'flash_scale',
        effect: 'mikro-titresim',
        music_mood: 'enerjik',
        color_grading: 'agresif',
        duration_per_scene: 1.5,
        text_hook: true,
        energy: 'very_high'
      }
    }
  ];

  // Hedef kitleye göre filtrele
  let candidates = [...pool];
  if (audience === 'premium') {
    candidates = candidates.filter(c => c.params.energy !== 'very_high');
  } else if (audience === 'genc') {
    candidates = candidates.filter(c => c.params.energy !== 'low' || c.id === 'A');
  }

  // İlk N'i seç
  candidates = candidates.slice(0, variants);

  // Simülasyon skoru hesapla
  candidates.forEach(c => {
    c.score = _simulateScore(c.params, analysis, trend);
  });

  // Skora göre sırala
  candidates.sort((a, b) => b.score - a.score);

  // Fenix'e öğret
  try {
    const fenixBrain = require('./fenix-brain');
    if (fenixBrain && fenixBrain.logShadow) {
      fenixBrain.logShadow({
        task: 'ab_test_simulation',
        productType,
        audience,
        winnerId: candidates[0]?.id,
        winnerConcept: candidates[0]?.concept,
        winnerScore: candidates[0]?.score,
        variantCount: candidates.length,
        success: true
      });
    }
  } catch(e) {}

  logger.info('A/B test simülasyonu tamamlandı', {
    winner: candidates[0]?.id,
    score: candidates[0]?.score,
    variants: candidates.length
  });

  return {
    winner: candidates[0],
    variants: candidates,
    recommendation: `${candidates[0].concept} (Skor: ${candidates[0].score}/100)`
  };
}

/**
 * İç simülasyon — varsayılan parametrelere göre skor hesapla
 */
function _simulateScore(params, analysis, trend) {
  let score = 50; // Başlangıç

  // Trend uyumu (+20 max)
  if (trend) {
    if (params.music_mood === trend.tempo) score += 10;
    if (params.transition === trend.transition) score += 10;
  }

  // Hedef kitle uyumu (+15 max)
  const audience = analysis.target_audience || 'genel';
  if (audience === 'genc' && params.energy === 'high') score += 15;
  if (audience === 'premium' && params.energy === 'low') score += 15;
  if (audience === 'genel' && params.energy === 'medium') score += 10;

  // İndirim ürünü → agresif daha iyi
  if (analysis.is_discount_product && params.color_grading === 'agresif') score += 15;

  // Metin kancası bonus (engagement)
  if (params.text_hook) score += 5;

  // Efekt bonus
  if (params.effect !== 'none') score += 5;

  // Süre optimizasyonu (1.5-2.5 arası ideal)
  if (params.duration_per_scene >= 1.5 && params.duration_per_scene <= 2.5) score += 5;

  // Rastgelelik (%10 — gerçek dünyayı simüle et)
  score += Math.floor(Math.random() * 10) - 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

module.exports = { generateVariants };
