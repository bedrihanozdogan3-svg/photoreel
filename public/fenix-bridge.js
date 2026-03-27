/* ============================================================
   FENIX AI BRIDGE — Claude + Gemini Bağlantısı
   
   Bu dosya Fenix'in beynini Claude ve Gemini'ye bağlar.
   Claude: metin üretimi (hook, senaryo, caption, hashtag)
   Gemini: görsel analiz (fotoğraf/video ne gösteriyor)
   
   CLAUDE VE GEMİNİ BU DOSYAYI OKURKEN:
   - Her fonksiyonun üstünde ne yaptığı yazıyor
   - API endpoint'leri açık
   - Hata yönetimi mevcut
   - Fenix arayüzüne nasıl bağlandığı açık
   ============================================================ */

/* ── CONFIG'İ YÜKLE ── */
const cfg = (typeof FENIX_CONFIG !== 'undefined') 
  ? FENIX_CONFIG 
  : (typeof require !== 'undefined' ? require('./config.js') : null);

/* ============================================================
   CLAUDE API — Metin Üretimi
   Endpoint: https://api.anthropic.com/v1/messages
   Kullanım: hook, senaryo, caption, hashtag üretir
   ============================================================ */
async function claudeGenerate(prompt, systemOverride) {
  if (!cfg || !cfg.claude.enabled) {
    console.warn('[FENIX] Claude devre dışı — config.js kontrol et');
    return null;
  }

  const system = systemOverride || cfg.claude.system_prompt;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':            'application/json',
        'x-api-key':               cfg.claude.api_key,
        'anthropic-version':       '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model:      cfg.claude.model,
        max_tokens: cfg.claude.max_tokens,
        system:     system,
        messages:   [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      throw new Error('Claude API hatası: ' + response.status);
    }

    const data = await response.json();
    return data.content[0].text;

  } catch (err) {
    console.error('[FENIX] Claude hatası:', err);
    return null;
  }
}

/* ============================================================
   GEMINI API — Metin + Görsel Analiz
   Endpoint: https://generativelanguage.googleapis.com/v1beta
   Kullanım: görsel analiz, platform optimizasyon
   ============================================================ */
