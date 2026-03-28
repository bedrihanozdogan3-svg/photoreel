let firestoreService = null;

// Lazy load firestore (çökmemesi için)
function getFirestore() {
  if (!firestoreService) {
    try { firestoreService = require('./firestore-service'); } catch(e) { console.log('Firestore yüklenemedi:', e.message); }
  }
  return firestoreService;
}

// ═══ MODEL ROUTING — görev tipine göre otomatik model seçimi ═══
const MODELS = {
  fast: 'gemini-2.5-flash-lite',    // Hızlı/ucuz: analiz, kategori tespiti
  standard: 'gemini-2.5-flash',      // Standart: sohbet, sahne üretimi
  powerful: 'gemini-2.5-pro',        // Güçlü/pahalı: kritik analiz, karmaşık görevler
};

// Görev tipine göre model seç
function selectModel(taskType) {
  const routing = {
    'chat': MODELS.standard,
    'analysis': MODELS.fast,
    'category': MODELS.fast,
    'scene': MODELS.standard,
    'trend': MODELS.fast,
    'critical': MODELS.powerful,
    'feedback': MODELS.fast,
  };
  return routing[taskType] || MODELS.standard;
}

function getApiUrl(taskType) {
  const key = process.env.GEMINI_API_KEY;
  const model = selectModel(taskType || 'chat');
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
}

async function sendMessage(history, message, taskType = 'chat') {
  const contents = history.map(msg => ({
    role: msg.sender === 'gemini' ? 'model' : 'user',
    parts: [{ text: `[${msg.sender}]: ${msg.text}` }]
  }));

  contents.push({
    role: 'user',
    parts: [{ text: message }]
  });

  // Firestore'dan bağlam al (3sn timeout — yoksa atla)
  let firestoreContext = '';
  let feedbackContext = '';
  try {
    const fs = getFirestore();
    if (fs) {
      const ctx = await Promise.race([
        fs.getSystemContext(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
      ]);
      firestoreContext = ctx || '';
    }
  } catch(e) { /* Firestore yok veya timeout — atla */ }

  // Geri bildirim verisini öğrenme bağlamı olarak ekle (3sn timeout)
  try {
    const stateService = require('./state-service');
    const stats = await Promise.race([
      stateService.getFeedbackStats(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
    ]);
    if (stats && stats.total > 0) {
      feedbackContext = `\n\n═══ FENİX ÖĞRENME VERİSİ ═══
Toplam geri bildirim: ${stats.total} (${stats.liked} beğeni, ${stats.disliked} beğenmeme)
Başarı oranı: %${stats.total > 0 ? Math.round(stats.liked / stats.total * 100) : 0}`;
      // Kategori bazlı başarı
      const cats = Object.entries(stats.categories || {});
      if (cats.length > 0) {
        feedbackContext += '\nKategori performansı:';
        cats.forEach(function(c) {
          var total = c[1].liked + c[1].disliked;
          var rate = total > 0 ? Math.round(c[1].liked / total * 100) : 0;
          feedbackContext += '\n  ' + c[0] + ': %' + rate + ' başarı (' + total + ' video)';
        });
      }
      feedbackContext += '\n\nBu verilere göre: beğenilen stilleri daha çok kullan, beğenilmeyenleri azalt.';
    }
    // Son 10 geri bildirimi detaylı ekle
    const recent = await Promise.race([
      stateService.getFeedbackHistory(null, 10),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
    ]);
    if (recent && recent.length > 0) {
      feedbackContext += '\n\nSon geri bildirimler:';
      recent.forEach(function(fb) {
        feedbackContext += '\n  ' + (fb.rating === 'like' ? '👍' : '👎') + ' ' + (fb.category || '?') + ' — şablon:' + (fb.templateUsed || '?') + ' geçişler:' + (fb.transitionsUsed || []).join(',');
      });
    }
  } catch(e) { console.log('Feedback context atlandı:', e.message); }

  const systemText = `Sen Fenix AI'sın — PhotoReel AI projesinde çalışan üst düzey yapay zeka asistanısın. Türkçe yanıt ver.

Geliştirici Bedrihan Özdoğan ile konuşuyorsun. Ona "Bedrihan" diye hitap et.

YANIT KURALLARI:
- Her soruyu TAMAMEN ve EKSİKSİZ yanıtla. Yarım cevap verme, cevabı kesme.
- Kod sorusunda tam çalışan kodu yaz — sadece snippet değil, context de ekle.
- Teknik konularda adım adım açıkla.
- Strateji/iş sorusunda detaylı analiz yap, örnekler ver.
- Müşteri/kullanıcı sorularında samimi, net ve bilgilendirici ol — kısa tutma.
- "Kısa cevap" veya "özetleyeceğim" deme — tam cevabı ver.
- Gerekirse listeler, başlıklar, kod blokları kullan.
- maxOutputTokens 8192 — bu limiti kullanmaktan çekinme.

${firestoreContext}${feedbackContext}`;

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

  const selectedModel = selectModel(taskType);
  console.log(`🤖 Gemini model routing: ${taskType} → ${selectedModel}`);

  // Circuit breaker + Shadow Learning + Metrik kaydı
  const { getBreaker } = require('../utils/circuit-breaker');
  const breaker = getBreaker('gemini');
  const startTime = Date.now();

  const result = await breaker.call(async () => {
    const res = await fetch(getApiUrl(taskType), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Gemini API hatası');
    return data.candidates[0].content.parts[0].text;
  }, () => {
    // Fallback: Circuit açıksa basit yanıt
    return 'Gemini şu an geçici olarak kullanılamıyor. Lütfen biraz sonra tekrar deneyin.';
  });

  const latency = Date.now() - startTime;

  // Fenix Brain — metrik + shadow learning
  try {
    if (global.fenixBrain) {
      global.fenixBrain.recordMetric('gemini', latency, true);
      global.fenixBrain.recordShadow('gemini', taskType, { model: selectedModel, messageLength: message.length }, { responseLength: result.length, latencyMs: latency }, 'success');
    }
  } catch(e) {}

  return result;
}

// ═══ FUNCTION CALLING — Gemini Kod Asistanı ═══
const CODE_TOOLS = [{
  function_declarations: [
    {
      name: 'read_file',
      description: 'Projedeki bir dosyanın içeriğini oku',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Dosya yolu (ör: server.js, services/gemini-service.js)' } }, required: ['path'] }
    },
    {
      name: 'list_files',
      description: 'Bir klasördeki dosyaları listele',
      parameters: { type: 'object', properties: { directory: { type: 'string', description: 'Klasör yolu (ör: services, routes)' }, pattern: { type: 'string', description: 'Dosya filtresi (ör: *.js)' } }, required: ['directory'] }
    },
    {
      name: 'search_code',
      description: 'Projede kod ara (grep)',
      parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Aranacak metin veya regex' }, filePattern: { type: 'string', description: 'Dosya filtresi (ör: *.js)' } }, required: ['pattern'] }
    },
    {
      name: 'get_project_structure',
      description: 'Projenin klasör yapısını getir',
      parameters: { type: 'object', properties: {} }
    },
    {
      name: 'edit_file',
      description: 'Bir dosyayı düzenle (onay gerektirir)',
      parameters: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['replace', 'insert', 'delete'] }, startLine: { type: 'number' }, endLine: { type: 'number' }, afterLine: { type: 'number' }, content: { type: 'string' } } } } }, required: ['path', 'edits'] }
    },
    {
      name: 'run_command',
      description: 'Terminal komutu çalıştır (onay gerektirir). İzin verilen: npm, node, git, ls, grep',
      parameters: { type: 'object', properties: { command: { type: 'string', description: 'Çalıştırılacak komut' } }, required: ['command'] }
    }
  ]
}];

