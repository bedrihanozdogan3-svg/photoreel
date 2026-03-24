const express = require('express');
const geminiService = require('../services/gemini-service');
const claudeService = require('../services/claude-service');

// Twilio config
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WA_NUMBER = process.env.TWILIO_WA_NUMBER || 'whatsapp:+14155238886';
const ADMIN_PHONE = process.env.ADMIN_PHONE || '905309070098';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'bedrihanozdogan3-svg/photoreel';

let twilioClient = null;
function getTwilio() {
  if (!twilioClient && TWILIO_SID && TWILIO_AUTH) {
    const twilio = require('twilio');
    twilioClient = twilio(TWILIO_SID, TWILIO_AUTH);
  }
  return twilioClient;
}

// Kullanici dil tercihleri
const userLangs = {};
const userHistories = {};
const pendingApprovals = {};
const blockedNumbers = new Set();
const rateLimits = {};
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW = 60000;

function detectLanguage(text) {
  const turkishWords = /[cgiosuCGIOSU\u00e7\u011f\u0131\u00f6\u015f\u00fc\u00c7\u011e\u0130\u00d6\u015e\u00dc]|merhaba|nas\u0131l|selam|te\u015fekkür|evet|hay\u0131r|tamam|nedir|yapay|zeka/i;
  const englishWords = /\b(hello|hi|how|what|yes|no|please|thank|the|is|are|can|will)\b/i;
  if (turkishWords.test(text)) return 'tr';
  if (englishWords.test(text)) return 'en';
  return null;
}

function getLangPrompt(lang) {
  if (lang === 'tr') return 'Turkce yanit ver.';
  if (lang === 'en') return 'Respond in English.';
  return 'Kullanicinin dilinde yanit ver.';
}

function getHelpText(lang) {
  if (lang === 'en') {
    return `📖 PhotoReel AI WhatsApp Commands:\n\n` +
      `💬 Chat:\n` +
      `• gemini: question → Ask Gemini\n` +
      `• claude: question → Ask Claude\n` +
      `• both: question → Ask both\n\n` +
      `💻 Code:\n` +
      `• /code file.js → View file\n` +
      `• /review file.js → Review & find bugs\n` +
      `• /fix file.js desc → Fix a bug\n` +
      `• /files → List all files\n\n` +
      `⚙️ Settings:\n` +
      `• /lang tr|en → Change language\n` +
      `• /status → System status\n` +
      `• /help → This menu`;
  }
  return `📖 PhotoReel AI WhatsApp Komutlari:\n\n` +
    `💬 Sohbet:\n` +
    `• gemini: soru → Gemini'ye sor\n` +
    `• claude: soru → Claude'a sor\n` +
    `• ikisine: soru → Her ikisine sor\n\n` +
    `💻 Kod:\n` +
    `• /kod dosya.js → Dosya kodunu gor\n` +
    `• /incele dosya.js → Hatalari bul\n` +
    `• /duzelt dosya.js aciklama → Bug duzelt\n` +
    `• /dosyalar → Tum dosyalari listele\n\n` +
    `⚙️ Ayarlar:\n` +
    `• /dil tr|en → Dil degistir\n` +
    `• /durum → Sistem durumu\n` +
    `• /yardim → Bu menu`;
}

function checkRateLimit(from) {
  const now = Date.now();
  if (!rateLimits[from]) rateLimits[from] = [];
  rateLimits[from] = rateLimits[from].filter(t => now - t < RATE_LIMIT_WINDOW);
  if (rateLimits[from].length >= RATE_LIMIT_MAX) return false;
  rateLimits[from].push(now);
  return true;
}

async function readGitHubFile(filepath) {
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${filepath}`;
    const headers = { 'Accept': 'application/vnd.github.v3+json' };
    if (GITHUB_TOKEN) headers['Authorization'] = `token ${GITHUB_TOKEN}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch(e) { return null; }
}

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
  } catch(e) { return []; }
}

