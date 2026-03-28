/**
 * Fenix AI — Kullanıcı Kimlik Doğrulama Servisi
 * Email tabanlı basit auth: API key ile kimlik doğrulama.
 * Firestore'a yazar, erişilemezse bellek fallback kullanır.
 */

const crypto = require('crypto');
const logger = require('../utils/logger');
const config = require('../config');

let db = null;
let firestoreAvailable = false;

// Firestore lazy init (state-service ile aynı pattern)
function getDb() {
  if (db) return db;
  try {
    const { Firestore } = require('@google-cloud/firestore');
    db = new Firestore({ projectId: config.firestoreProjectId });
    firestoreAvailable = true;
    return db;
  } catch (e) {
    logger.warn('Auth: Firestore bağlanamadı, bellek fallback aktif', { error: e.message });
    firestoreAvailable = false;
    return null;
  }
}

// === BELLEK FALLBACK ===
const memoryUsers = {};
// apiKey → userId hızlı lookup
const memoryApiKeyIndex = {};

const COLLECTION = 'users';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(email) {
  return EMAIL_REGEX.test(email);
}

/**
 * Yeni kullanıcı kaydı
 */
async function registerUser(email, name) {
  if (!email || !validateEmail(email)) {
    throw new Error('Geçerli bir email adresi gerekli');
  }
  if (!name || name.trim().length < 2) {
    throw new Error('İsim en az 2 karakter olmalı');
  }

  email = email.toLowerCase().trim();
  name = name.trim();

  // Mevcut kullanıcı kontrolü
  const existing = await findUserByEmail(email);
  if (existing) {
    throw new Error('Bu email ile kayıtlı bir kullanıcı zaten var');
  }

  const userId = crypto.randomUUID();
  const apiKey = crypto.randomUUID();
  const now = new Date().toISOString();

  const user = {
    userId,
    email,
    name,
    apiKey,
    plan: 'free',
    quota: { free: 5, used: 0, plan: 'free' },
    createdAt: now,
    lastLoginAt: now
  };

  const firestore = getDb();
  if (firestore) {
    try {
      await firestore.collection(COLLECTION).doc(userId).set(user);
      logger.info('Yeni kullanıcı kaydedildi', { userId, email });
    } catch (e) {
      logger.error('Kullanıcı kayıt hatası (Firestore)', { email, error: e.message });
    }
  }

  // Bellek fallback her zaman güncelle
  memoryUsers[userId] = user;
  memoryApiKeyIndex[apiKey] = userId;

  return { userId, email, name, apiKey, quota: user.quota };
}

/**
 * Email ile giriş
 */
async function loginUser(email) {
  if (!email || !validateEmail(email)) {
    throw new Error('Geçerli bir email adresi gerekli');
  }

  email = email.toLowerCase().trim();
  const user = await findUserByEmail(email);
  if (!user) {
    throw new Error('Bu email ile kayıtlı kullanıcı bulunamadı');
  }

  // lastLoginAt güncelle
  user.lastLoginAt = new Date().toISOString();
  const firestore = getDb();
  if (firestore) {
    try {
      await firestore.collection(COLLECTION).doc(user.userId).update({ lastLoginAt: user.lastLoginAt });
    } catch (e) {
      logger.error('Login güncelleme hatası', { userId: user.userId, error: e.message });
    }
  }
  memoryUsers[user.userId] = user;

  return {
    userId: user.userId,
    email: user.email,
    name: user.name,
    apiKey: user.apiKey,
    quota: user.quota
  };
}

/**
 * API key ile kullanıcı bul
 */
async function getUserByApiKey(apiKey) {
  if (!apiKey) return null;

  // Önce Firestore'da ara
  const firestore = getDb();
  if (firestore) {
    try {
      const snap = await firestore.collection(COLLECTION)
        .where('apiKey', '==', apiKey)
        .limit(1)
        .get();
      if (!snap.empty) {
        const user = snap.docs[0].data();
        // Belleği de güncelle
        memoryUsers[user.userId] = user;
        memoryApiKeyIndex[apiKey] = user.userId;
        return user;
      }
    } catch (e) {
      logger.error('API key lookup hatası', { error: e.message });
    }
  }

  // Bellek fallback
  const userId = memoryApiKeyIndex[apiKey];
  return userId ? memoryUsers[userId] || null : null;
}

/**
 * Kullanıcı video kota güncelleme
 */
async function updateUserQuota(userId, videoCount = 1) {
  const user = await getUserProfile(userId);
  if (!user) {
    throw new Error('Kullanıcı bulunamadı');
  }

  const quota = user.quota || { free: 5, used: 0, plan: 'free' };
  quota.used = (quota.used || 0) + videoCount;

  const firestore = getDb();
  if (firestore) {
    try {
      await firestore.collection(COLLECTION).doc(userId).update({ quota });
    } catch (e) {
      logger.error('Kota güncelleme hatası', { userId, error: e.message });
    }
  }

  if (memoryUsers[userId]) {
    memoryUsers[userId].quota = quota;
  }

  return quota;
}

/**
 * Kullanıcı profili getir
 */
async function getUserProfile(userId) {
  if (!userId) return null;

  const firestore = getDb();
  if (firestore) {
    try {
      const doc = await firestore.collection(COLLECTION).doc(userId).get();
      if (doc.exists) {
        const user = doc.data();
        memoryUsers[userId] = user;
        return user;
      }
    } catch (e) {
      logger.error('Profil okuma hatası', { userId, error: e.message });
    }
  }

  return memoryUsers[userId] || null;
}

/**
 * Email ile kullanıcı bul (dahili)
 */
async function findUserByEmail(email) {
  const firestore = getDb();
  if (firestore) {
    try {
      const snap = await firestore.collection(COLLECTION)
        .where('email', '==', email)
        .limit(1)
        .get();
      if (!snap.empty) {
        const user = snap.docs[0].data();
        memoryUsers[user.userId] = user;
        memoryApiKeyIndex[user.apiKey] = user.userId;
        return user;
      }
    } catch (e) {
      logger.error('Email lookup hatası', { email, error: e.message });
    }
  }

  // Bellek fallback
  return Object.values(memoryUsers).find(u => u.email === email) || null;
}

module.exports = {
  registerUser,
  loginUser,
  getUserByApiKey,
  updateUserQuota,
  getUserProfile,
  validateEmail
};