async function sendMessageWithTools(history, message, taskType = 'chat') {
  const codeAssistant = require('./code-assistant');

  const contents = history.map(msg => ({
    role: msg.sender === 'gemini' ? 'model' : 'user',
    parts: [{ text: msg.text }]
  }));
  contents.push({ role: 'user', parts: [{ text: message }] });

  let firestoreContext = '';
  try {
    const fs = getFirestore();
    if (fs) firestoreContext = await fs.getSystemContext();
  } catch(e) {}

  const systemText = `Sen Fenix AI kodlama asistanısın. Bedrihan'ın tablet'inden kodlara erişiyorsun.
Görevin: dosya oku, kod ara, düzenle, komut çalıştır. Claude Code gibi çalış.
Türkçe, kısa ve net yanıt ver. Gereksiz açıklama yapma.
Dosya içeriği gösterirken satır numarası ekle.
Düzenleme önerirken edit_file tool'unu kullan.
${firestoreContext}`;

  const payload = {
    contents,
    tools: CODE_TOOLS,
    generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
    systemInstruction: { parts: [{ text: systemText }] }
  };

  const toolResults = [];
  let maxIterations = 5;

  while (maxIterations-- > 0) {
    const selectedModel = selectModel(taskType);
    console.log(`🛠️ Gemini code assistant: ${taskType} → ${selectedModel} (iteration ${5 - maxIterations})`);

    const res = await fetch(getApiUrl(taskType), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Gemini API hatası');

    const candidate = data.candidates[0];
    const parts = candidate.content.parts;

    // Function call var mı?
    const fnCall = parts.find(p => p.functionCall);
    if (!fnCall) {
      // Metin yanıtı — döndür
      const textPart = parts.find(p => p.text);
      return { text: textPart?.text || '', toolResults };
    }

    // Function call'ı işle
    const fn = fnCall.functionCall;
    let fnResult;
    try {
      switch (fn.name) {
        case 'read_file':
          fnResult = await codeAssistant.readFile(fn.args.path);
          break;
        case 'list_files':
          fnResult = await codeAssistant.listFiles(fn.args.directory, fn.args.pattern);
          break;
        case 'search_code':
          fnResult = await codeAssistant.searchCode(fn.args.pattern, fn.args.filePattern);
          break;
        case 'get_project_structure':
          fnResult = await codeAssistant.getProjectStructure();
          break;
        case 'edit_file':
          fnResult = { needsApproval: true, file: fn.args.path, edits: fn.args.edits };
          break;
        case 'run_command':
          fnResult = { needsApproval: true, command: fn.args.command };
          break;
        default:
          fnResult = { error: 'Bilinmeyen tool: ' + fn.name };
      }
    } catch (e) {
      fnResult = { error: e.message };
    }

    toolResults.push({ tool: fn.name, args: fn.args, result: fnResult });

    // Onay gerektiren tool — döngüyü kır
    if (fnResult.needsApproval) {
      return { text: `⚠️ Bu işlem onay gerektiriyor.`, toolResults, pendingApproval: fnResult };
    }

    // Tool sonucunu Gemini'ye geri gönder
    payload.contents.push(candidate.content);
    payload.contents.push({
      role: 'user',
      parts: [{ functionResponse: { name: fn.name, response: fnResult } }]
    });
  }

  return { text: 'Maksimum iterasyon sınırına ulaşıldı.', toolResults };
}

module.exports = { sendMessage, sendMessageWithTools, selectModel, MODELS, CODE_TOOLS };