// Twilio ile mesaj gonder
async function sendWhatsAppMessage(to, text) {
  const client = getTwilio();
  if (!client) {
    console.log('Twilio client yok - SID:', TWILIO_SID ? 'VAR' : 'YOK', 'AUTH:', TWILIO_AUTH ? 'VAR' : 'YOK');
    return;
  }

  // Twilio WhatsApp formati: whatsapp:+905309070098
  const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:+${to.replace(/^\+/, '')}`;

  const chunks = splitMessage(text, 1500);

  for (const chunk of chunks) {
    try {
      const msg = await client.messages.create({
        from: TWILIO_WA_NUMBER,
        to: toFormatted,
        body: chunk
      });
      console.log(`WhatsApp mesaj gonderildi: ${to} (SID: ${msg.sid})`);
    } catch(err) {
      console.error('Twilio gonderim hatasi:', err.message, err.code, err.status);
    }
  }
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

module.exports = function(io) {
  const router = express.Router();

  // Meta webhook verification (eski uyumluluk)
  router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === (process.env.WA_VERIFY_TOKEN || 'photoreel_verify_2026')) {
      return res.status(200).send(challenge);
    }
    res.sendStatus(200);
  });

  // Twilio webhook - gelen mesajlar
  router.post('/', async (req, res) => {
    // Twilio'ya hemen 200 don
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');

    try {
      const body = req.body;

      // Twilio formati mi kontrol et
      let from, text, msgType = 'text';

      if (body.From && body.From.startsWith('whatsapp:')) {
        // TWILIO FORMATI
        from = body.From.replace('whatsapp:+', '');
        text = body.Body || '';
        msgType = body.NumMedia > 0 ? 'media' : 'text';
        console.log(`[TWILIO] WhatsApp mesaj: ${from} -> ${text}`);
      }
      else if (body.object === 'whatsapp_business_account') {
        // META FORMATI (eski uyumluluk)
        const entry = body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const messages = value?.messages;
        if (!messages || !messages.length) return;
        const msg = messages[0];
        from = msg.from;
        if (msg.type === 'text') text = msg.text.body;
        else { msgType = msg.type; text = ''; }
        console.log(`[META] WhatsApp mesaj: ${from} -> ${text}`);
      }
      else {
        console.log('Bilinmeyen webhook formati:', JSON.stringify(body).substring(0, 200));
        return;
      }

      if (!from || !text) return;

      const isAdmin = from === ADMIN_PHONE || from === ADMIN_PHONE.replace(/^0/, '');

      // Engellenen numara
      if (blockedNumbers.has(from) && !isAdmin) return;

      // Hiz limiti
      if (!isAdmin && !checkRateLimit(from)) {
        await sendWhatsAppMessage(from, '⚠️ Cok fazla mesaj gonderdiniz. 1 dakika bekleyin.');
        return;
      }

      // Medya mesaji
      if (msgType !== 'text' && msgType !== 'media') return;
      if (msgType === 'media' && !text) {
        await sendWhatsAppMessage(from, '📸 Gorsel/ses isleme yakinda! Simdilik metin kullanin.\n/yardim yazarak komutlari gorebilirsiniz.');
        return;
      }

      console.log(`WhatsApp mesaj isleniyor: ${from} ${isAdmin ? '(ADMIN)' : ''} -> ${text}`);

      // Kullanici gecmisi
      if (!userHistories[from]) userHistories[from] = [];
      const history = userHistories[from];

      // Dil tespiti
      if (!userLangs[from]) {
        const detected = detectLanguage(text);
        userLangs[from] = detected || 'tr';
      }
      const lang = userLangs[from];
      const langPrompt = getLangPrompt(lang);

      // Dashboard bildir
      if (io) {
        const label = isAdmin ? '[WhatsApp-Admin]' : '[WhatsApp]';
        io.emit('message', { sender: 'user', text: `${label} ${text}`, timestamp: new Date().toISOString() });
      }

      let response = '';
      const lowerText = text.toLowerCase().trim();

      // === KOMUTLAR ===

      // Dil degistir
      if (lowerText.startsWith('/dil ') || lowerText.startsWith('/lang ')) {
        const newLang = lowerText.split(' ')[1];
        if (newLang === 'tr' || newLang === 'en') {
          userLangs[from] = newLang;
          response = newLang === 'tr' ? '✅ Dil Turkce olarak ayarlandi.' : '✅ Language set to English.';
        } else {
          response = '❌ Desteklenen diller: tr, en';
        }
      }
      // Gemini
      else if (lowerText.startsWith('/gemini ') || lowerText.startsWith('gemini:')) {
        const question = text.replace(/^\/gemini\s+/i, '').replace(/^gemini:\s*/i, '');
        history.push({ sender: 'user', text: question });
        response = await geminiService.sendMessage(history, `${langPrompt}\n\n${question}`);
        history.push({ sender: 'gemini', text: response });
        response = `🟢 Gemini:\n${response}`;
      }
      // Claude
      else if (lowerText.startsWith('/claude ') || lowerText.startsWith('claude:')) {
        if (!claudeService.isAvailable()) {
          response = '❌ Claude API henuz aktif degil. Kredi gerekli.';
        } else {
          const question = text.replace(/^\/claude\s+/i, '').replace(/^claude:\s*/i, '');
          history.push({ sender: 'user', text: question });
          response = await claudeService.sendMessage(history, `${langPrompt}\n\n${question}`);
          history.push({ sender: 'claude', text: response });
          response = `🔵 Claude:\n${response}`;
        }
      }
      // Her ikisi
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
        response = files.length > 0 ? `📁 Proje Dosyalari:\n\n${files.map(f => `• ${f}`).join('\n')}` : '❌ Dosyalar okunamadi.';
      }
      // Kod goruntule
      else if (lowerText.startsWith('/kod ') || lowerText.startsWith('/code ')) {
        const filename = text.split(' ').slice(1).join(' ').trim();
        const content = await readGitHubFile(filename);
        if (content) {
          const preview = content.length > 1400 ? content.substring(0, 1400) + '\n\n... (kisaltildi)' : content;
          response = `📄 ${filename}:\n\n${preview}`;
        } else {
          response = `❌ "${filename}" bulunamadi. /dosyalar ile bakin.`;
        }
      }
      // Kod incele
      else if (lowerText.startsWith('/incele ') || lowerText.startsWith('/review ')) {
        const filename = text.split(' ').slice(1).join(' ').trim();
        const content = await readGitHubFile(filename);
        if (content) {
          const reviewPrompt = `${langPrompt}\n\nBu kodu incele, hatalari ve iyilestirme onerilerini listele:\n\n${content}`;
          history.push({ sender: 'user', text: `${filename} dosyasini incele` });
          response = await geminiService.sendMessage(history, reviewPrompt);
          history.push({ sender: 'gemini', text: response });
          response = `🔍 ${filename} Inceleme:\n\n${response}`;
        } else {
          response = `❌ "${filename}" bulunamadi.`;
        }
      }
      // Kod duzelt
      else if (lowerText.startsWith('/duzelt ') || lowerText.startsWith('/fix ')) {
        const parts = text.split(' ').slice(1);
        const filename = parts[0];
        const description = parts.slice(1).join(' ') || 'Hatalari duzelt';
        const content = await readGitHubFile(filename);
        if (content) {
          const fixPrompt = `${langPrompt}\n\nBu koddaki sorunu duzelt: ${description}\n\nDosya: ${filename}\n\n${content}\n\nDuzeltilmis kodu ve ne degistigini acikla.`;
          history.push({ sender: 'user', text: `${filename}: ${description}` });
          response = await geminiService.sendMessage(history, fixPrompt);
          history.push({ sender: 'gemini', text: response });
          response = `🔧 ${filename} Duzeltme:\n\n${response}`;
          if (isAdmin) {
            response += '\n\n⚠️ Degisikligi uygulamak icin "evet" yazin.';
            pendingApprovals[from] = { filename, fix: response, timestamp: Date.now() };
          }
        } else {
          response = `❌ "${filename}" bulunamadi.`;
        }
      }
      // Durum
      else if (lowerText === '/durum' || lowerText === '/status') {
        const geminiOk = !!process.env.GEMINI_API_KEY;
        const claudeOk = claudeService.isAvailable();
        const twilioOk = !!getTwilio();
        response = `📊 Sistem Durumu:\n\n` +
          `🟢 Gemini: ${geminiOk ? 'Aktif' : 'Pasif'}\n` +
          `${claudeOk ? '🔵' : '⚪'} Claude: ${claudeOk ? 'Aktif' : 'Kredi gerekli'}\n` +
          `🟢 WhatsApp (Twilio): ${twilioOk ? 'Aktif' : 'Pasif'}\n` +
          `🟢 Sunucu: Calisiyor\n` +
          `📱 Admin: ${isAdmin ? 'Evet (sen)' : 'Hayir'}`;
      }
      // Yardim
      else if (lowerText === '/yardim' || lowerText === '/help') {
        response = getHelpText(lang);
      }
      // Admin onay
      else if (isAdmin && (lowerText === 'evet' || lowerText === 'yes' || lowerText === 'onay')) {
        response = '✅ Onay alindi. Islem uygulanacak.';
        if (io) io.emit('admin_approval', { approved: true, timestamp: new Date().toISOString() });
      }
      else if (isAdmin && (lowerText === 'hayir' || lowerText === 'no' || lowerText === 'reddet')) {
        response = '❌ Reddedildi. Degisiklik uygulanmayacak.';
        if (io) io.emit('admin_approval', { approved: false, timestamp: new Date().toISOString() });
      }
      // Varsayilan: Gemini
      else {
        history.push({ sender: 'user', text: text });
        response = await geminiService.sendMessage(history, `${langPrompt}\n\n${text}`);
        history.push({ sender: 'gemini', text: response });
        response = `🟢 Gemini:\n${response}`;
      }

      // Gecmisi sinirla
      if (history.length > 20) {
        userHistories[from] = history.slice(-20);
      }

      // Dashboard bildir
      if (io) {
        io.emit('message', { sender: 'system', text: `[WhatsApp cevap gonderildi]`, timestamp: new Date().toISOString() });
      }

      await sendWhatsAppMessage(from, response);

    } catch(err) {
      console.error('WhatsApp GENEL hata:', err.message, err.stack);
      try {
        const from = req.body?.From?.replace('whatsapp:+', '') || req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
        if (from) await sendWhatsAppMessage(from, '❌ Bir hata olustu. Lutfen tekrar deneyin.');
      } catch(e) {}
    }
  });

  return router;
};

async function sendApprovalRequest(summary) {
  const msg = `🔔 Onay Gerekli!\n\n${summary}\n\n✅ "evet" → Onayla\n❌ "hayir" → Reddet`;
  await sendWhatsAppMessage(ADMIN_PHONE, msg);
}

module.exports.sendApprovalRequest = sendApprovalRequest;
