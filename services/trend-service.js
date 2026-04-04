/**
 * Fenix AI — Trend Öğrenme Servisi (FAZA 5)
 * trends_db.json'dan ürüne uygun trend müzik, geçiş, efekt seçer.
 * Haftalık trend raporu üretir.
 * Instagram/TikTok caption + hashtag üretir.
 * Tüm kararları Fenix brain'e loglar.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

let _trendsCache = null;
let _trendsLoadedAt = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 saat

function loadTrends() {
  if (_trendsCache && Date.now() - _trendsLoadedAt < CACHE_TTL) return _trendsCache;
  try {
    const raw = fs.readFileSync(path.join(__dirname, '../public/trends_db.json'), 'utf8');
    _trendsCache = JSON.parse(raw);
    _trendsLoadedAt = Date.now();
    return _trendsCache;
  } catch(e) {
    logger.warn('Trend DB yüklenemedi', { error: e.message });
    return null;
  }
}

/**
 * 5.1 — Ürüne uygun trend müzik + geçiş + efekt seç
 * @param {string} productType — ürün kategorisi (taki, kozmetik, giyim, vb.)
 * @param {string} platform — 'instagram' | 'tiktok' | 'both'
 * @param {string} mood — 'enerjik' | 'sofistike' | 'sicak' | 'cool'
 */
function getTrendForProduct(productType, platform = 'both', mood = null) {
  const db = loadTrends();
  if (!db) return null;

  // Kategori eşleştirme
  const categoryMap = {
    ayakkabi: 'ayakkabi', canta: 'taki', saat: 'taki', gozluk: 'taki',
    altin: 'taki', elmas: 'taki', telefon: 'elektronik', bilgisayar: 'elektronik',
    giyim: 'giyim', kozmetik: 'kozmetik', yemek: 'yemek', diger: 'genel'
  };
  const cat = categoryMap[productType] || productType;
  const musicData = db.trendMusic?.[cat] || db.trendMusic?.genel;

  if (!musicData) return null;

  // Platform filtrele
  let songs = musicData.songs || [];
  if (platform !== 'both') {
    songs = songs.filter(s => s.platform === platform || s.platform === 'both');
  }
  if (!songs.length) songs = musicData.songs;

  // Mood filtrele (varsa)
  if (mood) {
    const moodKeywords = {
      enerjik: ['energetic', 'powerful', 'dynamic', 'fast', 'catchy', 'confident'],
      sofistike: ['elegant', 'luxury', 'cinematic', 'theatrical', 'classic'],
      sicak: ['warm', 'cozy', 'romantic', 'peaceful', 'dreamy'],
      cool: ['cool', 'urban', 'aesthetic', 'atmospheric', 'retro']
    };
    const keywords = moodKeywords[mood] || [];
    if (keywords.length) {
      const moodSongs = songs.filter(s => keywords.some(k => (s.vibe || '').includes(k)));
      if (moodSongs.length) songs = moodSongs;
    }
  }

  // Popülerliğe göre sırala, en üstten seç (biraz rastgelelik)
  songs.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  const topN = Math.min(5, songs.length);
  const selected = songs[Math.floor(Math.random() * topN)];

  // Geçişler
  const transitions = musicData.transitions || ['fade', 'zoom'];
  const selectedTransition = transitions[Math.floor(Math.random() * transitions.length)];

  // Efekt önerisi
  const effectMap = {
    taki: 'parlama', kozmetik: 'flu-arkaplan', ayakkabi: 'mikro-titresim',
    elektronik: 'sinematik', giyim: 'ken-burns', yemek: 'buhar'
  };
  const suggestedEffect = effectMap[cat] || 'sinematik';

  // Trend hızı / enerji
  const isAgressive = selected.bpm > 110;
  const isCalm = selected.bpm < 80;

  const result = {
    music: {
      name: selected.name,
      artist: selected.artist,
      bpm: selected.bpm,
      vibe: selected.vibe,
      commercial: selected.commercial
    },
    transition: selectedTransition,
    effect: suggestedEffect,
    tempo: isAgressive ? 'hizli' : isCalm ? 'yavas' : 'orta',
    category: cat,
    platform,
    dbDate: db.lastUpdated
  };

  // Fenix'e öğret
  _logTrend('trend_selection', result, productType);

  return result;
}

