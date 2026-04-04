/**
 * Fenix AI — Ürün Fotoğraf Analiz Modülü
 * Gemini Vision API ile ürün fotoğraflarını analiz eder.
 *
 * Çıktı: { productType, mainColors, texture, dominantObjects,
 *          backgroundContext, defects, suggestedTransition, suggestedDuration }
 */

const config = require('../config');
const logger = require('../utils/logger');

const { selectModel } = require('./gemini-service');
const GEMINI_VISION_MODEL = selectModel('analysis'); // Flash-lite — ucuz ve hızlı

// Analiz prompt'u — ürünü her açıdan tara
const ANALYSIS_PROMPT = `Sen bir e-ticaret ürün analiz uzmanısın. Bu fotoğrafı analiz et ve SADECE JSON döndür, başka bir şey yazma.

Analiz et:
1. product_type: Ürün ne? (ayakkabi, canta, saat, gozluk, altin, elmas, telefon, bilgisayar, beyaz_esya, araba, motor, giyim, kozmetik, mobilya, yemek, diger)
2. product_name: Ürünün kısa açıklaması (örn: "siyah deri erkek ayakkabı")
3. main_colors: Ana renkler dizisi (max 3) — ["siyah", "beyaz"] gibi
4. texture: Ürün yapısı — "sert", "yumusak", "parlak", "mat", "dokulu", "cam", "metal", "deri", "kumas"
5. background_context: Arka plan ne? — "studyo", "dis_mekan", "ofis", "ev", "magazin", "karisik", "bos"
6. has_model: İnsan model var mı? true/false
7. has_stand: Ürün standı var mı? true/false
8. defects: Tespit edilen kusurlar dizisi — ["kirisiklik", "fazla_isik", "parlama", "golge", "bulaniklik", "leke"] veya boş dizi
9. product_quality: Fotoğraf kalitesi — "yuksek", "orta", "dusuk"
10. suggested_style: Önerilen video stili — "sinematik", "enerjik", "minimalist", "luks", "eglenceli"
11. suggested_bg_theme: Önerilen arka plan teması — "ofis", "studyo", "dogal", "modern", "luks"
12. suggested_transition_speed: Geçiş hızı önerisi — "yavas" (yumuşak ürünler), "orta", "hizli" (sert/teknoloji)
13. suggested_duration_per_scene: Sahne başına önerilen süre (saniye) — 1.5 ile 4 arası
14. special_features: Ürünün öne çıkan özellikleri dizisi (ilk sahne için) — max 3
15. light_direction: Işığın geliş yönü — "sol_ust", "sag_ust", "sol_alt", "sag_alt", "on", "arka", "belirsiz"
16. needs_reflection: Parlak yüzey var mı, zemine yansıma gerekir mi? — true/false (saat, cam şişe, parlak metal = true)
17. shadow_intensity: Gölge yoğunluğu önerisi — "guclu", "orta", "hafif", "yok"
18. target_audience: Hedef kitle tahmini — "genc" (18-25), "yetiskin" (25-45), "premium" (lüks segment), "genel"
19. audience_mood: Kitle atmosferi — "enerjik", "sofistike", "sicak", "cool", "profesyonel"
20. color_grading: Önerilen renk tonu — "sicak" (altın tonlar), "soguk" (mavi tonlar), "notr", "sinematik" (teal-orange), "pastel", "agresif" (kırmızı-sarı, indirim ürünleri)
21. is_discount_product: İndirim/promosyon ürünü gibi mi görünüyor? — true/false
22. surface_material: Alt yüzey önerisi — "mermer", "granit", "ahsap", "beton", "kadife", "cam", "dogal_tas"

SADECE geçerli JSON döndür. Markdown, açıklama veya başka metin YAZMA.`;

/**
 * Fotoğrafı analiz et (base64 veya URL)
 * @param {string} imageData - base64 encoded image veya URL
 * @param {string} mimeType - image/jpeg, image/png, image/webp
 * @returns {object} Analiz sonucu JSON
 */