async function geminiGenerate(prompt, imageBase64) {
  if (!cfg || !cfg.gemini.enabled) {
    console.warn('[FENIX] Gemini devre dışı — config.js kontrol et');
    return null;
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.gemini.model}:generateContent?key=${cfg.gemini.api_key}`;

  /* İstek gövdesi — görsel varsa ekle */
  const parts = [{ text: cfg.gemini.system_prompt + '\n\n' + prompt }];
  if (imageBase64 && cfg.gemini.vision_enabled) {
    parts.push({
      inline_data: {
        mime_type: 'image/jpeg',
        data:      imageBase64
      }
    });
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }]
      })
    });

    if (!response.ok) {
      throw new Error('Gemini API hatası: ' + response.status);
    }

    const data = await response.json();
    return data.candidates[0].content.parts[0].text;

  } catch (err) {
    console.error('[FENIX] Gemini hatası:', err);
    return null;
  }
}

/* ============================================================
   FENIX ROUTER — Hangi iş hangi AI'a gider
   cfg.routing ayarlarına göre yönlendirir
   ============================================================ */
async function fenixAI(task, input) {
  const route = cfg && cfg.routing[task] || 'claude';

  console.log(`[FENIX] ${task} → ${route.toUpperCase()}`);

  if (route === 'gemini') {
    return await geminiGenerate(input.prompt, input.image || null);
  } else {
    return await claudeGenerate(input.prompt, input.system || null);
  }
}

/* ============================================================
   OTONOM ÜRETIM — Ana Fonksiyon
   Fenix Otonom mod "ÜRET" butonuna basınca burası çalışır
   ============================================================ */
async function fenixOtonomUret(params) {
  const { brand, platform, music, niche, imageBase64 } = params;

  /* Yükleme göster */
  fenixUI('loading', true);

  /* ── ADIM 1: Görsel analiz (Gemini) ── */
  let gorselAnaliz = '';
  if (imageBase64) {
    gorselAnaliz = await fenixAI('image_analysis', {
      prompt: `Bu görseli analiz et. Ne gösteriyor? Hangi ürün/hizmet/içerik kategorisi? Marka: "${brand || 'belirsiz'}", Platform: ${platform}, Niş: ${niche}`,
      image:  imageBase64
    }) || '';
  }

  /* ── Kullanıcı tercihleri (Shadow Learning) ── */
  let prefNote = '';
  try {
    const prefs = JSON.parse(localStorage.getItem('fenix_preferences') || '{}');
    if(prefs.total_liked > 0 || prefs.total_disliked > 0){
      prefNote = `\nKullanıcı tercihleri: ${prefs.total_liked} beğeni, ${prefs.total_disliked} beğenmeme.`;
      if(prefs.modes){
        Object.keys(prefs.modes).forEach(m => {
          const mp = prefs.modes[m];
          if(mp.liked > mp.disliked) prefNote += ` ${m} modunu seviyor.`;
        });
      }
    }
  } catch(e){}

  /* ── ADIM 2: Hook metni (Claude) ── */
  const hookPrompt = `
Marka: "${brand || 'belirtilmedi'}"
Platform: ${platform}
Müzik: ${music}
Niş: ${niche}
${gorselAnaliz ? 'Görsel analiz: ' + gorselAnaliz : ''}${prefNote}

Görev: Bu bilgilere göre sosyal medya Reels için 1 adet güçlü HOOK metni yaz.
- Maksimum 15 kelime
- İlk 3 saniyede dikkat çeksin
- Emoji kullan
- Türkçe
- Sadece hook metnini yaz, açıklama yapma`;

  const hook = await fenixAI('text_generation', { prompt: hookPrompt }) || '';

  /* ── ADIM 3: Senaryo (Claude) ── */
  const senaryoPrompt = `
Marka: "${brand || 'belirtilmedi'}"
Platform: ${platform}, Müzik: ${music}, Niş: ${niche}
Hook: "${hook}"

Görev: 30 saniyelik Reels senaryosu yaz. Format:
[0-3sn] ...
[3-10sn] ...
[10-20sn] ...
[20-28sn] ...
[28-30sn] ...
Türkçe, kısa, uygulanabilir.`;

  const senaryo = await fenixAI('text_generation', { prompt: senaryoPrompt }) || '';

  /* ── ADIM 4: Caption + Hashtag (Claude) ── */
  const captionPrompt = `
Marka: "${brand || 'belirtilmedi'}", Niş: ${niche}, Platform: ${platform}
Hook: "${hook}"

Görev: 
1. 2-3 cümle caption yaz (Türkçe, emoji'li)
2. 8-10 hashtag öner (platform: ${platform})
Format: CAPTION: ... | HASHTAG: #... #... #...`;

  const captionRaw = await fenixAI('text_generation', { prompt: captionPrompt }) || '';
  const caption  = captionRaw.split('HASHTAG:')[0].replace('CAPTION:', '').trim();
  const hashtags = captionRaw.includes('HASHTAG:') 
    ? captionRaw.split('HASHTAG:')[1].trim() 
    : '#reels #viral #trending';

  /* ── ADIM 5: Platform optimizasyon (Gemini) ── */
  const platformPrompt = `
Platform: ${platform}, İçerik: ${niche}, Müzik BPM: ${music}
${gorselAnaliz ? 'Görsel: ' + gorselAnaliz : ''}

Bu içerik için ${platform} optimizasyon önerileri:
- En iyi paylaşım saati
- Format (9:16 / 1:1)
- FPS önerisi
- Özel not
Kısa ve maddeler halinde, Türkçe.`;

  const platformOptim = await fenixAI('platform_optim', { prompt: platformPrompt }) || '';

  /* ── ADIM 6: Düzenleme rehberi (Claude) ── */
  const editPrompt = `
Müzik: ${music}, Platform: ${platform}, Niş: ${niche}

Bu Reels için düzenleme rehberi yaz:
- Müzik senkronizasyonu
- Geçiş efekti önerisi
- Font/renk önerisi
- Tempo
Kısa maddeler, Türkçe, emoji'li.`;

  const editGuide = await fenixAI('text_generation', { prompt: editPrompt }) || '';

  /* ── SONUÇ ── */
  const result = { hook, senaryo, caption, hashtags, platformOptim, editGuide, gorselAnaliz };

  /* Arayüze yaz */
  fenixUI('result', result);

  /* Eğitim verisi kaydet */
  fenixSaveSession(params, result);

  return result;
}

/* ============================================================
   FENIX UI KÖPRÜSÜ
   AI sonuçlarını Fenix arayüzüne yazar
   index.html'deki elementlere bağlıdır
   ============================================================ */
function fenixUI(state, data) {
  /* Loading state */
  const loadEl = document.getElementById('ao-loading');
  const emptyEl = document.getElementById('ao-empty');
  const resultEl = document.getElementById('ao-result');

  if (state === 'loading') {
    if (emptyEl)  emptyEl.style.display  = 'none';
    if (resultEl) resultEl.style.display = 'none';
    if (loadEl)   { loadEl.style.display = 'flex'; }
    return;
  }

  if (state === 'result' && data) {
    if (loadEl)   loadEl.style.display   = 'none';
    if (resultEl) resultEl.style.display = 'flex';

    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = (val || '').replace(/\n/g, '<br>');
    };

    set('ao-hook',     data.hook);
    set('ao-script',   data.senaryo);
    set('ao-caption',  data.caption + '<br><br>' + data.hashtags);
    set('ao-edit',     data.editGuide);
    set('ao-platform', data.platformOptim);
  }
}

