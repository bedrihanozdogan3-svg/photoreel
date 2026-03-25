/**
 * Fenix AI — JWT Yardımcıları
 * Token oluşturma ve doğrulama.
 */

const jwt = require('jsonwebtoken');
const config = require('../config');

function generateToken(payload, expiresIn = '24h') {
  return jwt.sign(payload, config.jwtSecret, { expiresIn });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch (e) {
    return null;
  }
}

// API key doğrulama (basit — ileride DB'den çekilecek)
function generateApiKey(userId) {
  return generateToken({ userId, type: 'api_key' }, '365d');
}

module.exports = { generateToken, verifyToken, generateApiKey };