/**
 * 5.2 — Instagram/TikTok caption + hashtag üret
 * @param {Object} analysis — ürün analizi
 * @param {string} platform — 'instagram' | 'tiktok'
 */
async function generateCaption(analysis, platform = 'instagram') {
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

    const productName = analysis.product_name || analysis.product_type || 'ürün';
    const mood = analysis.audience_mood || 'profesyonel';

    let prompt;
    if (platform === 'instagram') {
      prompt = `Bir ${productName} ürünü için Instagram Reels açıklaması yaz.
Stil: ${mood}, estetik, merak uyandırıcı.
Format: 1-2 cümle açıklama + 10 popüler hashtag.
DİL: Türkçe.
SADECE JSON döndür: { "caption": "...", "hashtags": ["#tag1", "#tag2", ...] }`;
    } else {
      prompt = `Bir ${productName} ürünü için TikTok video açıklaması yaz.
Stil: Kısa, merak uyandırıcı, CTA (harekete geçirici).
Format: 1 cümle + 5 hashtag.
DİL: Türkçe.
SADECE JSON döndür: { "caption": "...", "hashtags": ["#tag1", "#tag2", ...] }`;
    }

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const caption = JSON.parse(jsonMatch[0]);
      _logTrend('caption_generation', { platform, productType: analysis.product_type, caption }, analysis.product_type);
      return caption;
    }
  } catch(e) {
    logger.warn('Caption üretimi başarısız', { error: e.message });
  }

  // Fallback
  return {
    caption: platform === 'instagram'
      ? `Bu ürünü keşfet ✨ Kalite ve şıklık bir arada.`
      : `Bunu bilmeden geçme! 👀`,
    hashtags: ['#fenixai', '#trend', '#viral', '#kesfet', '#urun']
  };
}

/**
 * 5.1 — Haftalık trend raporu
 */
function getWeeklyTrendReport() {
  const db = loadTrends();
  if (!db) return null;

  const report = {
    date: new Date().toISOString().slice(0, 10),
    dbDate: db.lastUpdated,
    sources: db.sources,
    categories: {},
    topGlobal: []
  };

  // Her kategori için top 3 şarkı
  for (const [cat, data] of Object.entries(db.trendMusic || {})) {
    const songs = (data.songs || []).sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    report.categories[cat] = {
      topSongs: songs.slice(0, 3).map(s => ({ name: s.name, artist: s.artist, bpm: s.bpm, popularity: s.popularity })),
      transitions: data.transitions || [],
      dominantVibe: _extractDominantVibe(songs)
    };
  }

  // Global top 5
  const allSongs = [];
  for (const data of Object.values(db.trendMusic || {})) {
    (data.songs || []).forEach(s => {
      if (!allSongs.find(x => x.name === s.name)) allSongs.push(s);
    });
  }
  allSongs.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  report.topGlobal = allSongs.slice(0, 5);

  // Trend yönü
  const avgBpm = allSongs.reduce((s, x) => s + (x.bpm || 0), 0) / (allSongs.length || 1);
  report.trendDirection = avgBpm > 100 ? 'hızlı/agresif' : avgBpm < 80 ? 'yavaş/rahatlatıcı' : 'orta/dengeli';

  return report;
}

function _extractDominantVibe(songs) {
  const vibes = {};
  songs.forEach(s => {
    (s.vibe || '').split(' ').forEach(w => {
      if (w.length > 3) vibes[w] = (vibes[w] || 0) + 1;
    });
  });
  return Object.entries(vibes).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
}

function _logTrend(task, data, productType) {
  try {
    const fenixBrain = require('./fenix-brain');
    if (fenixBrain && fenixBrain.logShadow) {
      fenixBrain.logShadow({ task, productType, ...data });
    }
  } catch(e) {}
}

module.exports = { getTrendForProduct, generateCaption, getWeeklyTrendReport, loadTrends };
