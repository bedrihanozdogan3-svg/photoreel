let firestoreService = null;

// Lazy load firestore (çökmemesi için)
function getFirestore() {
  if (!firestoreService) {
    try { firestoreService = require('./firestore-service'); } catch(e) { console.log('Firestore yüklenemedi:', e.message); }
  }
  return firestoreService;
}

const MODEL = 'gemini-2.5-flash';

function getApiUrl() {
  const key = process.env.GEMINI_API_KEY;
  return `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`;
}

async function sendMessage(history, message) {
  const contents = history.map(msg => ({
    role: msg.sender === 'gemini' ? 'model' : 'user',
    parts: [{ text: `[${msg.sender}]: ${msg.text}` }]
  }));

  contents.push({
    role: 'user',
    parts: [{ text: message }]
  });

  // Firestore'dan bağlam al (hata olursa atla)
  let firestoreContext = '';
  try {
    const fs = getFirestore();
    if (fs) firestoreContext = await fs.getSystemContext();
  } catch(e) { console.log('Firestore context atlandı:', e.message); }

  const systemText = `Sen PhotoReel AI projesinde çalışan Gemini'sin. Claude ile birlikte çalışıyorsun. Türkçe yanıt ver.

Geliştirici Bedrihan Özdoğan ile WhatsApp üzerinden konuşuyorsun. Ona "Bedrihan" diye hitap et.
Kısa, öz ve faydalı cevaplar ver. Kod önerilerinde pratik ol. Gereksiz açıklama yapma.

${firestoreContext}`;

  const payload = {
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192
    },
    systemInstruction: {
      parts: [{ text: systemText }]
    }
  };

  const res = await fetch(getApiUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await res.json();

  if (data.error) {
    throw new Error(data.error.message || 'Gemini API hatası');
  }

  return data.candidates[0].content.parts[0].text;
}

module.exports = { sendMessage };