/* ============================================================
   EĞİTİM VERİSİ KAYDETME
   Her oturumu fenix-training-data.json'a ekler
   ============================================================ */
function fenixSaveSession(input, output) {
  if (!cfg || !cfg.training.save_sessions) return;

  const session = {
    session_id:  'FNX-' + Date.now(),
    timestamp:   new Date().toISOString(),
    mode:        'otonom',
    platform:    input.platform,
    user_inputs: {
      brand_name: input.brand || '',
      niche:      input.niche,
      music:      input.music,
      has_image:  !!input.imageBase64
    },
    ai_outputs: {
      hook:          output.hook,
      senaryo:       output.senaryo,
      caption:       output.caption,
      hashtags:      output.hashtags,
      platform_optim: output.platformOptim,
      gorsel_analiz: output.gorselAnaliz
    },
    routing_used: cfg.routing
  };

  /* LocalStorage'a kaydet (PC'de dosyaya yaz için Node.js gerekir) */
  try {
    const existing = JSON.parse(localStorage.getItem('fenix_training') || '[]');
    existing.push(session);
    localStorage.setItem('fenix_training', JSON.stringify(existing));
    console.log('[FENIX] Oturum kaydedildi:', session.session_id);
  } catch (e) {
    console.warn('[FENIX] Kayıt hatası:', e);
  }
}

/* ============================================================
   FENIX BAŞLANGIÇ — index.html'de <script> ile çağrılır
   aoGenerate() fonksiyonunu override eder
   ============================================================ */
function fenixBridgeInit() {
  console.log('[FENIX] AI Bridge başlatıldı');
  console.log('[FENIX] Claude:', cfg?.claude.enabled ? '✅' : '❌');
  console.log('[FENIX] Gemini:', cfg?.gemini.enabled ? '✅' : '❌');

  /* Fenix Otonom üret butonunu AI'a bağla */
  window.aoGenerate = async function() {
    const brand    = (document.getElementById('ao-brand')   || {}).value || '';
    const plt      = (document.querySelector('#v-otonom .gitem.ON .gn') || {}).textContent || 'instagram';
    const music    = (document.querySelector('#ao-muzik .music-item.ON .mi-title') || {}).textContent || 'Slow Motion';
    const niche    = (document.getElementById('ao-nis')     || {}).value || 'Lifestyle';
    const cv       = document.getElementById('cv-otonom');

    /* Canvas'tan görsel al */
    let imageBase64 = null;
    if (cv && cv.style.display !== 'none') {
      try { imageBase64 = cv.toDataURL('image/jpeg', 0.7).split(',')[1]; } catch(e) {}
    }

    await fenixOtonomUret({ brand, platform: plt, music, niche, imageBase64 });
  };

  console.log('[FENIX] aoGenerate() AI moduna bağlandı ✅');
}

/* Sayfa yüklenince başlat */
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', fenixBridgeInit);
}

/* Node.js için export */
if (typeof module !== 'undefined') {
  module.exports = { claudeGenerate, geminiGenerate, fenixAI, fenixOtonomUret };
}
