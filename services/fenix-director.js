/**
 * Fenix Director — Otonom Video Üretim Motoru
 * fal.ai (Flux + Kling) + Gemini Vision pipeline
 *
 * ── DÖNGÜ MİMARİSİ ──
 * API üretir → Fenix HER ADIMI izler → kaydeder → başa döner
 * Öğrendiklerini ASLA silmez — birikim katlanarak büyür
 *
 * ── SEVİYE HARİTASI ──
 * 0-50  müşteri  →  3.000  ders → Çırak   (API'yi taklit eder)
 * 50-200 müşteri → 12.000  ders → Kalfa   (kategori kararları doğru)
 * 200-500 müşteri→ 30.000  ders → Usta    (efekt/LUT optimize)
 * 500-2000 müşteri→120.000 ders → Mimar   (API'ye az ihtiyaç duyar)
 */

const fenixBrain = require('./fenix-brain');
const logger     = require('../utils/logger');

const FAL_KEY    = process.env.FAL_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

// ── Varsayılan kategori parametreleri (başlangıç ağırlıkları) ──
const KATEGORI_PARAMS = {
  gida:       { lut: 'golden-hour',   arka: 'ahsap',  bpm: 78,  efekt: 'slow-zoom',   ton: 'sicak',
                _360: { orbit: 'slow-turntable', ruzgar: false, takip: 'urun',   yon: 'yatay', hiz: 'yavas',  isik: 'sicak'     } },
  icecek:     { lut: 'cinema',        arka: 'siyah',  bpm: 104, efekt: 'flash',        ton: 'dinamik',
                _360: { orbit: 'slow-turntable', ruzgar: false, takip: 'urun',   yon: 'yatay', hiz: 'orta',   isik: 'dramatik'  } },
  kozmetik:   { lut: 'none',          arka: 'beyaz',  bpm: 85,  efekt: 'soft-fade',    ton: 'luks',
                _360: { orbit: 'close-texture',  ruzgar: false, takip: 'urun',   yon: 'yukarı',hiz: 'yavas',  isik: 'yumusak'   } },
  parfum:     { lut: 'cinema',        arka: 'siyah',  bpm: 85,  efekt: 'glitch-soft',  ton: 'gizem',
                _360: { orbit: 'slow-turntable', ruzgar: false, takip: 'urun',   yon: 'yatay', hiz: 'yavas',  isik: 'dramatik'  } },
  giyim:      { lut: 'none',          arka: 'beyaz',  bpm: 104, efekt: 'slide',        ton: 'trend',
                _360: { orbit: 'manken-orbit',   ruzgar: false, takip: 'manken', yon: 'yatay', hiz: 'orta',   isik: 'studio'    } },
  ayakkabi:   { lut: 'teal-orange',   arka: 'tas',    bpm: 128, efekt: 'zoom-punch',   ton: 'guc',
                _360: { orbit: 'low-detail',     ruzgar: false, takip: 'urun',   yon: 'asagi', hiz: 'orta',   isik: 'sert'      } },
  elektronik: { lut: 'cinema',        arka: 'siyah',  bpm: 120, efekt: 'glitch',       ton: 'teknik',
                _360: { orbit: 'screen-showcase',ruzgar: false, takip: 'ekran',  yon: 'yatay', hiz: 'orta',   isik: 'mavi-glow' } },
  spor:       { lut: 'teal-orange',   arka: 'doga',   bpm: 128, efekt: 'shake-zoom',   ton: 'enerji',
                _360: { orbit: 'action-follow',  ruzgar: true,  takip: 'sporcu', yon: 'serbest',hiz: 'hizli',  isik: 'doga'     } },
  taki:       { lut: 'cinema',        arka: 'siyah',  bpm: 90,  efekt: 'slow-zoom',    ton: 'luks',
                _360: { orbit: 'close-texture',  ruzgar: false, takip: 'urun',   yon: 'yukarı',hiz: 'cok-yavas',isik: 'parlak'  } },
  aksesuar:   { lut: 'cinema',        arka: 'krem',   bpm: 95,  efekt: 'soft-fade',    ton: 'luks',
                _360: { orbit: 'slow-turntable', ruzgar: false, takip: 'urun',   yon: 'yatay', hiz: 'yavas',  isik: 'yumusak'   } },
  'ev-yasam': { lut: 'golden-hour',   arka: 'ahsap',  bpm: 78,  efekt: 'slow-pan',     ton: 'huzur',
                _360: { orbit: 'mekan-turu',     ruzgar: false, takip: 'mekan',  yon: 'yatay', hiz: 'cok-yavas',isik: 'sicak'   } },

  // ── AKSİYON / EKSTREM SPOR KATEGORİLERİ ──────────────────────────
  // 360° video geldiğinde: rüzgar sesi filtrele, odak noktasını kilitle
  motor:      { lut: 'teal-orange',   arka: 'asfalt', bpm: 135, efekt: 'speed-ramp',   ton: 'guc',
                _360: { orbit: 'low-angle', ruzgar: true, takip: 'arac' } },
  suAlti:     { lut: 'deep-blue',     arka: 'su',     bpm: 95,  efekt: 'slow-zoom',    ton: 'gizem',
                _360: { orbit: 'surround', ruzgar: false, takip: 'dalici' } },
  parasut:    { lut: 'high-contrast', arka: 'gokyuzu',bpm: 128, efekt: 'smash-cut',    ton: 'ozgurluk',
                _360: { orbit: 'free-fall', ruzgar: true, takip: 'atlet' } },
  snowboard:  { lut: 'cold-blue',     arka: 'kar',    bpm: 128, efekt: 'shake-zoom',   ton: 'enerji',
                _360: { orbit: 'follow-cam', ruzgar: true, takip: 'sporcu' } },
  tekne:      { lut: 'teal-cyan',     arka: 'deniz',  bpm: 115, efekt: 'zoom-punch',   ton: 'dinamik',
                _360: { orbit: 'horizon', ruzgar: true, takip: 'tekne' } },
  pist:       { lut: 'teal-orange',   arka: 'pist',   bpm: 140, efekt: 'speed-ramp',   ton: 'guc',
                _360: { orbit: 'cockpit', ruzgar: true, takip: 'arac' } },
};

