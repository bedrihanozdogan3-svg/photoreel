/**
 * Fenix AI — Kod Denetçisi (Code Reviewer)
 * Gemini ile değişen dosyaları otomatik analiz eder.
 * Bug, eksiklik, hata riski tespit eder ve bildirim yapar.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const REVIEW_HISTORY_FILE = path.join(PROJECT_ROOT, 'data', 'review-history.json');

// Son review'ları kaydet
function loadHistory() {
  try {
    if (fs.existsSync(REVIEW_HISTORY_FILE)) return JSON.parse(fs.readFileSync(REVIEW_HISTORY_FILE, 'utf-8'));
  } catch(e) {}
  return { reviews: [], lastCheck: null };
}

function saveHistory(history) {
  try {
    const dir = path.dirname(REVIEW_HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(REVIEW_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch(e) { logger.error('Review history kaydetme hatası', { error: e.message }); }
}

// Dosya değişikliklerini bul (son N dakika)
function getRecentlyChangedFiles(minutesAgo) {
  minutesAgo = minutesAgo || 30;
  const cutoff = Date.now() - minutesAgo * 60 * 1000;
  const changed = [];
  const BLOCKED = ['node_modules', '.git', 'package-lock.json', 'backups', 'data', '.claude'];

  function scan(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (BLOCKED.some(b => full.includes(b))) continue;
        if (e.isDirectory()) { scan(full); continue; }
        if (!/\.(js|html|json|css)$/.test(e.name)) continue;
        try {
          const stat = fs.statSync(full);
          if (stat.mtimeMs > cutoff) {
            changed.push({
              path: path.relative(PROJECT_ROOT, full).replace(/\\/g, '/'),
              modified: stat.mtime.toISOString(),
              size: stat.size
            });
          }
        } catch(e2) {}
      }
    } catch(e) {}
  }

  scan(PROJECT_ROOT);
  return changed.sort((a, b) => new Date(b.modified) - new Date(a.modified));
}

// Gemini ile kod review yap
async function reviewFiles(files, geminiKey) {
  if (!files.length) return { issues: [], message: 'Değişen dosya yok' };
  if (!geminiKey) return { issues: [], message: 'Gemini API key gerekli' };

  // Dosya içeriklerini oku (max 200KB toplam)
  let totalSize = 0;
  const fileContents = [];
  for (const f of files.slice(0, 5)) { // Max 5 dosya
    try {
      const full = path.join(PROJECT_ROOT, f.path);
      const content = fs.readFileSync(full, 'utf-8');
      if (totalSize + content.length > 200000) break;
      totalSize += content.length;
      fileContents.push({ path: f.path, content: content.substring(0, 50000) });
    } catch(e) {}
  }

  const prompt = `Sen bir senior code reviewer'sın. Aşağıdaki dosyaları incele ve SADECE JSON döndür.

Bul:
1. BUGLAR — runtime hata verebilecek yerler (null reference, undefined, async sorunları)
2. GÜVENLİK — XSS, injection, API key exposure
3. MANTIK HATALARI — yanlış çalışan logic
4. EKSİKLER — try/catch eksik, edge case kontrolü yok
5. PERFORMANS — bellek sızıntısı riski

JSON formatı:
{
  "issues": [
    {"severity": "critical|warning|info", "file": "dosya.js", "line": 42, "message": "Sorun açıklaması", "fix": "Çözüm önerisi"}
  ],
  "summary": "Genel değerlendirme (1 cümle)"
}

Max 10 issue bul. Gereksiz şeyleri atlat, sadece gerçek sorunları bildir.

DOSYALAR:
${fileContents.map(f => `\n═══ ${f.path} ═══\n${f.content}`).join('\n')}`;

  try {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
      })
    });

    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);

    const text = data.candidates[0].content.parts[0].text;
    // JSON çıkar
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      // Geçmişe kaydet
      const history = loadHistory();
      history.reviews.unshift({
        timestamp: new Date().toISOString(),
        files: files.map(f => f.path),
        issueCount: result.issues.length,
        summary: result.summary
      });
      if (history.reviews.length > 50) history.reviews = history.reviews.slice(0, 50);
      history.lastCheck = new Date().toISOString();
      saveHistory(history);

      return result;
    }
    return { issues: [], summary: text.substring(0, 200) };
  } catch(e) {
    return { issues: [], message: 'Review hatası: ' + e.message };
  }
}

// Otomatik review — değişen dosyaları bul ve review et
async function autoReview(geminiKey, minutesAgo) {
  const changed = getRecentlyChangedFiles(minutesAgo || 30);
  if (!changed.length) return { issues: [], message: 'Son 30 dakikada değişen dosya yok' };
  logger.info('Kod review başlatılıyor', { fileCount: changed.length, files: changed.map(f => f.path) });
  return reviewFiles(changed, geminiKey);
}

module.exports = { reviewFiles, autoReview, getRecentlyChangedFiles, loadHistory };
