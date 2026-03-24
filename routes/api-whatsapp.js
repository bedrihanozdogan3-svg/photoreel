const express = require('express');
const geminiService = require('../services/gemini-service');
const claudeService = require('../services/claude-service');

const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || 'photoreel_verify_2026';
const WA_TOKEN = process.env.WA_ACCESS_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_NUMBER_ID;
const ADMIN_PHONE = process.env.ADMIN_PHONE || '905309070098';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'bedrihanozdogan3-svg/photoreel';

// Kullanıcı dil tercihleri (telefon numarasına göre)
const userLangs = {};
// Kullanıcı bazlı konuşma geçmişi
const userHistories = {};
// Onay bekleyen işlemler
const pendingApprovals = {};
// Engellenen numaralar
const blockedNumbers = new Set();
// Mesaj hız limiti (spam koruması)
const rateLimits = {};
const RATE_LIMIT_MAX = 20; // dakikada max mesaj
const RATE_LIMIT_WINDOW = 60000; // 1 dakika

// Dil tespiti - basit anahtar kelime bazlı
function detectLanguage(text) {
  const turkishWords = /[çğıöşüÇĞİÖŞÜ]|merhaba|nasıl|selam|teşekkür|evet|hayır|tamam|nedir|yapay|zeka/i;
  const englishWords = /\b(hello|hi|how|what|yes|no|please|thank|the|is|are|can|will)\b/i;
  if (turkishWords.test(text)) return 'tr';
  if (englishWords.test(text)) return 'en';
  return null;
}

function getLangPrompt(lang) {
  if (lang === 'tr') return 'Türkçe yanıt ver.';
  if (lang === 'en') return 'Respond in English.';
  return 'Kullanıcının dilinde yanıt ver. Detect the language and respond accordingly.';
}

function getHelpText(lang) {
  if (lang === 'en') {
    return `📖 PhotoReel AI WhatsApp Commands:\n\n` +
      `💬 Chat:\n` +
      `• gemini: question → Ask Gemini\n` +
      `• claude: question → Ask Claude\n` +
      `• both: question → Ask both\n\n` +
      `💻 Code:\n` +
      `• /code file.js → View file code\n` +
      `• /review file.js → Review & find bugs\n` +
      `• /fix file.js description → Fix a bug\n` +
      `• /files → List all files\n\n` +
      `⚙️ Settings:\n` +
      `• /lang tr → Switch to Turkish\n` +
      `• /lang en → Switch to English\n` +
      `• /status → System status\n` +
      `• /help → This menu\n\n` +
      `Example: /review server.js`;
  }
  return `📖 PhotoReel AI WhatsApp Komutları:\n\n` +
    `💬 Sohbet:\n` +
    `• gemini: soru → Gemini'ye sor\n` +
    `• claude: soru → Claude'a sor\n` +
    `• ikisine: soru → Her ikisine sor\n\n` +
    `💻 Kod:\n` +
    `• /kod dosya.js → Dosya kodunu gör\n` +
    `• /incele dosya.js → Hataları bul\n` +
    `• /düzelt dosya.js açıklama → Bug düzelt\n` +
    `• /dosyalar → Tüm dosyaları listele\n\n` +
    `⚙️ Ayarlar:\n` +
    `• /dil tr → Türkçe'ye geç\n` +
    `• /dil en → İngilizce'ye geç\n` +
    `• /durum → Sistem durumu\n` +
    `• /yardım → Bu menü\n\n` +
    `Örnek: /incele server.js`;
}

// Hız limiti kontrolü
function checkRateLimit(from) {
  const now = Date.now();
  if (!rateLimits[from]) rateLimits[from] = [];
  rateLimits[from] = rateLimits[from].filter(t => now - t < RATE_LIMIT_WINDOW);
  if (rateLimits[from].length >= RATE_LIMIT_MAX) return false;
  rateLimits[from].push(now);
  return true;
}

// GitHub dosya okuma
async function readGitHubFile(filepath) {
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filepath}`;
    const headers = { 'Accept': 'application/vnd.github.v3+json' };
    if (GITHUB_TOKEN) headers['Authorization'] = `token ${GITHUB_TOKEN}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch(e) {
    return null;
  }
}

