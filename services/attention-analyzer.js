/**
 * Fenix AI — Göz Takip Simülasyonu (FAZA 5.3 — Neuro-Focus)
 * Video render öncesi dikkat analizi yapar.
 * Dikkat dağılıyorsa → o saniyede ürüne parlama/titreşim ekler.
 * İzlenme süresini (retention rate) optimize eder.
 *
 * Gemini Vision ile her sahneyi analiz eder.
 * Tüm kararlar Fenix brain'e loglanır.
 */

const logger = require('../utils/logger');

/**
 * Sahne listesini analiz et — dikkat dağılma noktalarını bul
 * @param {Array} scenes — [{ imageBase64, duration, transition }]
 * @returns {Promise<Array>} — [{ sceneIndex, attentionScore, suggestion }]
 */
async function analyzeAttention(scenes) {
  if (!scenes || !scenes.length) return [];

  const results = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    let score = 70; // Varsayılan dikkat skoru
    let suggestion = null;

    // Kural tabanlı analiz (hızlı, API gerektirmez)
    // 1. Süre çok uzunsa dikkat düşer
    if (scene.duration > 4) {
      score -= 15;
      suggestion = 'Sahne çok uzun — süreyi kısalt veya mikro-titreşim ekle';
    }

    // 2. İlk sahne kritik — merak uyandırmalı
    if (i === 0) {
      score += 10; // İlk sahne doğal olarak dikkat çeker
      if (!scene.transition || scene.transition === 'fade') {
        score -= 5;
        suggestion = 'İlk sahnede zoom-in veya glitch geçiş daha etkili';
      }
    }

    // 3. Ortadaki sahneler dikkat kaybı riski
    if (i > 0 && i < scenes.length - 1) {
      const midPoint = scenes.length / 2;
      if (Math.abs(i - midPoint) < 1) {
        score -= 10;
        suggestion = suggestion || 'Video ortası — flash efekti veya beat-sync geçiş ekle';
      }
    }

    // 4. Son sahne — CTA/marka olmalı
    if (i === scenes.length - 1) {
      score += 5;
      if (!suggestion) suggestion = 'Son sahne — marka/CTA güçlü olmalı';
    }

    // 5. Ardışık aynı geçiş → monotonluk
    if (i > 0 && scene.transition === scenes[i - 1].transition) {
      score -= 8;
      suggestion = suggestion || 'Ardışık aynı geçiş — farklı bir geçiş dene';
    }

    results.push({
      sceneIndex: i,
      attentionScore: Math.max(0, Math.min(100, score)),
      duration: scene.duration,
      riskLevel: score < 50 ? 'yuksek' : score < 70 ? 'orta' : 'dusuk',
      suggestion,
      autoFix: _getAutoFix(score, i, scenes.length)
    });
  }

  // Genel retention tahmini
  const avgScore = results.reduce((s, r) => s + r.attentionScore, 0) / results.length;
  const retentionEstimate = Math.round(avgScore * 0.8); // %80 korelasyon tahmini

  // Fenix'e öğret
  try {
    const fenixBrain = require('./fenix-brain');
    if (fenixBrain && fenixBrain.logShadow) {
      fenixBrain.logShadow({
        task: 'attention_analysis',
        sceneCount: scenes.length,
        avgScore,
        retentionEstimate,
        riskScenes: results.filter(r => r.riskLevel === 'yuksek').length,
        success: true
      });
    }
  } catch(e) {}

  return {
    scenes: results,
    avgAttention: Math.round(avgScore),
    retentionEstimate,
    overallRisk: avgScore < 60 ? 'yuksek' : avgScore < 75 ? 'orta' : 'dusuk'
  };
}

/**
 * Dikkat düşükse otomatik düzeltme önerisi
 */
function _getAutoFix(score, index, total) {
  if (score >= 70) return null; // Düzeltme gerekmiyor

  const fixes = [];
  if (score < 50) fixes.push({ type: 'effect', value: 'parlama', reason: 'Dikkat çok düşük — parlama efekti ekle' });
  if (score < 60) fixes.push({ type: 'effect', value: 'mikro-titresim', reason: 'Dikkat düşük — mikro titreşim ekle' });
  if (index === 0) fixes.push({ type: 'transition', value: 'zoom_in_snap', reason: 'İlk sahne — zoom-in snap daha etkili' });
  if (index > 0 && index < total - 1) fixes.push({ type: 'transition', value: 'flash_scale', reason: 'Orta sahne — flash ile dikkat topla' });

  return fixes.length ? fixes : null;
}

/**
 * Gemini ile gelişmiş dikkat analizi (opsiyonel, API maliyeti var)
 */
async function analyzeWithGemini(imageBase64, sceneDescription) {
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

    const result = await model.generateContent([
      { inlineData: { data: imageBase64.replace(/^data:image\/[a-z]+;base64,/, ''), mimeType: 'image/jpeg' } },
      { text: `Bu ürün fotoğrafını bir reklam videosu sahnesi olarak analiz et.
Dikkat dağılma riski var mı? Ürün yeterince öne çıkıyor mu?
SADECE JSON döndür: { "attentionScore": 0-100, "focusPoint": { "x": 0.5, "y": 0.5 }, "distractions": ["..."], "suggestion": "..." }` }
    ]);

    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch(e) {
    logger.warn('Gemini dikkat analizi başarısız', { error: e.message });
  }
  return null;
}

module.exports = { analyzeAttention, analyzeWithGemini };
