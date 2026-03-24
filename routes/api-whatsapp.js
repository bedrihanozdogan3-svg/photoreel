const express = require('express');
const geminiService = require('../services/gemini-service');
const claudeService = require('../services/claude-service');
const sharedMemory = require('../services/shared-memory-service');
const firestoreService = require('../services/firestore-service');

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
    `🧠 Beyin Merkezi:\n` +
    `• /fikir metin → Fikir kaydet\n` +
    `• /bug metin → Bug kaydet\n` +
    `• /karar metin → Karar kaydet\n` +
    `• /gorev metin → Görev ekle\n` +
    `• /not metin → Not ekle\n` +
    `• /fikirler → Fikirleri listele\n` +
    `• /buglar → Bugları listele\n` +
    `• /gorevler → Görevleri listele\n` +
    `• /ozet → Tüm özet\n` +
    `• /hafiza → Hafızayı gör\n\n` +
    `🎤 Medya:\n` +
    `• Sesli mesaj gönder → Gemini dinler ve cevaplar\n` +
    `• Görsel gönder → Gemini analiz eder\n\n` +
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
      if (global.trackUsage) global.trackUsage('twilio');
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

      // Medya mesaji (sesli mesaj veya görsel)
      if (msgType === 'media' && body.NumMedia > 0) {
        const mediaUrl = body.MediaUrl0;
        const mediaType = body.MediaContentType0 || '';
        console.log(`[MEDIA] Tür: ${mediaType}, URL: ${mediaUrl}`);

        if (mediaType.startsWith('audio/') || mediaType === 'audio/ogg') {
          // SESLİ MESAJ → Gemini'ye gönder, yazıya çevir ve cevapla
          try {
            await sendWhatsAppMessage(from, '🎤 Sesli mesajın işleniyor...');
            // Twilio media URL'den ses dosyasını indir
            const audioRes = await fetch(mediaUrl, {
              headers: { 'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH}`).toString('base64') }
            });
            const audioBuffer = await audioRes.arrayBuffer();
            const base64Audio = Buffer.from(audioBuffer).toString('base64');

            // Gemini'ye ses gönder
            const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
            const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [
                  { inlineData: { mimeType: mediaType, data: base64Audio } },
                  { text: 'Bu sesli mesajı Türkçe olarak yazıya çevir. Sonra içeriğine uygun kısa bir cevap ver. Kullanıcıya "Bedrihan" diye hitap et.' }
                ]}],
                generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }
              })
            });
            const geminiData = await geminiRes.json();
            if (geminiData.candidates?.[0]?.content?.parts?.[0]?.text) {
              text = '[Sesli mesaj]';
              response = `🎤 ${geminiData.candidates[0].content.parts[0].text}`;
              if (global.trackUsage) global.trackUsage('gemini');
              await sendWhatsAppMessage(from, response);
            } else {
              await sendWhatsAppMessage(from, '❌ Sesli mesaj çözümlenemedi. Tekrar dene.');
            }
          } catch(e) {
            console.error('Sesli mesaj hatası:', e.message);
            await sendWhatsAppMessage(from, '❌ Sesli mesaj işlenirken hata: ' + e.message);
          }
          return;
        }
        else if (mediaType.startsWith('image/')) {
          // GÖRSEL → Gemini'ye analiz ettir + Firestore'a kaydet
          try {
            await sendWhatsAppMessage(from, '📸 Görsel analiz ediliyor...');
            const imgRes = await fetch(mediaUrl, {
              headers: { 'Authorization': 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH}`).toString('base64') }
            });
            const imgBuffer = await imgRes.arrayBuffer();
            const base64Img = Buffer.from(imgBuffer).toString('base64');

            const caption = body.Body || '';
            const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
            const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [
                  { inlineData: { mimeType: mediaType, data: base64Img } },
                  { text: `Bu görseli analiz et. ${caption ? 'Kullanıcı notu: ' + caption : ''}\n\nBu bir PhotoReel AI projesi için gönderilen görsel. Görselin içeriğini, renklerini, kompozisyonunu, ürün kategorisini ve potansiyel kullanım alanlarını açıkla. Bedrihan'a hitap et.` }
                ]}],
                generationConfig: { temperature: 0.5, maxOutputTokens: 4096 }
              })
            });
            const geminiData = await geminiRes.json();
            if (geminiData.candidates?.[0]?.content?.parts?.[0]?.text) {
              const analysis = geminiData.candidates[0].content.parts[0].text;
              // Firestore'a kaydet
              await firestoreService.addNot(`[GÖRSEL ANALİZ] ${analysis.substring(0, 200)}`, from);
              if (global.trackUsage) global.trackUsage('gemini');
              await sendWhatsAppMessage(from, `📸 Görsel Analiz:\n\n${analysis}`);
            } else {
              await sendWhatsAppMessage(from, '❌ Görsel analiz edilemedi.');
            }
          } catch(e) {
            console.error('Görsel analiz hatası:', e.message);
            await sendWhatsAppMessage(from, '❌ Görsel işlenirken hata: ' + e.message);
          }
          return;
        }
        else if (!text) {
          await sendWhatsAppMessage(from, '📎 Bu dosya türü henüz desteklenmiyor. Metin, ses veya görsel gönder.');
          return;
        }
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

      // === BEYİN MERKEZİ KOMUTLARI ===

      // Fikir kaydet
      if (lowerText.startsWith('/fikir ')) {
        const fikir = text.replace(/^\/fikir\s+/i, '').trim();
        if (fikir) {
          await firestoreService.addFikir(fikir, from);
          response = `💡 Fikir kaydedildi: "${fikir}"`;
        } else {
          response = '❌ Kullanım: /fikir <fikir metni>';
        }
      }
      // Bug kaydet
      else if (lowerText.startsWith('/bug ')) {
        const bug = text.replace(/^\/bug\s+/i, '').trim();
        if (bug) {
          await firestoreService.addBug(bug, from);
          response = `🐛 Bug kaydedildi: "${bug}"`;
        } else {
          response = '❌ Kullanım: /bug <hata açıklaması>';
        }
      }
      // Karar kaydet
      else if (lowerText.startsWith('/karar ')) {
        const karar = text.replace(/^\/karar\s+/i, '').trim();
        if (karar) {
          await firestoreService.addKarar(karar, from);
          response = `✅ Karar kaydedildi: "${karar}"`;
        } else {
          response = '❌ Kullanım: /karar <karar metni>';
        }
      }
      // Görev kaydet
      else if (lowerText.startsWith('/gorev ')) {
        const gorev = text.replace(/^\/gorev\s+/i, '').trim();
        if (gorev) {
          await firestoreService.addGorev(gorev, from);
          response = `📋 Görev eklendi: "${gorev}"`;
        } else {
          response = '❌ Kullanım: /gorev <görev açıklaması>';
        }
      }
      // Fikirleri listele
      else if (lowerText === '/fikirler' || lowerText === '/ideas') {
        const fikirler = await firestoreService.getFikirler(10);
        if (fikirler.length) {
          response = '💡 Son Fikirler:\n\n' + fikirler.map((f, i) => `${i + 1}. [${f.date}] ${f.text}`).join('\n');
        } else {
          response = '💡 Henüz fikir yok. /fikir <metin> ile ekle.';
        }
      }
      // Bugları listele
      else if (lowerText === '/buglar' || lowerText === '/bugs') {
        const buglar = await firestoreService.getBuglar(10);
        if (buglar.length) {
          response = '🐛 Açık Buglar:\n\n' + buglar.map((b, i) => `${i + 1}. [${b.date}] ${b.text}`).join('\n');
        } else {
          response = '🐛 Açık bug yok!';
        }
      }
      // Görevleri listele
      else if (lowerText === '/gorevler' || lowerText === '/tasks') {
        const gorevler = await firestoreService.getGorevler(10);
        if (gorevler.length) {
          response = '📋 Açık Görevler:\n\n' + gorevler.map((g, i) => `${i + 1}. [${g.date}] ${g.text}`).join('\n');
        } else {
          response = '📋 Açık görev yok!';
        }
      }
      // Tüm özet
      else if (lowerText === '/ozet' || lowerText === '/summary') {
        const context = await firestoreService.getFullContext(5);
        if (context.length > 50) {
          response = `🧠 ${context}`;
        } else {
          response = '🧠 Henüz kayıt yok. /fikir, /bug, /karar, /gorev ile ekle.';
        }
      }
      // Dil degistir
      else if (lowerText.startsWith('/dil ') || lowerText.startsWith('/lang ')) {
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
        if (global.trackUsage) global.trackUsage('gemini');
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
          if (global.trackUsage) global.trackUsage('claude');
          response = `🔵 Claude:\n${response}`;

          // Önemli konuşmaları hafızaya kaydet
          if (sharedMemory.shouldSaveToMemory(text.replace(/^\/claude\s+/i, '').replace(/^claude:\s*/i, '')) || sharedMemory.shouldSaveToMemory(response)) {
            const summary = text.replace(/^\/claude\s+/i, '').replace(/^claude:\s*/i, '');
            sharedMemory.addConversationNote('Kullanıcı→Claude', summary.length > 100 ? summary.substring(0, 100) + '...' : summary);
          }
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
      // Kota durumu
      else if (lowerText === '/kota' || lowerText === '/quota') {
        const q = global.quotaTracker || {};
        response = `📊 Kota Durumu:\n\n` +
          `🟢 Gemini: ${q.gemini?.used || 0}/${q.gemini?.limit || 1500} mesaj\n` +
          `🔵 Claude: ${q.claude?.used || 0}/${q.claude?.limit || 500} mesaj\n` +
          `📱 Twilio: ${q.twilio?.used || 0}/${q.twilio?.limit || 200} mesaj\n\n` +
          `Limitler aylik sifirlanir.\n%80'de uyari, %100'de bildirim gelir.`;
      }
      // Durum
      else if (lowerText === '/durum' || lowerText === '/status') {
        const geminiOk = !!process.env.GEMINI_API_KEY;
        const claudeOk = claudeService.isAvailable();
        const twilioOk = !!getTwilio();
        const q = global.quotaTracker || {};
        response = `📊 Sistem Durumu:\n\n` +
          `🟢 Gemini: ${geminiOk ? 'Aktif' : 'Pasif'} (${q.gemini?.used || 0}/${q.gemini?.limit || 1500})\n` +
          `${claudeOk ? '🔵' : '⚪'} Claude: ${claudeOk ? 'Aktif' : 'Kredi gerekli'} (${q.claude?.used || 0}/${q.claude?.limit || 500})\n` +
          `🟢 WhatsApp (Twilio): ${twilioOk ? 'Aktif' : 'Pasif'} (${q.twilio?.used || 0}/${q.twilio?.limit || 200})\n` +
          `🟢 Sunucu: Calisiyor\n` +
          `📱 Admin: ${isAdmin ? 'Evet (sen)' : 'Hayir'}`;
      }
      // Hafıza görüntüle
      else if (lowerText === '/hafiza' || lowerText === '/memory') {
        const memory = sharedMemory.readMemory();
        if (memory) {
          const preview = memory.length > 1400 ? memory.substring(0, 1400) + '\n\n... (kısaltıldı)' : memory;
          response = `🧠 Paylaşımlı Hafıza:\n\n${preview}`;
        } else {
          response = '🧠 Hafıza boş.';
        }
      }
      // Hafızaya not ekle
      else if (lowerText.startsWith('/not ') || lowerText.startsWith('/note ')) {
        const note = text.replace(/^\/(not|note)\s+/i, '').trim();
        if (note) {
          sharedMemory.addDecision(note);
          response = `✅ Hafızaya kaydedildi: "${note}"`;
        } else {
          response = '❌ Kullanım: /not <kaydedilecek bilgi>';
        }
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
        if (global.trackUsage) global.trackUsage('gemini');
        response = `🟢 Gemini:\n${response}`;

        // Önemli konuşmaları hafızaya kaydet
        if (sharedMemory.shouldSaveToMemory(text) || sharedMemory.shouldSaveToMemory(response)) {
          const summary = text.length > 100 ? text.substring(0, 100) + '...' : text;
          sharedMemory.addConversationNote('Kullanıcı→Gemini', summary);
        }
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
