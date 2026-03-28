/**
 * Fenix Trainer — $20 Bütçeli Toplu Eğitim
 * Gemini API ile Fenix hafızasını dolduran servis.
 * Budget'a ulaşınca otomatik durur.
 */

const fenixBrain = require('./fenix-brain');
const logger = require('../utils/logger');

const GEMINI_KEY  = process.env.GEMINI_API_KEY;
const MODEL       = 'gemini-2.5-flash';
const COST_INPUT  = 0.150 / 1e6;
const COST_OUTPUT = 0.600 / 1e6;
const DELAY_MS    = 400;  // Thinking kapalı, API hızlı yanıtlıyor
const BATCH       = 3;   // 3 topic/çağrı — thinking kapalıyken truncation yok
const PER_TOPIC   = 8;   // 8 ders/topic
const CHECKPOINT_EVERY = 50;

// ── Singleton state ──
const state = {
  running:       false,
  stopRequested: false,
  totalCost:     0,
  totalLessons:  0,
  phase:         null,
  phases:        [],
  round:         1,
  topicIdx:      0,
  budget:        20,
};

// ── Firestore checkpoint ──
function getDb() {
  try {
    const { Firestore } = require('@google-cloud/firestore');
    return new Firestore({ projectId: process.env.FIRESTORE_PROJECT_ID || 'photoreel-491017' });
  } catch(e) { return null; }
}

async function saveCheckpoint() {
  const db = getDb();
  if (!db) return;
  try {
    await db.collection('fenix-trainer').doc('checkpoint').set({
      running:      state.running,
      totalCost:    state.totalCost,
      totalLessons: state.totalLessons,
      round:        state.round,
      topicIdx:     state.topicIdx,
      budget:       state.budget,
      phases:       state.phases.slice(-20),
      updatedAt:    new Date().toISOString(),
    });
  } catch(e) { /* sessiz */ }
}

async function loadCheckpoint() {
  const db = getDb();
  if (!db) return null;
  try {
    const doc = await db.collection('fenix-trainer').doc('checkpoint').get();
    if (!doc.exists) return null;
    const d = doc.data();
    // 6 saatten eski checkpoint'i yoksay
    if (d.updatedAt && Date.now() - new Date(d.updatedAt).getTime() > 6 * 3600 * 1000) return null;
    return d;
  } catch(e) { return null; }
}

async function clearCheckpoint() {
  const db = getDb();
  if (!db) return;
  try { await db.collection('fenix-trainer').doc('checkpoint').delete(); } catch(e) {}
}

