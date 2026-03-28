/**
 * Fenix AI — Ses & Dublaj Modülü Talimatları
 * Rapor: fenix-dublaj-raporu.html (Mart 2026)
 *
 * Bu dosya Fenix'in ses/dublaj kararlarında kullanacağı
 * kurallar, API seçimleri ve öncelik sıralamasını içerir.
 */

// ── OTONOM KURALLAR (Fenix kendi başına yapar) ────────────────
const OTONOM_KURALLAR = [
  {
    id: 'speaker-detection',
    oncelik: 'KRİTİK',
    aciklama: 'Konuşmacı tespiti — erkek/kadın/çocuk sesi otomatik ayrılır',
    api: 'Deepgram Nova-3 diarization',
    fenix_komutu: 'Her konuşmacıya ayrı ses profili atanmalı. Cinsiyet yanlış atanırsa reddedilir.'
  },
  {
    id: 'lip-sync',
    oncelik: 'KRİTİK',
    aciklama: 'Dudak senkronizasyonu — ağız hareketleri yeni sesle eşleşmeli',
    api: 'Sync.so',
    fenix_komutu: 'Profil açılarında da senkron doğrulanmalı. Hata toleransı: 80ms altı.'
  },
  {
    id: 'emotion-match',
    oncelik: 'YÜKSEK',
    aciklama: 'Duygu tonu eşleştirme — orijinal duygu grafiği dublajda korunur',
    api: 'AssemblyAI duygu analizi + ElevenLabs emotion control',
    fenix_komutu: 'Orijinal sesten duygu çıkar (mutlu/üzgün/heyecanlı/nötr), TTS\'e parametre olarak ilet.'
  },
  {
    id: 'cultural-adapt',
    oncelik: 'YÜKSEK',
    aciklama: 'Kültürel uyarlama — kelimesi kelimesine çeviri değil, doğal konuşma',
    api: 'GPT-4o mini',
    fenix_komutu: 'Prompt: "Kültürel uyarlamayla çevir. Deyimleri hedef dile özgün ifadeyle ver. Marka adlarını değiştirme."'
  },
  {
    id: 'duration-sync',
    oncelik: 'YÜKSEK',
    aciklama: 'Süre uyumu — Almanca gibi uzun dillerde otomatik kısaltma',
    api: 'ElevenLabs speed parameter',
    fenix_komutu: 'Orijinal cümle süresi ± %15 aşılırsa: önce hız ayarla, sonra cümleyi kısalt.'
  },
  {
    id: 'noise-clean',
    oncelik: 'ORTA',
    aciklama: 'Gürültü temizleme — arka plan gürültüsü otomatik silinir',
    api: 'Deepgram noise suppression',
    fenix_komutu: 'Yüklenen ses dosyası %30\'dan fazla gürültü içeriyorsa önce temizle, sonra transkript al.'
  },
  {
    id: 'music-balance',
    oncelik: 'ORTA',
    aciklama: 'Ses/müzik dengesi otomatik optimize edilir',
    api: 'FFmpeg + öğrenilmiş kategori parametreleri',
    fenix_komutu: 'Konuşma varken müzik: -12dB. Konuşma yokken müzik: 0dB. Geçiş: 0.3s fade.'
  }
];

// ── API SEÇİM KURALLARI ───────────────────────────────────────
const API_SECIM = {
  stt: {
    birincil: 'deepgram-nova-3',
    yedek: 'openai-whisper',
    neden: 'Deepgram: 200ms, Türkçe dahil güvenilir, konuşmacı ayrımı mükemmel'
  },
  ceviri: {
    birincil: 'gemini-1.5-flash', // zaten mevcut
    yedek: 'gpt-4o-mini',
    neden: 'Kültürel nüanslar, deyimler, marka terimleri — kelimesi kelimesine değil'
  },
  tts: {
    baslangic: 'fish-audio',      // ElevenLabs\'dan %80 ucuz, benzer kalite
    premium: 'elevenlabs-v3',     // En doğal ses, duygu kontrolü, klonlama
    canli: 'cartesia-sonic-3',    // 40ms gecikme, gerçek zamanlı
    ucretsiz: 'qwen3-tts',        // Self-host, Apache 2.0
    neden: 'Başlangıçta Fish Audio, büyüyünce ElevenLabs v3\'e geç'
  },
  klonlama: {
    birincil: 'elevenlabs',       // 3dk örnekle, 32 dil
    cok_dil: 'rask-ai',           // 130+ dil, orijinal ses koruma
    hizli: 'inworld',             // 5-15 sn örnekle
    neden: 'Phoenix Voice ID: 30 sn örnekle klonlama hedefi'
  },
  lip_sync: {
    birincil: 'sync-so',          // Near-zero hata, profil açılarında çalışır
    alternatif: 'vozo-lipreal',   // Çoklu konuşmacı güçlü
    kurumsal: 'heygen',           // 500+ avatar, kurumsal
    neden: 'Sync.so: tek API çağrısında TTS + lip sync birleştiriyor'
  }
};

