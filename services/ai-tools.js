/**
 * Fenix AI — Tool Calling Sistemi
 * AI'ların (Claude/Gemini) güvenli bir şekilde araç çağırmasını sağlar.
 * Her araç beyaz listede olmalı, girişi doğrulanmalı.
 *
 * Fenix'in otonom gücünün temeli.
 */

const logger = require('../utils/logger');
const Joi = require('joi');

// Kayıtlı araçlar (beyaz liste)
const tools = {};

/**
 * Yeni araç kaydet.
 * @param {string} name - Araç adı
 * @param {object} options - { description, inputSchema (Joi), handler (async fn), requiresApproval }
 */
function registerTool(name, options) {
  if (!options.handler || typeof options.handler !== 'function') {
    throw new Error(`Tool '${name}' için handler gerekli`);
  }

  tools[name] = {
    name,
    description: options.description || '',
    inputSchema: options.inputSchema || null,
    handler: options.handler,
    requiresApproval: options.requiresApproval || false,
    callCount: 0,
    lastCalledAt: null
  };

  logger.info('AI tool kaydedildi', { name, requiresApproval: options.requiresApproval || false });
}

/**
 * Araç çağır (AI tarafından kullanılır).
 * @param {string} name - Araç adı
 * @param {object} input - Girdi parametreleri
 * @param {string} caller - Çağıran AI ('claude', 'gemini', 'fenix')
 * @returns {object} { success, result, error }
 */
async function callTool(name, input = {}, caller = 'unknown') {
  const tool = tools[name];

  if (!tool) {
    logger.warn('Bilinmeyen tool çağrısı engellendi', { name, caller });
    return { success: false, error: `Araç bulunamadı: ${name}` };
  }

  // Input validasyonu
  if (tool.inputSchema) {
    const { error, value } = tool.inputSchema.validate(input, { stripUnknown: true });
    if (error) {
      logger.warn('Tool input validasyon hatası', { name, caller, error: error.message });
      return { success: false, error: 'Geçersiz girdi: ' + error.details.map(d => d.message).join(', ') };
    }
    input = value;
  }

  // Onay gerektiren araçlar
  if (tool.requiresApproval) {
    logger.info('Tool onay bekliyor', { name, caller });
    return { success: false, error: 'Bu araç onay gerektiriyor', requiresApproval: true, toolName: name, input };
  }

  // Çalıştır
  try {
    logger.info('Tool çağrılıyor', { name, caller, input: JSON.stringify(input).substring(0, 200) });
    const result = await tool.handler(input, caller);
    tool.callCount++;
    tool.lastCalledAt = new Date().toISOString();
    logger.info('Tool başarılı', { name, caller });
    return { success: true, result };
  } catch (err) {
    logger.error('Tool hatası', { name, caller, error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Mevcut araçların listesini döndür (AI'ya gösterilecek format).
 */
function getToolList() {
  return Object.values(tools).map(t => ({
    name: t.name,
    description: t.description,
    requiresApproval: t.requiresApproval,
    callCount: t.callCount
  }));
}

// === VARSAYILAN ARAÇLAR ===

// Güvenli araçlar (onay gerektirmez)
registerTool('getSystemTime', {
  description: 'Sunucu saatini döndürür',
  handler: async () => ({ time: new Date().toISOString() })
});

registerTool('getQuotaStatus', {
  description: 'API kota durumunu döndürür',
  handler: async () => {
    return global.quotaTracker || { error: 'Kota bilgisi yok' };
  }
});

registerTool('analyzeProduct', {
  description: 'Ürün fotoğrafını analiz eder (kategori, renk, yapı)',
  inputSchema: Joi.object({
    imageUrl: Joi.string().uri().required(),
    options: Joi.object({
      detectCategory: Joi.boolean().default(true),
      detectColor: Joi.boolean().default(true),
      detectDefects: Joi.boolean().default(false)
    }).default()
  }),
  handler: async (input) => {
    // Placeholder — Gemini Vision API entegrasyonu gelecek
    return { status: 'pending', message: 'Ürün analiz modülü henüz aktif değil', input };
  }
});

// Tehlikeli araçlar (onay gerektirir)
registerTool('executeCommand', {
  description: 'Sunucuda komut çalıştırır (onay gerektirir)',
  requiresApproval: true,
  inputSchema: Joi.object({
    command: Joi.string().max(500).required()
  }),
  handler: async (input) => {
    return { status: 'blocked', message: 'Bu araç henüz aktif değil' };
  }
});

module.exports = { registerTool, callTool, getToolList };