// Her kategoride kullanılabilir efekt havuzu (tekrar önleme için)
const EFEKT_HAVUZU = {
  gida:       ['slow-zoom', 'slow-pan', 'soft-fade', 'crossfade'],
  icecek:     ['flash', 'glitch', 'zoom-punch', 'smash-cut'],
  kozmetik:   ['soft-fade', 'slow-zoom', 'crossfade', 'light-leak'],
  parfum:     ['glitch-soft', 'soft-fade', 'slow-zoom', 'light-leak'],
  giyim:      ['slide', 'zoom-punch', 'whip-pan', 'match-cut'],
  ayakkabi:   ['zoom-punch', 'shake-zoom', 'smash-cut', 'slide'],
  elektronik: ['glitch', 'flash', 'zoom-punch', 'smash-cut'],
  spor:       ['shake-zoom', 'zoom-punch', 'smash-cut', 'whip-pan'],
  taki:       ['slow-zoom', 'soft-fade', 'light-leak', 'crossfade'],
  aksesuar:   ['soft-fade', 'slow-zoom', 'light-leak', 'slide'],
  'ev-yasam': ['slow-pan', 'soft-fade', 'crossfade', 'slow-zoom'],
  // Aksiyon/Ekstrem
  motor:      ['speed-ramp', 'smash-cut', 'shake-zoom', 'whip-pan', 'zoom-punch'],
  suAlti:     ['slow-zoom', 'soft-fade', 'crossfade', 'slow-pan', 'light-leak'],
  parasut:    ['smash-cut', 'speed-ramp', 'shake-zoom', 'whip-pan', 'zoom-punch'],
  snowboard:  ['shake-zoom', 'speed-ramp', 'smash-cut', 'whip-pan', 'zoom-punch'],
  tekne:      ['zoom-punch', 'whip-pan', 'speed-ramp', 'shake-zoom', 'smash-cut'],
  pist:       ['speed-ramp', 'smash-cut', 'shake-zoom', 'whip-pan', 'zoom-punch'],
};

