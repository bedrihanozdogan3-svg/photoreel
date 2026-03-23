const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-2.5-flash';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

async function sendMessage(history, message) {
  const contents = history.map(msg => ({
    role: msg.sender === 'gemini' ? 'model' : 'user',
    parts: [{ text: `[${msg.sender}]: ${msg.text}` }]
  }));

  contents.push({
    role: 'user',
    parts: [{ text: message }]
  });

  const payload = {
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192
    },
    systemInstruction: {
      parts: [{ text: 'Sen PhotoReel AI projesinde çalışan Gemini\'sin. Claude ile birlikte çalışıyorsun. Türkçe yanıt ver.' }]
    }
  };

  const res = await fetch(API_URL, {
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
