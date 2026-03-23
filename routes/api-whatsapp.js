const express = require('express');
const geminiService = require('../services/gemini-service');
const claudeService = require('../services/claude-service');

const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || 'photoreel_verify_2026';
const WA_TOKEN = process.env.WA_ACCESS_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_NUMBER_ID;

module.exports = function(io) {
  const router = express.Router();
  const history = [];

  // Webhook verification (Meta sends GET request)
  router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WhatsApp webhook doğrulandı');
      return res.status(200).send(challenge);
    }
    res.sendStatus(403);
  });

  // Incoming messages
  router.post('/', async (req, res) => {
    // Always respond 200 quickly to Meta
    res.sendStatus(200);

    try {
      const body = req.body;
      if (!body.object || body.object !== 'whatsapp_business_account') return;

      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const messages = value?.messages;

      if (!messages || !messages.length) return;

      const msg = messages[0];
      if (msg.type !== 'text') return;

      const from = msg.from; // sender phone number
      const text = msg.text.body;

      console.log(`WhatsApp mesaj: ${from} -> ${text}`);

      // Dashboard'a bildir
      if (io) {
        io.emit('message', { sender: 'user', text: `[WhatsApp] ${text}`, timestamp: new Date().toISOString() });
      }

      // Komutu parse et
      let response = '';
      const lowerText = text.toLowerCase().trim();

      if (lowerText.startsWith('/gemini ') || lowerText.startsWith('gemini:')) {
        // Gemini'ye gönder
        const question = text.replace(/^\/gemini\s+/i, '').replace(/^gemini:\s*/i, '');
        history.push({ sender: 'user', text: question });
        response = await geminiService.sendMessage(history, question);
        history.push({ sender: 'gemini', text: response });
        response = `🟢 Gemini:\n${response}`;
      } else if (lowerText.startsWith('/claude ') || lowerText.startsWith('claude:')) {
        // Claude'a gönder
        if (!claudeService.isAvailable()) {
          response = '❌ Claude API henüz aktif değil.';
        } else {
          const question = text.replace(/^\/claude\s+/i, '').replace(/^claude:\s*/i, '');
          history.push({ sender: 'user', text: question });
          response = await claudeService.sendMessage(history, question);
          history.push({ sender: 'claude', text: response });
          response = `🔵 Claude:\n${response}`;
        }
      } else if (lowerText.startsWith('/her ') || lowerText.startsWith('ikisine:')) {
        // Her ikisine gönder
        const question = text.replace(/^\/her\s+/i, '').replace(/^ikisine:\s*/i, '');
        history.push({ sender: 'user', text: question });

        let geminiRes = '', claudeRes = '';
        try {
          geminiRes = await geminiService.sendMessage(history, question);
          history.push({ sender: 'gemini', text: geminiRes });
        } catch(e) { geminiRes = 'Hata: ' + e.message; }

        if (claudeService.isAvailable()) {
          try {
            claudeRes = await claudeService.sendMessage(history, question);
            history.push({ sender: 'claude', text: claudeRes });
          } catch(e) { claudeRes = 'Hata: ' + e.message; }
        }

        response = `🟢 Gemini:\n${geminiRes}`;
        if (claudeRes) response += `\n\n🔵 Claude:\n${claudeRes}`;
      } else if (lowerText === '/yardım' || lowerText === '/help') {
        response = `📖 PhotoReel AI WhatsApp Komutları:\n\n` +
          `• gemini: soru → Gemini'ye sor\n` +
          `• claude: soru → Claude'a sor\n` +
          `• ikisine: soru → Her ikisine sor\n` +
          `• /yardım → Bu menü\n\n` +
          `Örnek: gemini: PhotoReel için trend analizi yap`;
      } else {
        // Varsayılan: Gemini'ye gönder
        history.push({ sender: 'user', text: text });
        response = await geminiService.sendMessage(history, text);
        history.push({ sender: 'gemini', text: response });
        response = `🟢 Gemini:\n${response}`;
      }

      // Dashboard'a bildir
      if (io) {
        io.emit('message', { sender: 'system', text: `[WhatsApp cevap gönderildi]`, timestamp: new Date().toISOString() });
      }

      // WhatsApp'a cevap gönder
      await sendWhatsAppMessage(from, response);

      // Mesaj çok uzunsa böl
    } catch(err) {
      console.error('WhatsApp hata:', err.message);
    }
  });

  return router;
};

// WhatsApp mesaj gönderme
async function sendWhatsAppMessage(to, text) {
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.log('WhatsApp token/phone ID eksik, mesaj gönderilemedi');
    return;
  }

  // WhatsApp 4096 karakter sınırı var, uzun mesajları böl
  const chunks = splitMessage(text, 4000);

  for (const chunk of chunks) {
    try {
      await fetch(`https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${WA_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: to,
          type: 'text',
          text: { body: chunk }
        })
      });
    } catch(err) {
      console.error('WhatsApp gönderim hatası:', err.message);
    }
  }
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  while (text.length > 0) {
    let end = maxLen;
    if (text.length > maxLen) {
      // Son satır sonunu bul
      const lastNewline = text.lastIndexOf('\n', maxLen);
      if (lastNewline > maxLen * 0.5) end = lastNewline;
    }
    chunks.push(text.substring(0, end));
    text = text.substring(end).trim();
  }
  return chunks;
}
