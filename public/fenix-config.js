/* ============================================================
   FENIX CONFIG — AI Kolları Yapılandırması
   
   CLAUDE ve GEMINI bu dosyayı okuyarak API bilgilerini alır.
   Buraya kendi API anahtarlarını yaz, başka hiçbir dosyaya dokunma.
   ============================================================ */

const FENIX_CONFIG = {

  /* ── GENEL ── */
  app_name:    "Fenix",
  version:     "34.1",
  mode:        "production",   /* "development" | "production" */
  language:    "tr",

  /* ── CLAUDE API (Anthropic) ──
     Anahtar almak için: https://console.anthropic.com
     Buraya yapıştır: sk-ant-... */
  claude: {
    enabled:   true,
    api_key:   "BURAYA_CLAUDE_API_ANAHTARINI_YAZ",
    model:     "claude-sonnet-4-6",
    max_tokens: 1024,
    /* Fenix'e Claude'un rolünü tanımla */
    system_prompt: `Sen Fenix Studio'nun AI motorusun. 
Görevin: kullanıcının verdiği marka adı, platform ve müzik bilgisine göre
viral sosyal medya içeriği üretmek.
Türkçe yaz. Kısa ve güçlü ol. Hook ilk 3 saniyede dikkat çeksin.`
  },

  /* ── GEMINI API (Google) ──
     Anahtar almak için: https://aistudio.google.com
     Buraya yapıştır: AIza... */
  gemini: {
    enabled:   true,
    api_key:   "BURAYA_GEMINI_API_ANAHTARINI_YAZ",
    model:     "gemini-2.5-flash",
    /* Gemini görsel analiz için kullanılır */
    vision_enabled: true,
    system_prompt: `Sen Fenix Studio'nun görsel analiz motorusun.
Görevi: yüklenen fotoğraf veya videoyu analiz et, 
ne tür içerik olduğunu, hangi platformda viral olacağını ve
en uygun hook metnini Türkçe söyle.`
  },

  /* ── FENIX DAVRANIŞI ──
     Hangi işi hangi AI yapsın */
  routing: {
    text_generation:  "claude",   /* senaryo, hook, caption → Claude */
    image_analysis:   "gemini",   /* fotoğraf/video analiz → Gemini */
    hashtag_suggest:  "claude",   /* hashtag → Claude */
    platform_optim:   "gemini",   /* platform optimizasyon → Gemini */
    fallback:         "claude"    /* API hatasında → Claude */
  },

  /* ── EĞİTİM VERİSİ ── */
  training: {
    save_sessions:  true,         /* Her oturumu kaydet */
    log_path:       "./fenix-training-data.json",
    min_rating:     4             /* 4+ puanlı oturumları öğren */
  }

};

/* Dışa aktar — ai-bridge.js bu dosyayı okur */
if (typeof module !== 'undefined') module.exports = FENIX_CONFIG;