// ── Domain topic listesi — VİZYON ODAKLI ──
// 3 Ana Alan: Kategori Tanıma | Reels Üretme | 360 Video Düzenleme
const TOPICS = [

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 1. KATEGORİ TANIMA — Fenix ürünü görünce ne yapmalı?
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // Görsel analiz ile kategori tespiti
  ...['kategori-taki-görsel-ipuçları','kategori-kozmetik-ambalaj-tanıma',
      'kategori-giyim-kumaş-doku','kategori-ayakkabi-taban-profil',
      'kategori-elektronik-ekran-logo','kategori-gida-renk-doku-tazelik',
      'kategori-parfum-şişe-formu','kategori-spor-ürün-renk-enerji',
      'kategori-takı-malzeme-parlaklık','kategori-ev-yasam-ortam-uyumu',
      'kategori-araba-çizgi-yansıma','kategori-bebek-pastel-yumuşaklık']
    .map(t => ({ topic: t, cat: 'kategori-tanima-gorsel' })),

  // Kategori → otomatik parametre kararı
  ...['karar-taki-lut-bpm-efekt','karar-kozmetik-lut-bpm-efekt',
      'karar-giyim-lut-bpm-efekt','karar-ayakkabi-lut-bpm-efekt',
      'karar-elektronik-lut-bpm-efekt','karar-gida-lut-bpm-efekt',
      'karar-parfum-lut-bpm-efekt','karar-spor-lut-bpm-efekt',
      'karar-luks-segment-parametreler','karar-ekonomik-segment-parametreler',
      'karar-genc-kitle-parametreler','karar-yetiskin-kitle-parametreler',
      'karar-erkek-kitle-ton','karar-kadin-kitle-ton',
      'karar-arka-plan-seçimi','karar-renk-sıcaklığı-ürün-uyumu']
    .map(t => ({ topic: t, cat: 'kategori-tanima-karar' })),

  // Müşteri brief'inden kategori çıkarma
  ...['brief-anahtar-kelime-analizi','brief-renk-talebi-yorumlama',
      'brief-hedef-kitle-tespiti','brief-bütçe-segment-belirleme',
      'brief-platform-tercihi-analizi','brief-ton-duygu-çıkarma',
      'brief-marka-kimlik-uyumu','brief-sezon-kampanya-etkisi',
      'brief-referans-içerik-analizi','brief-rakip-analizi']
    .map(t => ({ topic: t, cat: 'kategori-tanima-brief' })),

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 2. REELS ÜRETİMİ — AI ile sıfırdan içerik
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // Flux ile görsel üretim promptları
  ...['flux-prompt-kozmetik-beyaz-studio','flux-prompt-taki-siyah-luks',
      'flux-prompt-giyim-lifestyle','flux-prompt-gida-sicak-ahsap',
      'flux-prompt-elektronik-dark-tech','flux-prompt-spor-dinamik-doga',
      'flux-prompt-parfum-gizem-duman','flux-prompt-ayakkabi-teal-orange',
      'flux-negatif-prompt-kurallar','flux-aspect-ratio-916-reels',
      'flux-lighting-ürün-tipi','flux-background-kategori-uyumu',
      'flux-color-grade-lut-uyumu','flux-hyperrealistic-ticari']
    .map(t => ({ topic: t, cat: 'reels-gorsel-uretim' })),

  // Kling ile video animasyon promptları
  ...['kling-orbit-luks-urun','kling-zoom-in-detay','kling-slow-motion-kozmetik',
      'kling-dynamic-spor','kling-float-taki','kling-reveal-elektronik',
      'kling-lifestyle-giyim','kling-steam-gida','kling-particle-parfum',
      'kling-sure-secimi-5-10sn','kling-hareket-hizi-bpm-uyumu',
      'kling-kamera-acisi-kompozisyon','kling-prompt-yapisi-en-iyi',
      'kling-image-to-video-ipuclari','kling-kalite-skor-kriterleri']
    .map(t => ({ topic: t, cat: 'reels-video-animasyon' })),

  // Reels kurgu ve kompozisyon
  ...['reels-hook-ilk-3-saniye','reels-hook-gorsel-impact','reels-hook-merak',
      'reels-kurgu-beat-sync-bpm','reels-kurgu-zoom-punch-gecis',
      'reels-kurgu-match-cut','reels-kurgu-slow-fast-kontrast',
      'reels-caption-bold-center','reels-caption-karaoke',
      'reels-cta-kaydet','reels-cta-yorum-tetikle','reels-cta-dm',
      'reels-muzik-bpm-kategori','reels-muzik-mood-secimi',
      'reels-algoritma-completion','reels-algoritma-save-trigger',
      'reels-916-kompozisyon','reels-ürün-close-up',
      'reels-bitis-karti-tasarim','reels-kancan-metin-tonu']
    .map(t => ({ topic: t, cat: 'reels-kurgu-kompozisyon' })),

  // Renk & LUT kararları
  ...['lut-teal-orange-spor-elektronik','lut-cinema-luks-parfum',
      'lut-golden-hour-gida-ev','lut-none-kozmetik-dogal',
      'renk-taki-altin-gumus','renk-kozmetik-rose-nude',
      'renk-spor-neon-enerji','renk-luks-siyah-altin',
      'renk-gida-sicak-dogal','renk-teknoloji-mavi',
      'color-grading-musteri-marka','split-toning-sahne',
      'vignette-odak-etkisi','film-grain-premium-his']
    .map(t => ({ topic: t, cat: 'reels-renk-lut' })),

  // Müzik & ses eşleştirme
  ...['bpm-taki-90','bpm-kozmetik-85','bpm-giyim-104','bpm-spor-128',
      'bpm-gida-78','bpm-elektronik-120','bpm-luks-75',
      'mood-energetik-spor','mood-huzurlu-kozmetik','mood-luks-parfum',
      'beat-drop-ani-gecis','voiceover-turkce-ton',
      'muzik-marka-kimlik','ses-efekti-urun-impact']
    .map(t => ({ topic: t, cat: 'reels-muzik-ses' })),

  // Geçiş teknikleri — Reels için
  ...['gecis-zoom-punch-beat-ani','gecis-whip-pan-hiz',
      'gecis-match-cut-sahne-degisim','gecis-smash-cut-kontrast',
      'gecis-j-cut-ses-once-gorsel','gecis-l-cut-ses-devam',
      'gecis-fade-black-sahne-bitis','gecis-crossfade-yumusak',
      'gecis-light-leak-premium','gecis-glitch-teknoloji-spor',
      'gecis-slow-zoom-luks','gecis-slide-giyim',
      'gecis-beat-drop-efekt','gecis-freeze-frame-aksiyon',
      'gecis-speed-ramp-hizlanma','gecis-kategoriye-gore-secim',
      'gecis-suresi-optimum','gecis-renk-uyumu-oncesi-sonrasi']
    .map(t => ({ topic: t, cat: 'reels-gecis-teknikleri' })),

  // Müzik–video senkronizasyonu
  ...['muzik-beat-map-video','muzik-bpm-kesim-hesabi',
      'muzik-drop-an-gorsel-patlama','muzik-intro-urun-giris',
      'muzik-build-up-gerilim','muzik-chorus-ana-sahne',
      'muzik-outro-cta-karti','muzik-tempo-degisim-kamera',
      'muzik-kategori-eslestirme-tam','muzik-marka-tutarliligi',
      'muzik-telif-guvenli-secim','muzik-trend-ses-kullanim',
      'muzik-voiceover-denge','muzik-ses-efekti-zamanlama',
      'muzik-duygusal-etki-analizi']
    .map(t => ({ topic: t, cat: 'reels-muzik-senkron' })),

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 3. 360° VİDEO DÜZENLEME & BİRLEŞTİRME
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // Equirectangular format & Three.js
  ...['360-equirectangular-format-anlama','360-threejs-viewer-kurulum',
      '360-gyroscope-entegrasyon','360-pinch-zoom-kullanici',
      '360-hotspot-ekleme','360-nadir-zenith-gizleme',
      '360-stitch-hata-düzeltme','360-metadata-youtube-vr']
    .map(t => ({ topic: t, cat: '360-format-viewer' })),

  // 360 klip birleştirme & geçişler
  ...['360-klip-birlestirme-sorunsuz','360-gecis-fade-siyah',
      '360-gecis-crossfade','360-gecis-match-cut-sahne',
      '360-gecis-kamera-hareketi','360-klipler-arasi-renk-uyumu',
      '360-ses-spatial-audio','360-muzik-360-ortam-uyumu',
      '360-timeline-kurgu','360-sahne-sirasi-hikaye']
    .map(t => ({ topic: t, cat: '360-birlestirme-gecis' })),

  // 360 export & platform
  ...['360-export-mp4-h264','360-export-youtube-360',
      '360-export-vr-headset','360-export-tiny-planet',
      '360-cozunurluk-4k-8k','360-bitrate-kalite',
      '360-instagram-360-format','360-tiktok-360-uyum',
      '360-dosya-boyutu-optimize','360-thumbnail-equirect']
    .map(t => ({ topic: t, cat: '360-export-platform' })),

  // Fenix Studio Master Prompt kategorileri
  ...['fenix-gida-lut-golden-hour','fenix-gida-muzik-78bpm','fenix-gida-beat-slow-zoom',
      'fenix-gida-kancan-metin','fenix-gida-arka-ahsap','fenix-gida-musteri-beklenti',
      'fenix-icecek-lut-cinema','fenix-icecek-muzik-104bpm','fenix-icecek-beat-flash',
      'fenix-icecek-kancan-serin','fenix-icecek-arka-siyah',
      'fenix-kozmetik-lut-none-dogal','fenix-kozmetik-muzik-85bpm','fenix-kozmetik-beat-soft-fade',
      'fenix-kozmetik-kancan-luks','fenix-kozmetik-arka-beyaz','fenix-kozmetik-isik-normalize',
      'fenix-parfum-lut-cinema','fenix-parfum-muzik-85bpm','fenix-parfum-beat-glitch-soft',
      'fenix-parfum-kancan-gizem','fenix-parfum-arka-siyah',
      'fenix-giyim-lut-none','fenix-giyim-muzik-104bpm','fenix-giyim-beat-slide',
      'fenix-giyim-kancan-trend','fenix-giyim-arka-beyaz',
      'fenix-ayakkabi-lut-teal-orange','fenix-ayakkabi-muzik-128bpm','fenix-ayakkabi-beat-zoom-punch',
      'fenix-ayakkabi-kancan-guc','fenix-ayakkabi-arka-tas',
      'fenix-elektronik-lut-cinema','fenix-elektronik-muzik-120bpm','fenix-elektronik-beat-glitch',
      'fenix-elektronik-kancan-teknoloji','fenix-elektronik-arka-siyah',
      'fenix-spor-lut-teal-orange','fenix-spor-muzik-128bpm','fenix-spor-beat-shake-zoom',
      'fenix-spor-kancan-motivasyon','fenix-spor-arka-doga',
      'fenix-ev-yasam-lut-golden-hour','fenix-ev-yasam-muzik-78bpm','fenix-ev-yasam-beat-slow-pan',
      'fenix-ev-yasam-kancan-huzur','fenix-ev-yasam-arka-ahsap']
    .map(t => ({ topic: t, cat: 'fenix-studio-kategori' })),

  // ── Fenix Otonom Pipeline — 8 Adım Zekası ──
  ...['otonom-adim1-medya-al-analiz','otonom-adim2-kategori-tespiti','otonom-adim3-kancan-uretimi',
      'otonom-adim4-lut-arka-uygula','otonom-adim5-muzik-eslestirme','otonom-adim6-beat-efekt',
      'otonom-adim7-katman-birlestir','otonom-adim8-kalite-kontrol',
      'otonom-katman-k0-ham-medya','otonom-katman-k1-lut-filtre','otonom-katman-k2-kancan-metin',
      'otonom-katman-k3-marka-overlay','otonom-katman-k4-bitis-karti',
      'otonom-karar-kategori-otomatik','otonom-karar-lut-secimi','otonom-karar-bpm-secimi',
      'otonom-karar-kancan-ton','otonom-karar-cta-tipi',
      'otonom-isik-analizi-highlight','otonom-isik-golge-aydinlat','otonom-isik-sicaklik-ayar',
      'otonom-urun-retouch-leke','otonom-urun-keskinlik-artir','otonom-urun-renk-eslestir',
      'otonom-bpm-senkron-beat-gecis','otonom-bpm-flash-zamanlama','otonom-bpm-zoom-ritim',
      'otonom-bitis-karti-tasarim','otonom-bitis-karti-cta-buton','otonom-bitis-karti-marka-renk',
      'otonom-begendim-reddet-karar','otonom-yeniden-yap-trigger','otonom-export-png-mp4',
      'otonom-mod-hizli-fark','otonom-mod-pro-fark','otonom-mod-360-fark',
      'fenix-360-threejs-equirect','fenix-360-gyroscope','fenix-360-pinch-zoom',
      'fenix-360-export-yt360','fenix-360-export-vr','fenix-360-export-tiny-planet',
      'fenix-pro-katman-sistemi','fenix-pro-renk-egri','fenix-pro-figur-boyama',
      'fenix-hizli-sablon-secimi','fenix-hizli-urun-reels-wizard']
    .map(t => ({ topic: t, cat: 'fenix-otonom-pipeline' })),

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 4. E-TİCARET RETOUCH & MARKALAŞMA
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // Manken + ürün koruma kuralları
  ...['eticaret-manken-tespit-koru','eticaret-manken-urun-birlikte',
      'eticaret-highlight-normalize-kumas','eticaret-kirisiklik-ai-duzelt',
      'eticaret-doku-koru-bozukluk-duzelt','eticaret-giyim-retouch-kurallar',
      'eticaret-kozmetik-model-retouch','eticaret-ayakkabi-model-retouch',
      'eticaret-isik-dengeleme-urun','eticaret-renk-tutarlilik-kontrol',
      'eticaret-arka-plan-temizle','eticaret-urun-keskinlik-artir']
    .map(t => ({ topic: t, cat: 'eticaret-retouch' })),

  // Branding & şirket kimliği kuralları
  ...['branding-sirket-ismi-sol-alt','branding-bitis-karti-yapi',
      'branding-logo-pozisyon-video','branding-logo-kural-yoksa-gosterme',
      'branding-ilk-logo-ucretsiz-flux','branding-kredi-sistemi-mantigi',
      'branding-renk-kategori-uyumu','branding-cta-bitis-karti',
      'branding-watermark-saydam','branding-marka-tutarlilik',
      'branding-placeholder-yasak-kural','branding-logo-flux-prompt']
    .map(t => ({ topic: t, cat: 'branding-marka' })),

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 5. FENIX RİTİM & ÇEŞITLILIK ZEKASI
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // Efekt tekrar önleme — aynı ürüne farklı efekt
  ...['ritim-efekt-tekrar-onleme','ritim-efekt-havuzu-kategori',
      'ritim-onceki-efekt-firestore','ritim-farkli-efekt-secim-algoritmasi',
      'ritim-5-video-sakin-sert-gecis','ritim-kalip-tespit-zorunlu',
      'ritim-milimetrik-gecis-frame','ritim-bpm-senkron-zorunlu',
      'ritim-kategori-5-video-analiz','ritim-enerji-degisim-kurali',
      'ritim-sakin-sert-sakin-dongu','ritim-kullanici-urun-gecmisi']
    .map(t => ({ topic: t, cat: 'ritim-zekasi' })),

  // Kısa video tarama → Reels üretimi
  ...['kisa-video-urun-tespit','kisa-video-tarama-frame',
      'kisa-video-zoom-urun-ani','kisa-video-blur-arka-plan',
      'kisa-video-pan-takip-urun','kisa-video-yakinlastirma-an',
      'kisa-video-gecis-kategori-sert','kisa-video-muzik-bpm-eslestir',
      'kisa-video-reels-916-cikar','kisa-video-montaj-ritim']
    .map(t => ({ topic: t, cat: 'kisa-video-reels' })),

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 6. 360° KATEGORİYE ÖZEL KURALLAR
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ...['360-spor-aksiyon-takip','360-spor-ruzgar-ses-filtre',
      '360-spor-odak-nokta-kilit','360-gida-yavas-orbit-sicak',
      '360-elektronik-ekran-showcase','360-ev-yasam-mekan-turu',
      '360-kozmetik-texture-orbit','360-giyim-manken-orbit',
      '360-taki-isik-yansima-360','360-kategori-gecis-sert-yumusak',
      '360-sahneler-arasi-kategori-uyum','360-spatial-audio-kategori']
    .map(t => ({ topic: t, cat: '360-kategori-kurallari' })),

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 7. AKSİYON / EKSTREM SPOR KATEGORİLERİ
  //    Motor | Su Altı | Paraşüt | Snowboard | Tekne | Pist
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // Motor
  ...['motor-lut-teal-orange','motor-bpm-135','motor-efekt-speed-ramp',
      'motor-360-low-angle-orbit','motor-ruzgar-filtre','motor-arac-takip',
      'motor-asfalt-arka-plan','motor-guc-tonu','motor-plaka-blur']
    .map(t => ({ topic: t, cat: 'aksiyon-motor' })),

  // Su Altı
  ...['sualti-lut-deep-blue','sualti-bpm-95','sualti-efekt-slow-zoom',
      'sualti-360-surround-orbit','sualti-su-sesi-filtre','sualti-dalici-takip',
      'sualti-gizem-tonu','sualti-renk-grading-mavi','sualti-isik-huzme']
    .map(t => ({ topic: t, cat: 'aksiyon-sualti' })),

  // Paraşüt
  ...['parasut-lut-high-contrast','parasut-bpm-128','parasut-efekt-smash-cut',
      'parasut-360-free-fall-orbit','parasut-ruzgar-filtre','parasut-atlet-takip',
      'parasut-gokyuzu-arka-plan','parasut-ozgurluk-tonu','parasut-yukseklik-hissi']
    .map(t => ({ topic: t, cat: 'aksiyon-parasut' })),

  // Snowboard
  ...['snowboard-lut-cold-blue','snowboard-bpm-128','snowboard-efekt-shake-zoom',
      'snowboard-360-follow-cam','snowboard-ruzgar-filtre','snowboard-sporcu-takip',
      'snowboard-kar-arka-plan','snowboard-enerji-tonu','snowboard-kar-efekti']
    .map(t => ({ topic: t, cat: 'aksiyon-snowboard' })),

  // Tekne
  ...['tekne-lut-teal-cyan','tekne-bpm-115','tekne-efekt-zoom-punch',
      'tekne-360-horizon-orbit','tekne-ruzgar-filtre','tekne-tekne-takip',
      'tekne-deniz-arka-plan','tekne-dinamik-tonu','tekne-dalga-efekti']
    .map(t => ({ topic: t, cat: 'aksiyon-tekne' })),

  // Pist / Araç
  ...['pist-lut-teal-orange','pist-bpm-140','pist-efekt-speed-ramp',
      'pist-360-cockpit-orbit','pist-ruzgar-filtre','pist-arac-takip',
      'pist-guc-tonu','pist-hiz-gosterge','pist-seyircisiz-arka-plan']
    .map(t => ({ topic: t, cat: 'aksiyon-pist' })),

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 8. GELECEK PLANLAR — API geldiğinde sıfırdan başlama
  //    Fenix şimdi öğrenir, API gelince direkt uygular
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  // Ses Dublaj (ElevenLabs / HeyGen)
  ...['dublaj-ses-klonlama-profil','dublaj-elevenlabs-api-akis',
      'dublaj-heygen-lip-sync-pipeline','dublaj-turkce-ingilizce-ceviri',
      'dublaj-duygu-koruma-vurgu','dublaj-kategori-ses-tonu',
      'dublaj-urun-tanitim-sesi','dublaj-reels-ses-senkron',
      'dublaj-cok-dilli-export','dublaj-ses-arka-plan-ayir']
    .map(t => ({ topic: t, cat: 'plan-ses-dublaj' })),

  // FFmpeg Gerçek 360° İşleme
  ...['ffmpeg-equirectangular-format','ffmpeg-ruzgar-highpass-filtresi',
      'ffmpeg-speed-ramp-pts-manipulasyon','ffmpeg-plaka-blur-koordinat',
      'ffmpeg-reels-crop-center-weight','ffmpeg-bpm-sync-keyframe',
      'ffmpeg-spatial-audio-360','ffmpeg-lut-3dl-uygulama',
      'ffmpeg-orbit-kamera-hareketi','ffmpeg-9-16-export-optimize']
    .map(t => ({ topic: t, cat: 'plan-ffmpeg-360' })),

  // Manken + Ürün Segmentasyonu
  ...['segmentasyon-onnx-model-yukleme','segmentasyon-manken-tespit',
      'segmentasyon-urun-izolasyon','segmentasyon-highlight-normalize',
      'segmentasyon-kirisiklik-ai-duzelt','segmentasyon-kumas-doku-koru',
      'segmentasyon-arka-plan-sil-urun-koru','segmentasyon-model-mask-olustur',
      'segmentasyon-flux-img2img-retouch','segmentasyon-sonuc-kalite-kontrol']
    .map(t => ({ topic: t, cat: 'plan-segmentasyon' })),

  // Speed-Ramp Video Efekti
  ...['speedramp-hizli-an-tespit','speedramp-yavas-an-tespit',
      'speedramp-pts-manipulasyon-ffmpeg','speedramp-kategori-ritim-uyum',
      'speedramp-aksiyon-pik-nokta','speedramp-muzik-bpm-senkron',
      'speedramp-giris-cikis-yumusatma','speedramp-reels-format-export']
    .map(t => ({ topic: t, cat: 'plan-speedramp' })),

  // AssemblyAI Ses Analizi
  ...['assemblyai-ses-transkript','assemblyai-duygu-analizi-ses',
      'assemblyai-ruzgar-gurultu-tespit','assemblyai-bpm-ses-analiz',
      'assemblyai-konusma-sessizlik-ayir','assemblyai-kategori-ses-eslestir']
    .map(t => ({ topic: t, cat: 'plan-assemblyai' })),

  // Otonom Tam Pipeline (sıfır müdahale)
  ...['otonom-dosya-geldi-kategori-tara','otonom-sahne-uret-flux',
      'otonom-video-uret-kling','otonom-ses-ekle-muzik',
      'otonom-branding-karar-ver','otonom-reels-export-bildirim',
      'otonom-kalite-kontrol-gemini','otonom-begenmedi-yeniden-uret',
      'otonom-ogrenilenden-parametre-al','otonom-hic-soru-sormadan-bitir']
    .map(t => ({ topic: t, cat: 'plan-otonom-tam' })),
];

