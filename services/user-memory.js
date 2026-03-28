/**
 * Fenix AI — Kullanıcı Hafızası
 * Her kullanıcının marka kimliği, stil tercihleri, geçmiş seçimlerini Firestore'da saklar.
 * Fenix bu veriyle kişiselleştirilmiş video üretir.
 */

const logger = require('../utils/logger');
const config = require('../config');

let _db = null;
function getDb() {
  if (_db) return _db;
  try {
    const { Firestore } = require('@google-cloud/firestore');
    _db = new Firestore({ projectId: config.firestoreProjectId });
    return _db;
  } catch(e) { return null; }
}

const COLLECTION = 'user-profiles';

// Bellek fallback
const memoryCache = {};

/**
 * Kullanıcı profilini al
 */
async function getProfile(userId) {
  // Önce cache
  if (memoryCache[userId]) return memoryCache[userId];

  const db = getDb();
  if (db) {
    try {
      const doc = await db.collection(COLLECTION).doc(userId).get();
      if (doc.exists) {
        memoryCache[userId] = doc.data();
        return doc.data();
      }
    } catch(e) { logger.error('Profil okuma hatası', { userId, error: e.message }); }
  }

  // Yeni kullanıcı — varsayılan profil
  return createDefaultProfile(userId);
}

/**
 * Kullanıcı profilini güncelle (merge)
 */
async function updateProfile(userId, updates) {
  const profile = await getProfile(userId);
  const merged = { ...profile, ...updates, updatedAt: new Date().toISOString() };
  memoryCache[userId] = merged;

  const db = getDb();
  if (db) {
    try {
      await db.collection(COLLECTION).doc(userId).set(merged);
    } catch(e) { logger.error('Profil kaydetme hatası', { userId, error: e.message }); }
  }

  return merged;
}

/**
 * Marka kimliği kaydet
 */
async function saveBrandIdentity(userId, brand) {
  return updateProfile(userId, {
    brand: {
      name: brand.name || null,
      slogan: brand.slogan || null,
      logo: brand.logo || null,          // base64 veya URL
      primaryColor: brand.primaryColor || null,
      secondaryColor: brand.secondaryColor || null,
      font: brand.font || null,
      outroName: brand.outroName || brand.name || null,
      outroSlogan: brand.outroSlogan || brand.slogan || null,
    }
  });
}

/**
 * Stil tercihlerini kaydet (video beğenilerinden öğrenilen)
 */
async function saveStylePreferences(userId, prefs) {
  const profile = await getProfile(userId);
  const existing = profile.stylePreferences || {};

  return updateProfile(userId, {
    stylePreferences: {
      ...existing,
      ...prefs,
      // Favori geçişler (array merge)
      favoriteTransitions: [...new Set([...(existing.favoriteTransitions || []), ...(prefs.favoriteTransitions || [])])].slice(-20),
      // Favori müzik tag'leri
      favoriteMusicTags: [...new Set([...(existing.favoriteMusicTags || []), ...(prefs.favoriteMusicTags || [])])].slice(-10),
      // Kaçınılan stiller
      avoidTransitions: [...new Set([...(existing.avoidTransitions || []), ...(prefs.avoidTransitions || [])])].slice(-20),
    }
  });
}

/**
 * Kullanıcının video geçmişini kaydet
 */
async function addVideoToHistory(userId, videoMeta) {
  const profile = await getProfile(userId);
  const history = profile.videoHistory || [];
  history.push({
    ...videoMeta,
    createdAt: new Date().toISOString()
  });
  // Son 100 video
  if (history.length > 100) history.splice(0, history.length - 100);

  return updateProfile(userId, { videoHistory: history, totalVideos: history.length });
}

/**
 * Kullanıcının AI prompt'una eklenecek bağlam oluştur
 */
async function getPromptContext(userId) {
  const profile = await getProfile(userId);
  let ctx = '';

  if (profile.brand?.name) {
    ctx += `\nKullanıcı markası: ${profile.brand.name}`;
    if (profile.brand.slogan) ctx += ` — "${profile.brand.slogan}"`;
    if (profile.brand.primaryColor) ctx += `\nMarka rengi: ${profile.brand.primaryColor}`;
  }

  const prefs = profile.stylePreferences;
  if (prefs) {
    if (prefs.favoriteTransitions?.length) ctx += `\nFavori geçişler: ${prefs.favoriteTransitions.slice(-5).join(', ')}`;
    if (prefs.preferredFormat) ctx += `\nTercih edilen format: ${prefs.preferredFormat}`;
    if (prefs.preferredMood) ctx += `\nTercih edilen ruh hali: ${prefs.preferredMood}`;
  }

  if (profile.totalVideos) ctx += `\nToplam üretilen video: ${profile.totalVideos}`;

  return ctx;
}

function createDefaultProfile(userId) {
  return {
    userId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    brand: { name: null, slogan: null, logo: null, primaryColor: null, secondaryColor: null, font: null },
    stylePreferences: { favoriteTransitions: [], favoriteMusicTags: [], avoidTransitions: [], preferredFormat: 'reels', preferredMood: null },
    videoHistory: [],
    totalVideos: 0,
    segment: null, // 'ecommerce' | 'moto' | 'sport' | 'creator'
  };
}

module.exports = {
  getProfile,
  updateProfile,
  saveBrandIdentity,
  saveStylePreferences,
  addVideoToHistory,
  getPromptContext,
};
