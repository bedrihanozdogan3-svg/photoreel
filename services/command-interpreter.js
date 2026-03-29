/**
 * Fenix AI — Komut Yorumlayıcı
 *
 * Kullanıcının doğal dildeki komutunu Gemini'ye gönderir,
 * pipeline aksiyonuna çevirir, Fenix Brain'e kaydeder.
 *
 * Örnek:
 *   "İlk 20 ürüne kırmızı arka plan ekle"
 *   → { action: "background_color", target: { range: [1,20] }, value: "red" }
 *
 *   "Müziği değiştir, daha sakin olsun"
 *   → { action: "set_music_mood", target: "all", value: "calm" }
 *
 *   "15. ürünü atla"
 *   → { action: "skip_item", target: { index: 15 } }
 */

const logger = require('../utils/logger');

// Desteklenen aksiyonlar — Fenix bunları tanır
const KNOWN_ACTIONS = [
  'background_color',    // Arka plan rengi değiştir
  'background_remove',   // Arka planı kaldır
  'set_music_mood',      // Müzik tonu ayarla (calm, energetic, dramatic)
  'set_music_bpm',       // BPM ayarla
  'set_style',           // Video stili (cinematic, minimal, bold)
  'set_language',        // Dil değiştir
  'skip_item',           // Belirli ürünü atla
  'reorder_items',       // Sırayı değiştir
  'set_speed',           // Video hızı (slow, normal, fast)
  'add_text_overlay',    // Metin katmanı ekle
  'set_lut',             // Renk filtresi uygula
  'set_duration',        // Video süresi
  'retry_item',          // Belirli ürünü yeniden üret
  'pause_queue',         // Kuyruğu durdur
  'resume_queue',        // Kuyruğu devam ettir
  'cancel_all',          // Hepsini iptal et
];