async function analyzeProduct(imageData, mimeType = 'image/jpeg') {
  if (!config.geminiApiKey) {
    throw new Error('Gemini API key ayarlanmamış');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent?key=${config.geminiApiKey}`;

  // base64 mı URL mi kontrol et
  let imagePart;
  if (imageData.startsWith('http://') || imageData.startsWith('https://')) {
    imagePart = { fileData: { fileUri: imageData, mimeType } };
  } else {
    // base64 — data:image/... prefix'ini temizle
    const cleanBase64 = imageData.replace(/^data:image\/[a-z]+;base64,/, '');
    imagePart = { inlineData: { data: cleanBase64, mimeType } };
  }

  const payload = {
    contents: [{
      role: 'user',
      parts: [
        { text: ANALYSIS_PROMPT },
        imagePart
      ]
    }],
    generationConfig: {
      temperature: 0.1, // Düşük sıcaklık — tutarlı sonuç
      maxOutputTokens: 1024
    }
  };

  try {
    logger.info('Ürün analizi başlatıldı', { mimeType });
    const startTime = Date.now();

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000) // 30 saniye timeout
    });

    const data = await response.json();

    if (data.error) {
      logger.error('Gemini Vision API hatası', { error: data.error.message });
      throw new Error('Gemini hatası: ' + data.error.message);
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error('Gemini boş yanıt döndü');
    }

    // JSON parse — birden fazla strateji ile
    let result;
    try {
      // Strateji 1: Direkt parse
      result = JSON.parse(text.trim());
    } catch (e1) {
      try {
        // Strateji 2: Markdown code block temizle
        const cleanJson = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        result = JSON.parse(cleanJson);
      } catch (e2) {
        try {
          // Strateji 3: İlk { ile son } arasını al
          const match = text.match(/\{[\s\S]*\}/);
          if (match) result = JSON.parse(match[0]);
          else throw new Error('JSON bulunamadı');
        } catch (e3) {
          logger.error('JSON parse başarısız — tüm stratejiler', { rawText: text.substring(0, 500) });
          throw new Error('AI yanıtı geçersiz JSON');
        }
      }
    }

    const elapsed = Date.now() - startTime;
    logger.info('Ürün analizi tamamlandı', {
      productType: result.product_type,
      colors: result.main_colors,
      elapsed: elapsed + 'ms'
    });

    // Varsayılan değerler (eksik alanlar için)
    return {
      product_type: result.product_type || 'diger',
      product_name: result.product_name || 'Bilinmeyen ürün',
      main_colors: result.main_colors || ['gri'],
      texture: result.texture || 'mat',
      background_context: result.background_context || 'karisik',
      has_model: result.has_model || false,
      has_stand: result.has_stand || false,
      defects: result.defects || [],
      product_quality: result.product_quality || 'orta',
      suggested_style: result.suggested_style || 'minimalist',
      suggested_bg_theme: result.suggested_bg_theme || 'studyo',
      suggested_transition_speed: result.suggested_transition_speed || 'orta',
      suggested_duration_per_scene: result.suggested_duration_per_scene || 2,
      special_features: result.special_features || [],
      analyzed_at: new Date().toISOString(),
      analysis_time_ms: elapsed
    };

  } catch (err) {
    if (err.name === 'SyntaxError') {
      logger.error('Gemini yanıtı JSON parse hatası', { error: err.message });
      throw new Error('Ürün analizi: AI yanıtı geçersiz format');
    }
    logger.error('Ürün analizi hatası', { error: err.message });
    throw err;
  }
}

/**
 * Birden fazla fotoğrafı analiz et
 * @param {Array} images - [{ data: base64/url, mimeType }]
 * @returns {Array} Analiz sonuçları
 */
/**
 * Birden fazla fotoğrafı analiz et (max 3 eşzamanlı — API rate limit koruması)
 */
async function analyzeMultipleProducts(images, concurrency = 3) {
  const results = new Array(images.length);
  let index = 0;

  async function worker() {
    while (index < images.length) {
      const i = index++;
      try {
        const result = await analyzeProduct(images[i].data, images[i].mimeType);
        results[i] = { index: i, success: true, analysis: result };
      } catch (err) {
        results[i] = { index: i, success: false, error: err.message };
      }
    }
  }

  // concurrency kadar worker başlat
  const workers = Array.from({ length: Math.min(concurrency, images.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

module.exports = { analyzeProduct, analyzeMultipleProducts };
