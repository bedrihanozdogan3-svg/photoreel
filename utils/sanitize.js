/**
 * Fenix AI — Veri Sanitizasyon
 * XSS ve injection koruması için metin temizleme.
 */

// HTML entity encoding — XSS koruması
function escapeHtml(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// Terminal çıktısı için sanitize
function sanitizeTerminalOutput(text) {
  if (typeof text !== 'string') return '';
  // Max uzunluk
  const trimmed = text.substring(0, 10000);
  // HTML encoding
  return escapeHtml(trimmed);
}

// Kullanıcı girişi sanitize (genel)
function sanitizeInput(text) {
  if (typeof text !== 'string') return '';
  return text.substring(0, 5000).trim();
}

// Log mesajlarından hassas veri maskeleme
function maskSensitive(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/sk-ant-[a-zA-Z0-9\-_]{20,}/g, 'sk-ant-***MASKED***')
    .replace(/AIzaSy[a-zA-Z0-9\-_]{30,}/g, 'AIzaSy***MASKED***')
    .replace(/eyJ[a-zA-Z0-9\-_]{20,}\.[a-zA-Z0-9\-_]{20,}\.[a-zA-Z0-9\-_]{20,}/g, 'JWT-***MASKED***');
}

module.exports = { escapeHtml, sanitizeTerminalOutput, sanitizeInput, maskSensitive };
