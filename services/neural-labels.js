/**
 * Fenix AI — Nöral Satış Etiketleri (FAZA 8.3)
 * Video oynarken ürün noktalarında interaktif baloncuklar gösterir.
 * AI üretilmiş ikna argümanları.
 * Point tracking ile 3D hareket.
 *
 * Gemini Vision ile ürün üzerindeki önemli noktaları tespit eder,
 * her nokta için satış argümanı üretir.
 */

const logger = require('../utils/logger');

/**
 * Ürün fotoğrafından satış noktaları çıkar
 * @param {string} imageBase64 — base64 görsel
 * @param {Object} analysis — product-analyzer çıktısı
 * @returns {Promise<Array>} — [{ x, y, label, argument, importance }]
 */
async function generateSalesLabels(imageBase64, analysis) {
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

    const productName = analysis.product_name || analysis.product_type || 'ürün';

    const result = await model.generateContent([
      {
        inlineData: {
          data: imageBase64.replace(/^data:image\/[a-z]+;base64,/, ''),
          mimeType: 'image/jpeg'
        }
      },
      {
        text: `Bu ${productName} ürün fotoğrafını analiz et. Ürün üzerindeki 3-5 önemli satış noktasını bul.

Her nokta için:
- x, y: Noktanın görsel üzerindeki konumu (0-1 arası, sol üst köşe 0,0)
- label: Kısa etiket (max 3 kelime, Türkçe)
- argument: Satış argümanı / ikna cümlesi (1 cümle, Türkçe, merak uyandırıcı)
- importance: Önem sırası (1=en önemli)

SADECE JSON döndür:
{ "labels": [{ "x": 0.5, "y": 0.3, "label": "Premium Deri", "argument": "El yapımı İtalyan deri ile üretildi", "importance": 1 }] }`
      }
    ]);

    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);
      const labels = (data.labels || []).map(l => ({
        x: Math.max(0, Math.min(1, l.x || 0.5)),
        y: Math.max(0, Math.min(1, l.y || 0.5)),
        label: (l.label || '').substring(0, 30),
        argument: (l.argument || '').substring(0, 100),
        importance: l.importance || 5
      }));

      // Fenix'e öğret
      _logToFenix(analysis.product_type, labels.length);

      logger.info('Nöral satış etiketleri üretildi', { count: labels.length, productType: analysis.product_type });
      return labels;
    }
  } catch(e) {
    logger.warn('Nöral etiket üretimi başarısız', { error: e.message });
  }

  // Fallback — genel etiketler
  return [
    { x: 0.5, y: 0.3, label: 'Kalite', argument: 'Premium malzeme ile üretildi', importance: 1 },
    { x: 0.3, y: 0.5, label: 'Tasarım', argument: 'Modern ve şık tasarım', importance: 2 },
    { x: 0.7, y: 0.6, label: 'Detay', argument: 'Her detay özenle işlendi', importance: 3 }
  ];
}

/**
 * Point tracking — video karesinde etiketlerin pozisyonunu hesapla
 * Basit hareket tahmini (gerçek tracking ileride eklenecek)
 * @param {Array} labels — başlangıç etiketleri
 * @param {number} frame — mevcut kare numarası
 * @param {number} totalFrames — toplam kare
 * @param {string} cameraMotion — 'zoom_in' | 'pan_left' | 'static' | 'orbit'
 */
function trackLabelsAtFrame(labels, frame, totalFrames, cameraMotion = 'static') {
  const t = frame / (totalFrames || 1); // 0-1 arası ilerleme

  return labels.map(l => {
    let x = l.x, y = l.y, opacity = 1, scale = 1;

    switch (cameraMotion) {
      case 'zoom_in':
        // Zoom'da noktalar merkezden uzaklaşır
        x = 0.5 + (l.x - 0.5) * (1 + t * 0.3);
        y = 0.5 + (l.y - 0.5) * (1 + t * 0.3);
        scale = 1 + t * 0.2;
        break;
      case 'pan_left':
        x = l.x - t * 0.15;
        break;
      case 'pan_right':
        x = l.x + t * 0.15;
        break;
      case 'orbit':
        x = l.x + Math.sin(t * Math.PI * 2) * 0.05;
        y = l.y + Math.cos(t * Math.PI * 2) * 0.02;
        break;
    }

    // Ekran dışına çıkan etiketleri gizle
    if (x < 0.05 || x > 0.95 || y < 0.05 || y > 0.95) opacity = 0;

    // Giriş animasyonu — ilk %10'da fade in
    if (t < 0.1) opacity *= t / 0.1;
    // Çıkış — son %10'da fade out
    if (t > 0.9) opacity *= (1 - t) / 0.1;

    return { ...l, x, y, opacity, scale };
  });
}

function _logToFenix(productType, labelCount) {
  try {
    const fenixBrain = require('./fenix-brain');
    if (fenixBrain && fenixBrain.logShadow) {
      fenixBrain.logShadow({
        task: 'neural_labels',
        productType,
        labelCount,
        success: labelCount > 0
      });
    }
  } catch(e) {}
}

module.exports = { generateSalesLabels, trackLabelsAtFrame };
