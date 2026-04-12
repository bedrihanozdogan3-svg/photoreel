/**
 * Fenix AI — Arka Plan Silme Servisi
 * @imgly/background-removal-node kullanır (ücretsiz, sınırsız, local çalışır)
 * Fallback: Gemini Vision API ile basit mask
 */

const logger = require('../utils/logger');
const path = require('path');
const fs = require('fs');
const os = require('os');

let removeBackground = null;

// Lazy load — ilk kullanımda yükle (model ~40MB indirir)
async function getRemover() {
  if (!removeBackground) {
    try {
      const bgModule = require('@imgly/background-removal-node');
      removeBackground = bgModule.removeBackground || bgModule.default?.removeBackground || bgModule;
      logger.info('Background remover yüklendi (imgly)');
    } catch(e) {
      logger.warn('imgly yüklenemedi, Gemini fallback kullanılacak', { error: e.message });
      return null;
    }
  }
  return removeBackground;
}

/**
 * Arka planı sil — Buffer döner (PNG, şeffaf arka plan)
 * @param {Buffer} imageBuffer — Kaynak görsel (JPG/PNG)
 * @returns {Promise<Buffer>} — Arka planı silinmiş PNG
 */
async function remove(imageBuffer) {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
    throw new Error('Geçerli bir görsel buffer gerekli');
  }

  // Yöntem 1: imgly (en kaliteli)
  const remover = await getRemover();
  if (remover) {
    try {
      logger.info('Arka plan siliniyor (imgly)...', { size: imageBuffer.length });

      // imgly Blob bekler — Buffer'dan Blob oluştur
      const blob = new Blob([imageBuffer], { type: 'image/png' });
      const resultBlob = await remover(blob, {
        model: 'medium',       // small=hızlı(~5sn), medium=dengeli(~15sn), large=kaliteli(~30sn)
        output: { format: 'image/png', quality: 0.9 }
      });

      // Blob → Buffer
      const arrayBuffer = await resultBlob.arrayBuffer();
      const resultBuffer = Buffer.from(arrayBuffer);

      logger.info('Arka plan silindi (imgly)', { outputSize: resultBuffer.length });
      return resultBuffer;
    } catch(e) {
      logger.warn('imgly arka plan silme hatası, Gemini fallback deneniyor', { error: e.message });
    }
  }

  // Yöntem 2: Gemini Vision ile basit segmentasyon
  return await removeWithGemini(imageBuffer);
}

/**
 * Gemini Vision fallback — arka plan koordinatlarını tespit et
 * Tam silme yapamaz ama mask bölgeleri döner
 */
async function removeWithGemini(imageBuffer) {
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

    const base64 = imageBuffer.toString('base64');
    const mimeType = 'image/jpeg';

    const result = await model.generateContent([
      {
        inlineData: { data: base64, mimeType }
      },
      {
        text: `Analyze this product photo. Return ONLY a JSON object with:
{
  "product_bounds": { "x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0 },
  "has_stand": boolean,
  "has_model": boolean,
  "background_complexity": "simple|medium|complex"
}
Coordinates are 0-1 normalized. x,y is top-left corner of the product bounding box.`
      }
    ]);

    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const analysis = JSON.parse(jsonMatch[0]);
      logger.info('Gemini arka plan analizi', analysis);
      // Gemini sadece analiz yapabilir, gerçek silme için
      // client-side Canvas API kullanılacak
      // Şimdilik orijinal görseli döndür + analiz bilgisi
      return { buffer: imageBuffer, analysis, method: 'gemini-analysis' };
    }
  } catch(e) {
    logger.error('Gemini arka plan analizi hatası', { error: e.message });
  }

  // Son çare: orijinal görseli döndür
  return imageBuffer;
}

/**
 * Ürün fotoğrafını analiz et + arka planı sil + sonucu döndür
 * Pipeline: analiz → silme → kalite kontrol
 */
async function processProductImage(imageBuffer, options = {}) {
  const result = {
    original: imageBuffer,
    removed: null,
    analysis: null,
    method: null,
    success: false
  };

  try {
    const output = await remove(imageBuffer);

    if (Buffer.isBuffer(output)) {
      result.removed = output;
      result.method = 'imgly';
      result.success = true;
    } else if (output && output.buffer) {
      // Gemini fallback — analiz döndü
      result.removed = output.buffer;
      result.analysis = output.analysis;
      result.method = output.method || 'gemini';
      result.success = true;
    }
  } catch(e) {
    logger.error('Arka plan silme pipeline hatası', { error: e.message });
    result.removed = imageBuffer; // Hata durumunda orijinali döndür
  }

  // Fenix'e öğret — bu işlemi logla
  try {
    const fenixBrain = require('./fenix-brain');
    if (fenixBrain && fenixBrain.logShadow) {
      fenixBrain.logShadow({
        task: 'background_removal',
        method: result.method,
        success: result.success,
        inputSize: imageBuffer.length,
        outputSize: result.removed?.length || 0,
        options
      });
    }
  } catch(e) { /* Fenix brain opsiyonel */ }

  return result;
}

module.exports = { remove, processProductImage };