// ── Gemini çağrısı — responseMimeType ile saf JSON zorla ──
async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000); // 90s timeout
  let resp;
  try {
    resp = await fetch(url, {
      signal: controller.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.85,
          maxOutputTokens: 16384,
          responseMimeType: 'application/json',
          // Thinking devre dışı — tüm token bütçesi çıktıya gider, MAX_TOKENS kesilmez
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
  } finally { clearTimeout(timeout); }

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini HTTP ${resp.status}: ${errText.substring(0, 200)}`);
  }
  const data = await resp.json();

  if (data.error) throw new Error(`Gemini API hatası: ${data.error.message}`);

  const candidate = data.candidates?.[0] || {};
  const text  = candidate.content?.parts?.[0]?.text || '';
  const finish = candidate.finishReason || 'UNKNOWN';
  const usage = data.usageMetadata || {};
  const cost  = (usage.promptTokenCount || 0) * COST_INPUT +
                (usage.candidatesTokenCount || 0) * COST_OUTPUT;
  state.totalCost += cost;

  if (finish !== 'STOP') {
    logger.warn(`Gemini finishReason: ${finish}`, { chars: text.length, tokens: usage.candidatesTokenCount });
  }
  logger.info(`Gemini yanıt: ${text.length}ch ${finish}, $${cost.toFixed(5)}`);
  return { text, cost, finish };
}

// ── JSON parse — çok katmanlı fallback ──
function safeParseJSON(raw) {
  if (!raw || !raw.trim()) throw new Error('Boş yanıt');

  // Parsed sonucu normalize et: her zaman array dön
  function normalize(parsed) {
    if (Array.isArray(parsed)) return parsed;
    // {"lessons":[...]} veya {"data":[...]} gibi wrapper object
    if (parsed && typeof parsed === 'object') {
      // Tüm değerlere bak, ilk array'i al
      for (const val of Object.values(parsed)) {
        if (Array.isArray(val) && val.length > 0) return val;
      }
      // Hiç array yok — objeyi ders olarak sar
      return [parsed];
    }
    throw new Error('Beklenmeyen tip: ' + typeof parsed);
  }

  // 1. Direkt parse (responseMimeType=json ise bu çalışır)
  try { return normalize(JSON.parse(raw.trim())); } catch(e) {}

  // 2. ```json ... ``` bloğu
  const m1 = raw.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (m1) { try { return normalize(JSON.parse(m1[1].trim())); } catch(e) {} }

  // 3. İlk [ ... ] array'i bul
  const m2 = raw.match(/(\[[\s\S]*\])/);
  if (m2) { try { return normalize(JSON.parse(m2[1])); } catch(e) {} }

  // 4. İlk { ... } object'i bul
  const m3 = raw.match(/(\{[\s\S]*\})/);
  if (m3) { try { return normalize(JSON.parse(m3[1])); } catch(e) {} }

  throw new Error(`JSON parse başarısız. Ham: ${raw.substring(0, 200)}`);
}

// ── Progress yayını ──
function emit(event, data) {
  try { if (global.io) global.io.emit(event, data); } catch(e) {}
}

// ── Dersleri kaydet ──
async function saveBatch(lessons, phaseLabel) {
  let saved = 0;
  for (const l of lessons) {
    if (state.stopRequested || state.totalCost >= state.budget) break;
    try {
      await fenixBrain.recordLesson({
        category: l.category || phaseLabel,
        bug:      String(l.bug  || l.topic || '').substring(0, 200),
        cause:    String(l.cause || '').substring(0, 300),
        fix:      String(l.fix  || l.rule || '').substring(0, 400),
        actor:    'gemini-trainer',
      });
      state.totalLessons++;
      saved++;
    } catch(e) { /* kayıt hatası — devam */ }
  }
  return saved;
}

// ── Fenix Studio bağlamı — kategori bazlı ek bilgi ──
const FENIX_CONTEXT = {
  'fenix-studio-kategori': `Fenix Studio v34 AI editörü için kategori zekası.
Her kategori şu parametreleri bilmeli: LUT filtresi, arka plan tipi, müzik BPM, beat efekti, kancan metin tonu, ışık düzeltme.
Kategoriler: gida(golden-hour,ahşap,78bpm,slow-zoom), icecek(cinema,siyah,104bpm,flash),
kozmetik(none,beyaz,85bpm,soft-fade), parfum(cinema,siyah,85bpm,glitch-soft),
giyim(none,beyaz,104bpm,slide), ayakkabi(teal-orange,taş,128bpm,zoom-punch),
elektronik(cinema,siyah,120bpm,glitch), spor(teal-orange,doğa,128bpm,shake-zoom),
ev-yasam(golden-hour,ahşap,78bpm,slow-pan).`,

  'fenix-otonom-pipeline': `Fenix Otonom Mod — Tesla Autopilot gibi çalışır.
Kullanıcı medya yükler, hiçbir butona basmaz. 8 adım otomatik işler:
1.Ham medya al 2.İçerik analiz et 3.Kategori tespit et 4.Kancan metni yaz
5.LUT+arka uygula 6.Müzik eşleştir 7.Beat efektleri ekle 8.Hazır!
PNG katmanları: K0=ham medya, K1=LUT filtresi, K2=kancan metin, K3=marka overlay, K4=bitiş kartı.
Sonuç: ✅BEĞENDİM veya ❌YENİDEN YAP.`,
};

// ── Bir topic batch'i işle ──
async function processBatch(batch, round) {
  const cat = batch[0].cat;
  const topicList = batch.map(b => b.topic).join(', ');
  const extraContext = FENIX_CONTEXT[cat] ? `\nFenix Bağlamı: ${FENIX_CONTEXT[cat]}\n` : '';

  const prompt = `Sen Fenix Photo AI eğitim motorusun. AI reklam ajansı için aşağıdaki konularda her biri için ${PER_TOPIC} pratik ders üret.
${extraContext}
Konular: ${topicList}
Round: ${round} (daha önce bu konuları işlediysen farklı ve daha derin dersler üret)

Çıktı formatı — sadece JSON array:
[
  {
    "category": "konu-adı",
    "bug": "Öğrenilecek konu veya sık yapılan hata (50-100 karakter)",
    "cause": "Neden önemli veya hatanın sebebi (50-150 karakter)",
    "fix": "Pratik çözüm veya uygulama kuralı (100-300 karakter)"
  }
]

Sadece JSON array dön. Açıklama ekleme.`;

  const { text, cost } = await callGemini(prompt);
  let lessons = [];
  try { lessons = safeParseJSON(text); } catch(e) {
    logger.warn('JSON parse hatası', { error: e.message, snippet: text.substring(0, 300) });
    return 0;
  }
  if (!Array.isArray(lessons)) {
    logger.warn('Ders listesi array değil', { type: typeof lessons });
    return 0;
  }
  return await saveBatch(lessons, batch[0].cat);
}

// ── Ana eğitim döngüsü ──
async function runTraining(budget = 20, resume = false) {
  if (state.running) return { ok: false, error: 'Eğitim zaten çalışıyor' };
  if (!GEMINI_KEY) return { ok: false, error: 'GEMINI_API_KEY eksik' };

  // Checkpoint'ten devam et
  if (resume) {
    const cp = await loadCheckpoint();
    if (cp && cp.totalCost < budget) {
      state.totalCost    = cp.totalCost    || 0;
      state.totalLessons = cp.totalLessons || 0;
      state.round        = cp.round        || 1;
      state.topicIdx     = cp.topicIdx     || 0;
      state.phases       = cp.phases       || [];
      logger.info(`🔄 Checkpoint'ten devam — ${state.totalLessons} ders, $${state.totalCost.toFixed(3)}`);
    }
  } else {
    state.totalCost     = 0;
    state.totalLessons  = 0;
    state.round         = 1;
    state.topicIdx      = 0;
    state.phases        = [];
  }

  state.running       = true;
  state.stopRequested = false;
  state.budget        = budget;

  emit('fenix:train:start', { total: TOPICS.length * PER_TOPIC, budget,
    resumeFrom: state.totalLessons });
  logger.info(`🔥 Fenix eğitimi başladı — bütçe: $${budget}`);

  try {
    while (!state.stopRequested && state.totalCost < budget) {
      const topicList = state.round === 1
        ? TOPICS
        : [...TOPICS].sort(() => Math.random() - 0.5);

      let phaseStart = state.totalLessons;
      let phaseCost  = state.totalCost;
      let currentCat = null;
      const startIdx = state.round === 1 ? state.topicIdx : 0;

      for (let i = startIdx; i < topicList.length; i += BATCH) {
        if (state.stopRequested || state.totalCost >= budget) break;

        state.topicIdx = i;
        const batch = topicList.slice(i, i + BATCH);
        state.phase = `Round ${state.round} — ${batch[0].cat}`;

        if (currentCat && currentCat !== batch[0].cat) {
          state.phases.push({
            name:    `Round ${state.round}: ${currentCat}`,
            lessons: state.totalLessons - phaseStart,
            cost:    (state.totalCost - phaseCost).toFixed(4),
            ts:      new Date().toISOString(),
          });
          if (state.phases.length > 50) state.phases.shift();
          phaseStart = state.totalLessons;
          phaseCost  = state.totalCost;
          emit('fenix:train:phase', { phases: state.phases });
        }
        currentCat = batch[0].cat;

        // Batch'i işle — hata olsa bile devam et (retry ile)
        let retries = 0;
        while (retries < 3) {
          try {
            await processBatch(batch, state.round);
            break;
          } catch(e) {
            retries++;
            logger.warn(`Batch hatası (deneme ${retries}/3)`, { error: e.message });
            if (retries < 3) await new Promise(r => setTimeout(r, 3000 * retries));
          }
        }

        emit('fenix:train:progress', {
          done:   state.totalLessons,
          cost:   state.totalCost.toFixed(4),
          budget,
          pct:    Math.min(100, Math.round(state.totalCost / budget * 100)),
          phase:  state.phase,
          status: `${batch.map(b => b.topic).slice(0,2).join(', ')} işlendi`,
        });

        // Her CHECKPOINT_EVERY derste bir Firestore'a yaz
        if (state.totalLessons % CHECKPOINT_EVERY === 0 && state.totalLessons > 0) {
          await saveCheckpoint();
        }

        await new Promise(r => setTimeout(r, DELAY_MS));
      }

      // Round sonu
      state.phases.push({
        name:    `Round ${state.round} tamamlandı`,
        lessons: state.totalLessons - phaseStart,
        cost:    (state.totalCost - phaseCost).toFixed(4),
        ts:      new Date().toISOString(),
      });
      emit('fenix:train:phase', { phases: state.phases });
      await saveCheckpoint();

      logger.info(`✅ Round ${state.round} bitti — $${state.totalCost.toFixed(3)} / $${budget}`);
      state.round++;
      state.topicIdx = 0;
      if (state.round > 50) break;
    }
  } finally {
    state.running = false;
    emit('fenix:train:done', {
      total:  state.totalLessons,
      cost:   state.totalCost.toFixed(4),
      phases: state.phases,
    });
    await clearCheckpoint();
    logger.info(`🏁 Fenix eğitimi bitti — ${state.totalLessons} ders, $${state.totalCost.toFixed(4)}`);
  }

  return { ok: true, lessons: state.totalLessons, cost: state.totalCost };
}

function stop() { state.stopRequested = true; }
function getState() { return { ...state }; }

// ── Sunucu başlayınca checkpoint varsa otomatik devam ──
(async () => {
  try {
    const cp = await loadCheckpoint();
    if (cp && cp.running && cp.totalCost < (cp.budget || 20)) {
      const remaining = (cp.budget || 20) - cp.totalCost;
      logger.info(`🔄 Fenix Trainer: checkpoint bulundu, ${cp.totalLessons} ders sonrasından devam ediyor ($${remaining.toFixed(2)} kaldı)`);
      // 10sn gecikme — server tam başlasın
      setTimeout(() => {
        runTraining(cp.budget || 20, true).catch(e =>
          logger.error('Auto-resume hatası', { error: e.message })
        );
      }, 10000);
    }
  } catch(e) { /* sessiz */ }
})();

module.exports = { runTraining, stop, getState };