const KANAL_RENK = {
  'golden-hour': '#f5a623', cinema: '#1a1a2e', 'teal-orange': '#ff6600', none: '#ffffff',
};

// ── Firestore bağlantısı ──
function getDb() {
  try {
    const { Firestore } = require('@google-cloud/firestore');
    return new Firestore({ projectId: process.env.FIRESTORE_PROJECT_ID || 'photoreel-491017' });
  } catch(e) { return null; }
}

// ──────────────────────────────────────────────────────────────────
// ÖĞRENME SİSTEMİ — BİRİKİMLİ, SILINMEZ
// ──────────────────────────────────────────────────────────────────

/**
 * Kategori ağırlıklarını Firestore'dan yükle
 * Yoksa varsayılan KATEGORI_PARAMS döner
 */
async function ogrenilmisParametreler(kategori) {
  const db = getDb();
  if (!db) return KATEGORI_PARAMS[kategori] || KATEGORI_PARAMS.giyim;
  try {
    const doc = await db.collection('fenix-agirliklar').doc(kategori).get();
    if (!doc.exists) return KATEGORI_PARAMS[kategori] || KATEGORI_PARAMS.giyim;
    const d = doc.data();
    // En yüksek skorlu kombinasyonu döndür
    const best = d.kombinasyonlar
      ? Object.entries(d.kombinasyonlar).sort((a, b) => b[1].skor - a[1].skor)[0]
      : null;
    if (best && best[1].skor >= 6) {
      logger.info(`🧠 Öğrenilmiş parametre kullanılıyor: ${kategori}`, { kombinasyon: best[0], skor: best[1].skor });
      return { ...KATEGORI_PARAMS[kategori] || {}, ...best[1].params };
    }
    return KATEGORI_PARAMS[kategori] || KATEGORI_PARAMS.giyim;
  } catch(e) {
    return KATEGORI_PARAMS[kategori] || KATEGORI_PARAMS.giyim;
  }
}

/**
 * Son kullanılan efekti getir — tekrar önleme
 */
async function sonEfekt(kategori) {
  const db = getDb();
  if (!db) return null;
  try {
    const doc = await db.collection('fenix-efekt-gecmis').doc(kategori).get();
    return doc.exists ? doc.data().sonEfekt : null;
  } catch(e) { return null; }
}

/**
 * Efekti kaydet — bir dahaki seferinde farklı seçilsin
 */
async function efektKaydet(kategori, efekt) {
  const db = getDb();
  if (!db) return;
  try {
    await db.collection('fenix-efekt-gecmis').doc(kategori).set({
      sonEfekt: efekt,
      guncellendi: new Date().toISOString(),
    });
  } catch(e) { /* sessiz */ }
}

/**
 * Efekt tekrar önleme — aynı efekt üst üste gelmez
 */
async function efektSec(kategori, varsayilan) {
  const havuz = EFEKT_HAVUZU[kategori] || [varsayilan];
  const son   = await sonEfekt(kategori);
  const secenekler = havuz.filter(e => e !== son);
  const secilen = secenekler.length > 0
    ? secenekler[Math.floor(Math.random() * secenekler.length)]
    : varsayilan;
  await efektKaydet(kategori, secilen);
  return secilen;
}

/**
 * 5 video ritim kuralı — hep sakin geldiyse zorla sert/keskin
 */
async function ritimKontrol(kategori) {
  const db = getDb();
  if (!db) return false;
  try {
    const doc = await db.collection('fenix-ritim').doc(kategori).get();
    if (!doc.exists) return false;
    const d = doc.data();
    // Son 5 video sakin mi?
    const sonBes = (d.gecmis || []).slice(-5);
    if (sonBes.length === 5 && sonBes.every(s => s === 'sakin')) {
      logger.info(`⚡ Ritim kuralı devreye girdi: ${kategori} → SERT/KESKİN moda geçildi`);
      return true; // sert moda geç
    }
    return false;
  } catch(e) { return false; }
}