// GitHub dosya listesi
async function listGitHubFiles(dirPath) {
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${dirPath || ''}`;
    const headers = { 'Accept': 'application/vnd.github.v3+json' };
    if (GITHUB_TOKEN) headers['Authorization'] = `token ${GITHUB_TOKEN}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return [];
    const data = await res.json();
    let files = [];
    for (const item of data) {
      if (item.type === 'file') files.push(item.path);
      else if (item.type === 'dir' && !item.name.startsWith('.') && item.name !== 'node_modules') {
        const subFiles = await listGitHubFiles(item.path);
        files = files.concat(subFiles);
      }
    }
    return files;
  } catch(e) {
    return [];
  }
}

module.exports = function(io) {
  const router = express.Router();

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
      const from = msg.from;
      const isAdmin = from === ADMIN_PHONE || from === ADMIN_PHONE.replace(/^0/, '');

      // Engellenen numara kontrolü
      if (blockedNumbers.has(from) && !isAdmin) {
        return;
      }

      // Hız limiti kontrolü
      if (!isAdmin && !checkRateLimit(from)) {
        await sendWhatsAppMessage(from, '⚠️ Çok fazla mesaj gönderdiniz. Lütfen 1 dakika bekleyin.');
        return;
      }

      let text = '';

      // Sesli mesaj desteği
      if (msg.type === 'audio' || msg.type === 'voice') {
        text = '[Sesli mesaj alındı - henüz yazıya çevirme aktif değil. Lütfen metin olarak gönderin.]';
        await sendWhatsAppMessage(from, '🎤 Sesli mesaj desteği yakında! Şimdilik metin olarak gönderin.');
        return;
      }

      // Görsel mesaj desteği
      if (msg.type === 'image') {
        text = '[Görsel alındı - PhotoReel görsel işleme yakında aktif olacak.]';
        await sendWhatsAppMessage(from, '📸 Görsel işleme yakında! Şimdilik metin komutları kullanın.\n/yardım yazarak komutları görebilirsiniz.');
        return;
      }

      // Sadece metin mesajları
      if (msg.type !== 'text') return;
      text = msg.text.body;

      console.log(`WhatsApp mesaj: ${from} ${isAdmin ? '(ADMIN)' : ''} -> ${text}`);

      // Kullanıcı geçmişi oluştur
      if (!userHistories[from]) userHistories[from] = [];
      const history = userHistories[from];

      // Dil tespiti - ilk mesajda otomatik, sonra /dil komutuyla
      if (!userLangs[from]) {
        const detected = detectLanguage(text);
        userLangs[from] = detected || 'tr';
      }
      const lang = userLangs[from];
      const langPrompt = getLangPrompt(lang);

      // Dashboard'a bildir
      if (io) {
        const label = isAdmin ? '[WhatsApp-Admin]' : '[WhatsApp]';
        io.emit('message', { sender: 'user', text: `${label} ${text}`, timestamp: new Date().toISOString() });
      }

      let response = '';
      const lowerText = text.toLowerCase().trim();

      // Dil değiştirme komutu
      if (lowerText.startsWith('/dil ') || lowerText.startsWith('/lang ')) {
        const newLang = lowerText.split(' ')[1];
        if (newLang === 'tr' || newLang === 'en') {
          userLangs[from] = newLang;
          response = newLang === 'tr' ? '✅ Dil Türkçe olarak ayarlandı.' : '✅ Language set to English.';
        } else {
          response = lang === 'tr' ? '❌ Desteklenen diller: tr, en' : '❌ Supported languages: tr, en';
        }
      }
      // Gemini'ye gönder
      else if (lowerText.startsWith('/gemini ') || lowerText.startsWith('gemini:')) {
        const question = text.replace(/^\/gemini\s+/i, '').replace(/^gemini:\s*/i, '');
        history.push({ sender: 'user', text: question });
        response = await geminiService.sendMessage(history, `${langPrompt}\n\n${question}`);
        history.push({ sender: 'gemini', text: response });
        response = `🟢 Gemini:\n${response}`;
      }
      // Claude'a gönder
      else if (lowerText.startsWith('/claude ') || lowerText.startsWith('claude:')) {
        if (!claudeService.isAvailable()) {
          response = lang === 'tr' ? '❌ Claude API henüz aktif değil.' : '❌ Claude API is not active yet.';
        } else {
          const question = text.replace(/^\/claude\s+/i, '').replace(/^claude:\s*/i, '');
          history.push({ sender: 'user', text: question });
          response = await claudeService.sendMessage(history, `${langPrompt}\n\n${question}`);
          history.push({ sender: 'claude', text: response });
          response = `🔵 Claude:\n${response}`;
        }
      }
      // Her ikisine gönder
      else if (lowerText.startsWith('/her ') || lowerText.startsWith('ikisine:') || lowerText.startsWith('both:')) {
        const question = text.replace(/^\/her\s+/i, '').replace(/^ikisine:\s*/i, '').replace(/^both:\s*/i, '');
        history.push({ sender: 'user', text: question });

        let geminiRes = '', claudeRes = '';
        try {
          geminiRes = await geminiService.sendMessage(history, `${langPrompt}\n\n${question}`);
          history.push({ sender: 'gemini', text: geminiRes });
        } catch(e) { geminiRes = 'Hata: ' + e.message; }

        if (claudeService.isAvailable()) {
          try {
            claudeRes = await claudeService.sendMessage(history, `${langPrompt}\n\n${question}`);
            history.push({ sender: 'claude', text: claudeRes });
          } catch(e) { claudeRes = 'Hata: ' + e.message; }
        }

        response = `🟢 Gemini:\n${geminiRes}`;
        if (claudeRes) response += `\n\n🔵 Claude:\n${claudeRes}`;
      }
      // Dosya listele
      else if (lowerText === '/dosyalar' || lowerText === '/files') {
        const files = await listGitHubFiles('');
        if (files.length > 0) {
          response = `📁 Proje Dosyaları:\n\n${files.map(f => `• ${f}`).join('\n')}`;
        } else {
          response = lang === 'tr' ? '❌ Dosyalar okunamadı.' : '❌ Could not read files.';
        }
      }
      // Kod görüntüle
      else if (lowerText.startsWith('/kod ') || lowerText.startsWith('/code ')) {
        const filename = text.split(' ').slice(1).join(' ').trim();
        const content = await readGitHubFile(filename);
        if (content) {
          const preview = content.length > 3000 ? content.substring(0, 3000) + '\n\n... (kısaltıldı)' : content;
          response = `📄 ${filename}:\n\`\`\`\n${preview}\n\`\`\``;
        } else {
          response = lang === 'tr' ? `❌ "${filename}" bulunamadı. /dosyalar ile dosya listesine bakın.` : `❌ "${filename}" not found.`;
        }
      }
      // Kod incele / review
      else if (lowerText.startsWith('/incele ') || lowerText.startsWith('/review ')) {
        const filename = text.split(' ').slice(1).join(' ').trim();
        const content = await readGitHubFile(filename);
        if (content) {
          const reviewPrompt = `${langPrompt}\n\nBu kodu incele, hataları ve iyileştirme önerilerini listele:\n\n${content}`;
          history.push({ sender: 'user', text: `${filename} dosyasını incele` });
          response = await geminiService.sendMessage(history, reviewPrompt);
          history.push({ sender: 'gemini', text: response });
          response = `🔍 ${filename} İnceleme:\n\n${response}`;
        } else {
          response = lang === 'tr' ? `❌ "${filename}" bulunamadı.` : `❌ "${filename}" not found.`;
        }
      }
      // Kod düzelt / fix
      else if (lowerText.startsWith('/düzelt ') || lowerText.startsWith('/fix ')) {
        const parts = text.split(' ').slice(1);
        const filename = parts[0];
        const description = parts.slice(1).join(' ') || 'Hataları düzelt';
        const content = await readGitHubFile(filename);
        if (content) {
          const fixPrompt = `${langPrompt}\n\nBu koddaki sorunu düzelt: ${description}\n\nDosya: ${filename}\n\n${content}\n\nDüzeltilmiş kodu ve ne değiştiğini açıkla.`;
          history.push({ sender: 'user', text: `${filename}: ${description}` });
          response = await geminiService.sendMessage(history, fixPrompt);
          history.push({ sender: 'gemini', text: response });
          response = `🔧 ${filename} Düzeltme:\n\n${response}`;

          // Admin'e onay gönder
          if (isAdmin) {
            response += '\n\n⚠️ Değişikliği uygulamak için "evet" yazın.';
            pendingApprovals[from] = { filename, fix: response, timestamp: Date.now() };
          }
        } else {
          response = lang === 'tr' ? `❌ "${filename}" bulunamadı.` : `❌ "${filename}" not found.`;
        }
      }
      // Sistem durumu
      else if (lowerText === '/durum' || lowerText === '/status') {
        const geminiOk = !!process.env.GEMINI_API_KEY;
        const claudeOk = claudeService.isAvailable();
        const waOk = !!WA_TOKEN;
        response = `📊 Sistem Durumu:\n\n` +
          `🟢 Gemini: ${geminiOk ? 'Aktif' : 'Pasif'}\n` +
          `${claudeOk ? '🔵' : '⚪'} Claude: ${claudeOk ? 'Aktif' : 'Kredi gerekli'}\n` +
          `🟢 WhatsApp: ${waOk ? 'Aktif' : 'Pasif'}\n` +
          `🟢 Sunucu: Çalışıyor\n` +
          `📱 Admin: ${isAdmin ? 'Evet (sen)' : 'Hayır'}`;
      }
      // Yardım
      else if (lowerText === '/yardım' || lowerText === '/help') {
        response = getHelpText(lang);
      }
      // Admin onay sistemi
      else if (isAdmin && (lowerText === 'evet' || lowerText === 'yes' || lowerText === 'onay')) {
        response = lang === 'tr' ? '✅ Onay alındı. İşlem uygulanacak.' : '✅ Approved. Changes will be applied.';
        if (io) io.emit('admin_approval', { approved: true, timestamp: new Date().toISOString() });
      }
      else if (isAdmin && (lowerText === 'hayır' || lowerText === 'no' || lowerText === 'reddet')) {
        response = lang === 'tr' ? '❌ Reddedildi. Değişiklik uygulanmayacak.' : '❌ Rejected. Changes will not be applied.';
        if (io) io.emit('admin_approval', { approved: false, timestamp: new Date().toISOString() });
      }
      // Varsayılan: Gemini'ye gönder
      else {
        history.push({ sender: 'user', text: text });
        response = await geminiService.sendMessage(history, `${langPrompt}\n\n${text}`);
        history.push({ sender: 'gemini', text: response });
        response = `🟢 Gemini:\n${response}`;
      }

      // Geçmişi sınırla (son 20 mesaj)
      if (history.length > 20) {
        userHistories[from] = history.slice(-20);
      }

      // Dashboard'a bildir
      if (io) {
        io.emit('message', { sender: 'system', text: `[WhatsApp cevap gönderildi]`, timestamp: new Date().toISOString() });
      }

      await sendWhatsAppMessage(from, response);

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

// Admin'e onay mesajı gönder
async function sendApprovalRequest(summary) {
  const msg = `🔔 Onay Gerekli!\n\n${summary}\n\n✅ "evet" → Onayla\n❌ "hayır" → Reddet`;
  await sendWhatsAppMessage(ADMIN_PHONE, msg);
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  while (text.length > 0) {
    let end = maxLen;
    if (text.length > maxLen) {
      const lastNewline = text.lastIndexOf('\n', maxLen);
      if (lastNewline > maxLen * 0.5) end = lastNewline;
    }
    chunks.push(text.substring(0, end));
    text = text.substring(end).trim();
  }
  return chunks;
}

module.exports.sendApprovalRequest = sendApprovalRequest;