// ── PIPELINE AKIŞI ────────────────────────────────────────────
const PIPELINE = [
  { adim: 1, isim: 'Video Yükle',       api: null,              cikti: 'video_buffer'    },
  { adim: 2, isim: 'STT + Diarization', api: 'deepgram-nova-3', cikti: 'transcript_json' },
  { adim: 3, isim: 'Kültürel Çeviri',   api: 'gemini/gpt4o',   cikti: 'translated_text' },
  { adim: 4, isim: 'TTS + Klonlama',    api: 'elevenlabs-v3',   cikti: 'audio_file'     },
  { adim: 5, isim: 'Lip Sync',          api: 'sync-so',         cikti: 'synced_video'   },
  { adim: 6, isim: 'İnsan Onayı',       api: null,              cikti: 'approved_video'  },
  { adim: 7, isim: 'Dışa Aktar',        api: null,              cikti: 'final_export'   }
];

// ── FENİX FARK YARATAN ÖZELLİKLER ────────────────────────────
const FENIX_FARK = {
  phoenix_voice_id: {
    aciklama: '30 saniyeyle ses klonlama (rakipler 3+ dk istiyor)',
    api: 'inworld veya elevenlabs',
    durum: 'PLANLANMADI'
  },
  duygu_haritasi: {
    aciklama: 'Orijinal duygu grafiğini çıkar, dublajda aynen uygula',
    api: 'assemblyai + elevenlabs emotion',
    durum: 'PLANLANMADI'
  },
  beat_sync_dublaj: {
    aciklama: 'Dublaj cümleleri müzik beat\'lerine otomatik hizalanır',
    api: 'Fenix BPM analizi + ElevenLabs timing',
    durum: 'PLANLANMADI'
  },
  seffaflik_etiketi: {
    aciklama: '"AI dublajı içeriyor" otomatik etiketi — AB yasası uyumu',
    api: 'Fenix watermark sistemi',
    durum: 'PLANLANMADI'
  },
  veri_guvencesi: {
    aciklama: 'Ses eğitimde kullanılmaz garantisi',
    api: 'Politika + teknik önlem',
    durum: 'PLANLANMADI'
  }
};

// ── MALİYET PAKETLERİ ─────────────────────────────────────────
const MALIYET_PAKETLERI = {
  baslangic: {
    aylik: '$50-80',
    apiler: ['Fish Audio TTS', 'Deepgram Nova-3 STT', 'Sync.so Lip Sync', 'GPT-4o mini Çeviri'],
    kalite: '4/5 yıldız'
  },
  premium: {
    aylik: '$150-300',
    apiler: ['ElevenLabs v3 TTS', 'Deepgram Nova-3 STT', 'Sync.so Lip Sync', 'GPT-4o Çeviri', 'Rask AI Klonlama'],
    kalite: '5/5 yıldız'
  },
  ekonomik: {
    aylik: '$20-40',
    apiler: ['Inworld TTS', 'OpenAI Whisper STT', 'Sync.so Lip Sync'],
    kalite: '3/5 yıldız'
  },
  canli: {
    aylik: '$30-60',
    apiler: ['Cartesia Sonic-3 (40ms)', 'Deepgram Flux'],
    kalite: '4/5 yıldız'
  }
};

// ── FENIX SİSTEM PROMPT EKİ (ses kararları için) ──────────────
const FENIX_SES_SYSTEM_PROMPT = `
SES & DUBLAJ KARARLARIN:
- Konuşmacı sayısını otomatik tespit et, her birine ayrı ses profili ata
- Duygu analizi yap, TTS'e emotion parametresi olarak ilet
- Çeviride kültürel uyarlama yap, kelimesi kelimesine çevirme
- Marka adları ve özel isimleri çevirme, orijinal kalsın
- Ses/müzik dengesi: konuşma varken müzik -12dB
- Dudak senkronu hatası 80ms üzerindeyse yeniden üret
- Kullanıcının ses verisi eğitimde kullanılmaz — bunu her zaman garanti et
- AB Yapay Zeka Kanunu uyumu: "AI dublajı içeriyor" etiketini otomatik ekle
`;

module.exports = {
  OTONOM_KURALLAR,
  API_SECIM,
  PIPELINE,
  FENIX_FARK,
  MALIYET_PAKETLERI,
  FENIX_SES_SYSTEM_PROMPT
};