async function ritimKaydet(kategori, tip /* 'sakin' | 'sert' */) {
  const db = getDb();
  if (!db) return;
  try {
    const ref  = db.collection('fenix-ritim').doc(kategori);
    const doc  = await ref.get();
    const mevcut = doc.exists ? (doc.data().gecmis || []) : [];
    const yeni = [...mevcut.slice(-19), tip]; // son 20 kayıt
    await ref.set({ gecmis: yeni, guncellendi: new Date().toISOString() });
  } catch(e) { /* sessiz */ }
}

/**
 * Her üretim adımını kaydet — başa dönerek öğrenir
 * Öğrendiklerini ASLA silmez, üzerine biriktirir
 */
async function adimKaydet(uretimId, adimAdi, veri, kategori) {
  try {
    await fenixBrain.recordLesson({
      category: `fenix-adim-${adimAdi}`,
      bug:      `[${uretimId}] ${kategori} → ${adimAdi}`,
      cause:    JSON.stringify(veri).substring(0, 300),
      fix:      `${kategori} kategorisinde ${adimAdi} adımı: ${JSON.stringify(veri).substring(0, 150)}`,
      actor:    'fenix-director',
    });
  } catch(e) { /* sessiz */ }
}

/**
 * Geri bildirim işle — kullanıcı beğendi/beğenmedi
 * Doğruları güçlendirir, yanlışları işaretler — hiçbirini silmez
 */
async function geribildirimIsle(uretimId, kategori, karar, begendi) {
  const db    = getDb();
  const kombo = `${karar.lut}__${karar.bpm}__${karar.efekt}__${karar.arka}`;
  const tip   = begendi ? 'sakin' : 'sert';

  // Ritim geçmişine kaydet
  await ritimKaydet(kategori, karar.bpm >= 110 ? 'sert' : 'sakin');

  // Ağırlık güncelle — silme, sadece skor değiştir
  if (db) {
    try {
      const ref = db.collection('fenix-agirliklar').doc(kategori);
      const doc = await ref.get();
      const mevcut = doc.exists ? (doc.data().kombinasyonlar || {}) : {};
      const eskiSkor = mevcut[kombo]?.skor || 5;
      const yeniSkor = begendi
        ? Math.min(10, eskiSkor + 0.5)   // beğenildi → güçlen
        : Math.max(1,  eskiSkor - 0.3);  // reddedildi → zayıfla ama silinme

      mevcut[kombo] = {
        params:     { lut: karar.lut, bpm: karar.bpm, efekt: karar.efekt, arka: karar.arka },
        skor:       yeniSkor,
        begeni:     (mevcut[kombo]?.begeni || 0) + (begendi ? 1 : 0),
        red:        (mevcut[kombo]?.red    || 0) + (begendi ? 0 : 1),
        guncellendi: new Date().toISOString(),
      };

      await ref.set({ kombinasyonlar: mevcut, guncellendi: new Date().toISOString() });
    } catch(e) { /* sessiz */ }
  }

  // Fenix brain'e de kaydet
  await fenixBrain.recordLesson({
    category: begendi ? 'fenix-onaylandi' : 'fenix-reddedildi',
    bug:      `[${uretimId}] ${kategori} geri bildirim: ${begendi ? '✅ BEĞENİLDİ' : '❌ REDDEDİLDİ'}`,
    cause:    `LUT:${karar.lut} BPM:${karar.bpm} efekt:${karar.efekt} arka:${karar.arka}`,
    fix:      begendi
      ? `${kategori} için ÇALIŞIYOR: ${kombo} — bir dahaki seferde yeniden dene`
      : `${kategori} için ÇALIŞMIYOR: ${kombo} — alternatif kombinasyon dene`,
    actor: 'fenix-director',
  }).catch(() => {});

  logger.info(`📚 Geri bildirim işlendi — ${kategori} ${begendi ? '✅' : '❌'}`, { uretimId, kombo });
}

// ──────────────────────────────────────────────────────────────────
// ÜRETİM PIPELINE
// ──────────────────────────────────────────────────────────────────

