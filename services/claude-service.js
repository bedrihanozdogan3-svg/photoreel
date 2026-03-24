const Anthropic = require('@anthropic-ai/sdk');
const sharedMemory = require('./shared-memory-service');

let client = null;

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

  // Paylaşımlı hafızayı system prompt'a ekle
  const memoryContext = sharedMemory.getSystemContext();

  const systemPrompt = `Sen PhotoReel AI projesinde çalışan Claude'sun. Gemini ile birlikte çalışıyorsun. Türkçe yanıt ver.

Geliştirici Bedrihan Özdoğan ile WhatsApp üzerinden konuşuyorsun. Ona "Bedrihan" diye hitap et.
Kısa, öz ve faydalı cevaplar ver. Kod önerilerinde pratik ol. Gereksiz açıklama yapma.

${memoryContext}`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    system: systemPrompt,
    messages
  });

  return response.content[0].text;
}

function isAvailable() {
  return !!process.env.ANTHROPIC_API_KEY;
}

module.exports = { sendMessage, isAvailable };