// Gemini API çağrısı
async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY eksik');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 512 }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000) // 8sn timeout
  });

  if (!res.ok) throw new Error(`Gemini API hatası: ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

/**
 * Kullanıcı komutunu pipeline aksiyonuna çevir.
 * @param {string} command - Kullanıcının yazdığı doğal dil komutu
 * @param {object} context - { totalItems, currentIndex, jobType }
 * @returns {object} - { action, target, value, confidence }
 */
async function interpret(command, context = {}) {
  const { totalItems = 0, jobType = 'video' } = context;

  const systemPrompt = `Sen Fenix AI'nin komut yorumlayıcısısın.
Kullanıcının Türkçe komutunu aşağıdaki JSON formatına çevir.
SADECE JSON döndür, başka hiçbir şey yazma.

Desteklenen aksiyonlar:
${KNOWN_ACTIONS.join(', ')}

Hedef formatı:
- "all" → tüm öğeler
- { "index": 15 } → 15. öğe
- { "range": [1, 20] } → 1-20 arası
- { "indices": [3, 7, 12] } → belirli öğeler

Bağlam:
- Toplam öğe sayısı: ${totalItems}
- İş tipi: ${jobType}

Çıktı formatı:
{
  "action": "aksiyon_adı",
  "target": "all" | { index } | { range } | { indices },
  "value": "değer (opsiyonel)",
  "confidence": 0.0-1.0,
  "explanation": "ne yapıldığının kısa açıklaması"
}

Komutu anlayamazsan:
{
  "action": "unknown",
  "confidence": 0.0,
  "explanation": "Anlaşılamadı"
}`;

  const fullPrompt = `${systemPrompt}\n\nKomut: "${command}"`;

  try {
    const raw = await callGemini(fullPrompt);

    // JSON'u çıkar
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON bulunamadı');

    const result = JSON.parse(jsonMatch[0]);

    // Aksiyon listede var mı kontrol et
    if (result.action && result.action !== 'unknown' && !KNOWN_ACTIONS.includes(result.action)) {
      logger.warn('Bilinmeyen aksiyon', { action: result.action, command });
      result.action = 'unknown';
      result.confidence = 0;
    }

    logger.info('Komut yorumlandı', {
      command: command.substring(0, 50),
      action: result.action,
      confidence: result.confidence
    });

    // Fenix Brain'e kaydet (öğrenme için)
    _recordToFenixBrain(command, result);

    return result;

  } catch(e) {
    logger.error('Komut yorumlama hatası', { error: e.message, command });
    return {
      action: 'unknown',
      confidence: 0,
      explanation: 'Yorumlama hatası: ' + e.message
    };
  }
}

/**
 * Yorumlanan komutu Fenix Brain'e kaydet.
 * Zamanla benzer komutları daha hızlı tanır.
 */
function _recordToFenixBrain(command, result) {
  try {
    const fenixBrain = require('./fenix-brain');
    if (typeof fenixBrain.recordShadow === 'function') {
      fenixBrain.recordShadow({
        task: 'command_interpret',
        input: command,
        output: result.action,
        confidence: result.confidence,
        success: result.action !== 'unknown'
      });
    }
  } catch(e) { /* Fenix Brain yoksa sessizce geç */ }
}

/**
 * Birden fazla komutu sırayla işle.
 * "Müziği değiştir ve arka planı beyaz yap"
 * → [set_music_mood, background_color]
 */
async function interpretMultiple(commands, context = {}) {
  const parts = commands.split(/\s*(?:ve|,|;)\s*/i).filter(Boolean);
  const results = [];
  for (const cmd of parts) {
    const r = await interpret(cmd.trim(), context);
    if (r.action !== 'unknown') results.push(r);
  }
  return results;
}

/**
 * Pipeline'a aksiyon uygula.
 * Queue'daki jobları günceller.
 */
async function applyToQueue(action, userId) {
  const queue = require('./queue-service');
  const jobs = await queue.getUserJobs(userId);
  const pending = jobs.filter(j => j.status === 'pending' || j.status === 'processing');

  if (action.action === 'pause_queue') {
    // Bekleyen işleri paused yap
    for (const job of pending) {
      await queue._update(job.id, { status: 'paused' });
    }
    return { affected: pending.length, message: 'Kuyruk durduruldu' };
  }

  if (action.action === 'cancel_all') {
    for (const job of pending) {
      await queue.cancelJob(job.id);
    }
    return { affected: pending.length, message: 'Tüm işler iptal edildi' };
  }

  if (action.action === 'skip_item' && action.target?.index) {
    const idx = action.target.index - 1;
    if (pending[idx]) {
      await queue.cancelJob(pending[idx].id);
      return { affected: 1, message: `${action.target.index}. öğe atlandı` };
    }
  }

  // Diğer aksiyonlar — payload güncelleme
  let affected = 0;
  const targets = _resolveTargets(action.target, pending);
  for (const job of targets) {
    const update = _buildPayloadUpdate(action, job.payload);
    if (update) {
      await queue._update(job.id, { payload: { ...job.payload, ...update } });
      affected++;
    }
  }

  return { affected, message: action.explanation || `${action.action} uygulandı` };
}

function _resolveTargets(target, jobs) {
  if (!target || target === 'all') return jobs;
  if (target.index !== undefined) return [jobs[target.index - 1]].filter(Boolean);
  if (target.range) return jobs.slice(target.range[0] - 1, target.range[1]);
  if (target.indices) return target.indices.map(i => jobs[i - 1]).filter(Boolean);
  return jobs;
}

function _buildPayloadUpdate(action, currentPayload) {
  const updates = {};
  switch(action.action) {
    case 'background_color': updates.backgroundColor = action.value; break;
    case 'background_remove': updates.removeBackground = true; break;
    case 'set_music_mood': updates.musicMood = action.value; break;
    case 'set_music_bpm': updates.bpm = parseInt(action.value); break;
    case 'set_style': updates.style = action.value; break;
    case 'set_language': updates.language = action.value; break;
    case 'set_speed': updates.speed = action.value; break;
    case 'add_text_overlay': updates.textOverlay = action.value; break;
    case 'set_lut': updates.lut = action.value; break;
    case 'set_duration': updates.duration = parseInt(action.value); break;
    default: return null;
  }
  return updates;
}

module.exports = { interpret, interpretMultiple, applyToQueue, KNOWN_ACTIONS };
