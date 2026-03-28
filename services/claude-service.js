const Anthropic = require('@anthropic-ai/sdk');

let client = null;
let firestoreService = null;

// Lazy load firestore (çökmemesi için)
function getFirestore() {
  if (!firestoreService) {
    try { firestoreService = require('./firestore-service'); } catch(e) { console.log('Firestore yüklenemedi:', e.message); }
  }
  return firestoreService;
}

function getClient() {
  if (!client && process.env.ANTHROPIC_API_KEY) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

async function sendMessage(history, message) {
  const anthropic = getClient();
  if (!anthropic) {
    throw new Error('Anthropic API key ayarlanmamış. .env dosyasına ANTHROPIC_API_KEY ekleyin.');
  }

  const messages = history.map(msg => ({
    role: msg.sender === 'claude' ? 'assistant' : 'user',
    content: `[${msg.sender}]: ${msg.text}`
  }));

  messages.push({ role: 'user', content: message });

  // Firestore'dan bağlam al (hata olursa atla)
  let firestoreContext = '';
  try {
    const fs = getFirestore();
    if (fs) firestoreContext = await fs.getSystemContext();
  } catch(e) { console.log('Firestore context atlandı:', e.message); }

  const systemPrompt = `Sen PhotoReel AI projesinde çalışan Claude'sun. Gemini ile birlikte çalışıyorsun. Türkçe yanıt ver.

Geliştirici Bedrihan Özdoğan ile konuşuyorsun. Ona "Bedrihan" diye hitap et.
Kısa, öz ve faydalı cevaplar ver. Kod önerilerinde pratik ol. Gereksiz açıklama yapma.

${firestoreContext}`;

  // Circuit breaker + Shadow Learning + Metrik kaydı
  const { getBreaker } = require('../utils/circuit-breaker');
  const breaker = getBreaker('claude');
  const startTime = Date.now();

  const result = await breaker.call(async () => {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: systemPrompt,
      messages
    });
    return response.content[0].text;
  }, () => {
    return 'Claude şu an geçici olarak kullanılamıyor. Lütfen biraz sonra tekrar deneyin.';
  });

  const latency = Date.now() - startTime;

  // Fenix Brain — metrik + shadow learning
  try {
    if (global.fenixBrain) {
      global.fenixBrain.recordMetric('claude', latency, true);
      global.fenixBrain.recordShadow('claude', 'chat', { messageLength: message.length }, { responseLength: result.length, latencyMs: latency }, 'success');
    }
  } catch(e) {}

  return result;
}

function isAvailable() {
  return !!process.env.ANTHROPIC_API_KEY;
}

module.exports = { sendMessage, isAvailable };