// ── fal.ai API çağrısı ──
async function falRequest(endpoint, body) {
  const url = `https://fal.run/${endpoint}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`fal.ai ${endpoint} hata ${res.status}: ${err.substring(0, 200)}`);
  }
  return res.json();
}

// ── Gemini Vision kalite skoru ──
async function scoreImage(imageUrl) {
  if (!GEMINI_KEY) return 7;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: 'Bu ürün fotoğrafını değerlendir. Ticari reklam kalitesi için 1-10 puan ver. SADECE rakam döndür.' },
              { inline_data: { mime_type: 'image/jpeg', data: imageUrl.startsWith('data:') ? imageUrl.split(',')[1] : '' } },
            ],
          }],
          generationConfig: { maxOutputTokens: 10, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
        }),
      }
    );
    const d   = await res.json();
    const txt = d.candidates?.[0]?.content?.parts?.[0]?.text || '7';
    return Math.min(10, Math.max(1, parseInt(txt) || 7));
  } catch(e) { return 7; }
}

// ── ADIM 1: Karar motoru (öğrenilmiş ağırlıkları kullanır) ──
async function kararAl(brief) {
  const kategori = brief.kategori || 'giyim';
  const urun     = brief.urun     || kategori;
  const platform = brief.platform || 'reels';
  const sure     = brief.sure     || 15;

  // Öğrenilmiş parametreleri yükle (yoksa varsayılan)
  const params = await ogrenilmisParametreler(kategori);

  // Efekt tekrar önleme
  const efekt = await efektSec(kategori, params.efekt);

  // Ritim kontrolü — 5 video sakin geldiyse sert moda geç
  const sertMod = await ritimKontrol(kategori);
  const bpm     = sertMod ? Math.min(128, (params.bpm || 100) + 20) : (params.bpm || 100);
  const gercekEfekt = sertMod ? (EFEKT_HAVUZU[kategori]?.slice(-2)[0] || efekt) : efekt;

  return {
    kategori, urun, platform, sure,
    ...params,
    bpm, efekt: gercekEfekt,
    sertMod,
    sahne1Prompt: `${urun}, ${params.arka} background, ${params.lut} color grade, professional product photography, hyperrealistic, 9:16 vertical, 4K commercial`,
    sahne2Prompt: `${urun} in use, lifestyle context, ${params.ton} mood, ${params.lut} LUT, dynamic composition, 9:16`,
    videoPrompt1: `Slow cinematic orbit around ${urun}, subtle zoom, ${gercekEfekt} effect, ${Math.floor(sure/3)} seconds, premium quality`,
    videoPrompt2: `Dynamic movement with ${urun}, ${gercekEfekt}, energetic, ${Math.floor(sure/3)} seconds`,
    kancaMetni:   brief.kanca || `${urun} ile fark yarat`,
    cta:          brief.cta   || 'Kaydet ve paylaş',
    sirketIsmi:   brief.sirketIsmi || null, // şirket ismi yoksa branding gösterilmez
  };
}

// ── ADIM 2: Flux görsel üretimi ──
async function gorselUret(prompt, options = {}) {
  logger.info('🎨 Flux görsel üretiliyor...', { prompt: prompt.substring(0, 80) });
  const result = await falRequest('fal-ai/flux-pro/v1.1', {
    prompt,
    image_size:            { width: 1080, height: 1920 },
    num_images:            1,
    enable_safety_checker: false,
    output_format:         'jpeg',
    ...options,
  });
  const url = result.images?.[0]?.url;
  if (!url) throw new Error('Flux görsel URL boş');
  logger.info('✅ Flux görsel hazır', { url: url.substring(0, 60) });
  return url;
}

// ── ADIM 3: Kling video üretimi ──
async function videoUret(imageUrl, prompt, sureSn = 5) {
  logger.info('🎬 Kling video üretiliyor...', { prompt: prompt.substring(0, 80) });
  const result = await falRequest('fal-ai/kling-video/v1.6/standard/image-to-video', {
    image_url:    imageUrl,
    prompt,
    duration:     sureSn <= 5 ? '5' : '10',
    aspect_ratio: '9:16',
  });

  const requestId = result.request_id;
  if (!requestId) throw new Error('Kling request_id boş');

  logger.info('⏳ Kling işleniyor...', { requestId });
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const status = await fetch(
      `https://queue.fal.run/fal-ai/kling-video/v1.6/standard/image-to-video/requests/${requestId}`,
      { headers: { 'Authorization': `Key ${FAL_KEY}` } }
    ).then(r => r.json());

    if (status.status === 'COMPLETED') {
      const videoUrl = status.output?.video?.url;
      if (!videoUrl) throw new Error('Kling video URL boş');
      logger.info('✅ Kling video hazır', { url: videoUrl.substring(0, 60) });
      return videoUrl;
    }
    if (status.status === 'FAILED') throw new Error('Kling video üretim başarısız');
  }
  throw new Error('Kling timeout (150sn)');
}

// ── ADIM 4: İçeriği birleştir ──
async function icerikBirlestir(karar, sahne1Url, sahne2Url, video1Url, video2Url) {
  return {
    sahne1:      sahne1Url,
    sahne2:      sahne2Url,
    video1:      video1Url,
    video2:      video2Url,
    kanal:       KANAL_RENK[karar.lut] || '#ffffff',
    kanca:       karar.kancaMetni,
    cta:         karar.cta,
    bpm:         karar.bpm,
    efekt:       karar.efekt,
    platform:    karar.platform,
    sure:        karar.sure,
    // Branding — şirket ismi yoksa gösterilmez
    sirketIsmi:  karar.sirketIsmi || null,
    bitisKarti:  !!karar.sirketIsmi,
    watermark:   !!karar.sirketIsmi,
  };
}

// ──────────────────────────────────────────────────────────────────
// ANA ÜRETİM FONKSİYONU — TAM DÖNGÜ
// ──────────────────────────────────────────────────────────────────
async function produce(brief) {
  if (!FAL_KEY) throw new Error('FAL_API_KEY eksik');

  const uretimId  = `uretim-${Date.now()}`;
  const baslangic = Date.now();
  logger.info('🚀 Fenix Director başladı', { uretimId, brief });

  // ── ADIM 1: Karar ──
  const karar = await kararAl(brief);
  logger.info('🧠 Karar alındı', {
    kategori: karar.kategori,
    bpm:      karar.bpm,
    efekt:    karar.efekt,
    sertMod:  karar.sertMod,
  });
  await adimKaydet(uretimId, 'karar', {
    kategori: karar.kategori,
    lut:      karar.lut,
    bpm:      karar.bpm,
    efekt:    karar.efekt,
    arka:     karar.arka,
    sertMod:  karar.sertMod,
  }, karar.kategori);

  // ── ADIM 2: Görseller (paralel) ──
  const [sahne1Url, sahne2Url] = await Promise.all([
    gorselUret(karar.sahne1Prompt),
    gorselUret(karar.sahne2Prompt),
  ]);
  await adimKaydet(uretimId, 'gorsel', {
    prompt1: karar.sahne1Prompt.substring(0, 100),
    sahne1:  sahne1Url.substring(0, 60),
  }, karar.kategori);

  // ── ADIM 3: Kalite kontrol ──
  const gorselSkor = await scoreImage(sahne1Url);
  logger.info(`📊 Görsel kalite skoru: ${gorselSkor}/10`);
  await adimKaydet(uretimId, 'kalite', {
    gorselSkor,
    kategori: karar.kategori,
    lut:      karar.lut,
  }, karar.kategori);

  // ── ADIM 4: Videolar (sıralı — Kling rate limit) ──
  const video1Url = await videoUret(sahne1Url, karar.videoPrompt1, Math.floor(karar.sure / 3));
  await adimKaydet(uretimId, 'video1', {
    prompt:   karar.videoPrompt1.substring(0, 100),
    efekt:    karar.efekt,
    bpm:      karar.bpm,
    videoUrl: video1Url.substring(0, 60),
  }, karar.kategori);

  const video2Url = await videoUret(sahne2Url, karar.videoPrompt2, Math.floor(karar.sure / 3));
  await adimKaydet(uretimId, 'video2', {
    prompt:   karar.videoPrompt2.substring(0, 100),
    efekt:    karar.efekt,
    videoUrl: video2Url.substring(0, 60),
  }, karar.kategori);

  // ── ADIM 5: Birleştir ──
  const sonuc = await icerikBirlestir(karar, sahne1Url, sahne2Url, video1Url, video2Url);
  await adimKaydet(uretimId, 'birlestir', {
    bpm:       sonuc.bpm,
    efekt:     sonuc.efekt,
    bitisKarti: sonuc.bitisKarti,
  }, karar.kategori);

  // ── ADIM 6: Genel öğrenme kaydı ──
  const basarili = gorselSkor >= 7;
  await fenixBrain.recordLesson({
    category: 'fenix-uretim-turu',
    bug:      `[${uretimId}] ${karar.kategori} — ${basarili ? 'KALİTELİ' : 'GELİŞTİRİLECEK'}`,
    cause:    `LUT:${karar.lut} BPM:${karar.bpm} efekt:${karar.efekt} skor:${gorselSkor}/10`,
    fix:      basarili
      ? `${karar.kategori}: ${karar.lut}+${karar.bpm}bpm+${karar.efekt} → başarılı kombinasyon`
      : `${karar.kategori}: skor ${gorselSkor}/10 → ${karar.lut} veya ${karar.efekt} gözden geçir`,
    actor: 'fenix-director',
  }).catch(() => {});

  const sure = ((Date.now() - baslangic) / 1000).toFixed(1);
  logger.info(`✅ Üretim tamamlandı — ${sure}sn`, { uretimId, gorselSkor });

  return {
    ok:       true,
    uretimId,
    gorselSkor,
    sure:     parseFloat(sure),
    karar,
    sonuc,
    // Geri bildirim için endpoint'e iletilecek
    _geribildirim: (begendi) => geribildirimIsle(uretimId, karar.kategori, karar, begendi),
  };
}

// ── Test üretimi ──
async function testUret(kategori = 'spor') {
  return produce({
    kategori,
    urun:     kategori === 'spor' ? 'spor ayakkabı' : 'ürün',
    platform: 'reels',
    sure:     15,
    kanca:    'Farkı hisset',
    cta:      'Kaydet',
  });
}

// ──────────────────────────────────────────────────────────────────
// 360° İŞLEME — Kategoriye özel tam pipeline
// ──────────────────────────────────────────────────────────────────

/**
 * 360° video/fotoğraf geldiğinde çalışır.
 * Kategoriye göre: orbit tipi, rüzgar filtresi, odak takibi, LUT, BPM, reels export
 *
 * @param {string} kategori  - motor | suAlti | snowboard | giyim | kozmetik | vb.
 * @param {string} dosyaYolu - yüklenen 360° dosya
 * @param {object} brief     - { sirketIsmi, kanca }
 */
async function isle360(kategori, dosyaYolu, brief = {}) {
  const params  = KATEGORI_PARAMS[kategori] || KATEGORI_PARAMS['spor'];
  const k360    = params._360 || { orbit: 'slow-turntable', ruzgar: false, takip: 'urun', hiz: 'orta', isik: 'studio' };

  logger.info(`🌐 360° işleme başladı`, { kategori, orbit: k360.orbit, ruzgar: k360.ruzgar });

  const adimlar = [];

  // 1. FORMAT — Equirectangular doğrula
  adimlar.push({ adim: 1, islem: 'format-kontrol', durum: 'yapılıyor', detay: 'equirectangular 2:1 oranı kontrol' });

  // 2. RÜZGAR SESİ — FFmpeg highpass filtresi
  if (k360.ruzgar) {
    adimlar.push({
      adim: 2, islem: 'ruzgar-filtre', durum: 'yapılıyor',
      detay: 'FFmpeg: highpass f=200, lowpass f=8000 — rüzgar bastır',
      ffmpegCmd: `ffmpeg -i input.mp4 -af "highpass=f=200,lowpass=f=8000,afftdn=nf=-25" output_clean.mp4`,
    });
  } else {
    adimlar.push({ adim: 2, islem: 'ruzgar-filtre', durum: 'atlandı', detay: `${kategori} için rüzgar filtresi yok` });
  }

  // 3. PLAKA BLUR — motor ve pist için otomatik
  if (['motor','pist'].includes(kategori)) {
    adimlar.push({ adim: 3, islem: 'plaka-blur', durum: 'yapılıyor', detay: 'Gemini Vision → plaka tespiti → FFmpeg blur' });
  }

  // 4. ODAK NOKTASI — Gemini Vision ile tespit
  adimlar.push({
    adim: 4, islem: 'odak-tespit', durum: 'yapılıyor',
    detay: `Gemini Vision → ${k360.takip} tespit → koordinat kilitle`,
    takipHedefi: k360.takip,
  });

  // 5. LUT UYGULA — kategoriye özel renk gradini
  adimlar.push({
    adim: 5, islem: 'lut-uygula', durum: 'yapılıyor',
    detay: `LUT: ${params.lut} | Işık: ${k360.isik} | Ton: ${params.ton}`,
  });

  // 6. ORBİT TIPI — kamera hareketi
  const orbitAciklamalar = {
    'slow-turntable': 'Ürün etrafında sabit hızlı yatay dönüş',
    'close-texture':  'Ürüne yakın, doku detayı gösteren yavaş dönüş',
    'manken-orbit':   'Manken etrafında tüm açılardan yatay dönüş',
    'low-detail':     'Alçak açıdan yukarı bakarak dönüş — ürün büyük görünür',
    'screen-showcase':'Ekranı ön planda tutan, hafif tilt dönüşü',
    'action-follow':  'Sporcu/nesneyi takip eden serbest kamera',
    'mekan-turu':     'Geniş açı, mekanın tamamını kapsayan yavaş tur',
    'low-angle':      'Alçak açı — araç büyük, güçlü görünür',
    'surround':       '360° su altı çevresi — yavaş, gizemli',
    'free-fall':      'Serbest düşüş hissi — dinamik açı değişimi',
    'follow-cam':     'Sporcuyu arkadan takip — yüksek enerji',
    'horizon':        'Deniz horizonu kilitleri — tekne ön planda',
    'cockpit':        'Kokpit içi bakış — hız hissi maksimum',
  };
  adimlar.push({
    adim: 6, islem: 'orbit-uygula', durum: 'yapılıyor',
    orbit: k360.orbit,
    detay: orbitAciklamalar[k360.orbit] || k360.orbit,
    hiz: k360.hiz,
  });

  // 7. BPM SENKRON — müzik + geçiş senkronizasyonu
  adimlar.push({
    adim: 7, islem: 'bpm-senkron', durum: 'yapılıyor',
    detay: `BPM: ${params.bpm} — her beat'te sahne değişimi, frame-perfect`,
  });

  // 8. REELS EXPORT — 9:16 kırp + bitiş kartı
  adimlar.push({
    adim: 8, islem: 'reels-export', durum: 'yapılıyor',
    detay: '9:16 crop (center-weighted) → MP4 → bitiş kartı' + (brief.sirketIsmi ? ` (${brief.sirketIsmi})` : ' (şirket yok — branding eklenmez)'),
  });

  // Adımları logla
  for (const a of adimlar) {
    await adimKaydet(kategori, a.islem, a);
  }

  logger.info(`✅ 360° plan hazır`, { kategori, adimSayisi: adimlar.length, orbit: k360.orbit });

  return {
    ok:      true,
    kategori,
    params,
    _360:    k360,
    adimlar,
    ozet: `${kategori} → ${k360.orbit} orbit | BPM ${params.bpm} | ${k360.ruzgar ? 'Rüzgar filtreli' : 'Rüzgar yok'} | ${k360.takip} takip`,
  };
}

module.exports = {
  produce,
  isle360,
  testUret,
  kararAl,
  gorselUret,
  videoUret,
  geribildirimIsle,
  KATEGORI_PARAMS,
};
