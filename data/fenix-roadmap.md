# Fenix AI — Yapılacaklar Listesi & Yol Haritası
> Claude + Gemini çapraz analiz — 2026-03-25
> Vizyon metinlerinden çıkarılan tüm özellikler, öncelik sırasıyla

---

## FAZA 1: ÇEKIRDEK MOTOR (MVP — Hafta 1-2) [ÖNCELİK: 1]

### 1.1 Ürün Tarama ve Analiz Motoru [KRİTİK]
- [x] Ürün fotoğrafını al, ne olduğunu tanı (çanta, ayakkabı, saat, gözlük, altın, elmas, araba, motor, tekne, beyaz eşya vb.)
- [x] Ürün rengini analiz et (dominant renk, ton, parlaklık)
- [x] Ürün yapısını tara (sert/yumuşak — geçiş hızını belirler)
- [x] Ürün üzerindeki kusurları düzelt (kırışıklık, fazla ışık yansıması, parlama)
- [x] Ürünün sıra dışı özelliğini tespit et (ilk sahne için önce/sonra gösterimi)
- [x] Ürün standı varsa → standı tanı ve koru
- [x] İnsan model varsa → modeli tanı, kusurlarını düzelt
- **Zorluk: Zor** | **Bağımlılık: Yok**

### 1.2 Arka Plan Silme ve Ürün İzolasyonu [KRİTİK]
- [x] Arka planı sil, ürünü koru
- [x] Ürün standı varsa → standı koru, arkasını sil
- [x] İnsan model varsa → modeli koru, arkasını sil
- [x] İnsan figürü taşıyan ürünler → figürü temizle, profesyonel arka plan hazırla
- [x] Ürün üzerindeki kötü görüntüleri, sağındaki/arkasındaki dağınıklığı sil
- **Zorluk: Orta** | **Bağımlılık: 1.1**

### 1.3 Arka Plan Oluşturma (AI) [KRİTİK]
- [x] Ürün rengine göre uyumlu arka plan renk paleti oluştur
- [x] **Ofis teması:** Arkada hafif ofis görünümü (komple ofis belli olmasın, sadece hissedilsin)
- [x] **Vazo + çiçek:** Sağ tarafa zarif vazo, içinde çiçek (çiçek sapı %85 vazonun içinde)
- [x] **Ofis objeleri:** Kalemlik, isimlik (kullanıcıya özel panel — kendi ismini veya şirket ismini yazar)
- [x] **Alt kısım:** Granit, mermer veya doğal taş dokusu (AI ürün rengine göre seçer)
- [x] **Arka plan blur:** %20 bulanıklık
- [x] Ürün ön planda, arka plan destekleyici — yoğun olmasın, 1-2 obje yeterli
- [x] Tüm objeler zarif olsun
- [x] Model üzerindeyse → çekim stüdyosu havası kat
- [x] Stand üzerindeyse → stand rengine uyumlu arka plan
- [x] Bej renkler, minimalist dekorasyon
- **Zorluk: Zor** | **Bağımlılık: 1.1, 1.2**

### 1.4 Reels Video Oluşturma [KRİTİK]
- [x] 60 FPS öncelikli (alternatif 30 FPS)
- [x] Instagram Reels boyutu (9:16)
- [x] TikTok boyutu (9:16)
- [x] Instagram Post boyutu (1:1)
- [x] Ürüne yakınlaştır/uzaklaştır (AI ayarlar, varsayılan 2sn duraklama)
- [x] Ürün yapısına göre geçişler (sert ürün → keskin geçiş, yumuşak ürün → akıcı geçiş)
- [x] Bitiş kartı (Fenix AI branding)
- **Zorluk: Orta** | **Bağımlılık: 1.1, 1.2, 1.3**

---

## FAZA 2: GEÇİŞ, EFEKT ve MÜZİK (Hafta 2-3) [ÖNCELİK: 2]

### 2.1 Video Geçişleri
- [x] Zoom-In & Snap: Detaydan başla → zoom-out ile ürün "patlayarak" belirir
- [x] RGB/Glitch: Dijital bozulma → net ürün (teknoloji ürünleri için)
- [x] Before & After Perde: Orijinal → ışık çizgisi → profesyonel arka plan
- [x] Dynamic Pan: Yavaş kayma (yukarı-aşağı veya sol-sağ)
- [x] Flash & Scale: Beyaz flaş + ürün %10 büyür (beat'e senkron)
- [x] Fade/Dissolve: Yumuşak geçişler
- [x] Slide: Kaydırma geçişi
- [x] Spin: Dönerek geçiş
- [x] 360 Derece Dönüş: Ürün etrafında tam tur
- [x] Liquid Transition: Akışkan/sıvı geçiş (ASMR tarzı trendler için)
- **Zorluk: Orta** | **Bağımlılık: 1.4**

### 2.2 Video Efektleri
- [x] Ürüne özel efektler (AI seçer, kullanıcı istemezse efekt yok)
- [x] Sıcak içeceklerde buhar efekti
- [x] Flulaşan arka plan (zamanla)
- [x] Mikro-titreşim (dikkat çekme)
- [x] Parlama/glint (ürün yüzeyinde)
- [x] Ken Burns efekti (hafif hareket — donmuş resim hissi yok)
- [x] Hız kontrolü: Yavaş çekim / hızlandırma
- [x] Kullanıcı AI'ya bırakırsa → efekt ekleme, sade tut
- [x] Kullanıcı isterse → web'den çekilen efektler
- **Zorluk: Orta** | **Bağımlılık: 2.1**

### 2.3 Müzik Sistemi
- [x] Telif hakkı olmayan müzik kütüphanesi (Jamendo vb.)
- [x] Ürüne uygun müzik seçimi (AI)
- [x] Kullanıcı da müzik seçebilir
- [x] Beat senkronizasyonu (geçişler vuruşa denk)
- [x] Fade in/out
- **Zorluk: Orta** | **Bağımlılık: 1.4**

---

## FAZA 3: KULLANICI ERİŞİM ve ARAYÜZ (Hafta 3-4) [ÖNCELİK: 3]

### 3.0 Erişim Modeli [KRİTİK]
- [x] **Web uygulaması** — bilgisayar kullanıcıları için tam arayüz
- [x] **Mobil uyumlu arayüz** — telefon kullanıcıları için basit komut + fotoğraf yükleme
- [x] **API anahtarı sistemi** — her PC kullanıcısına özel anahtar verilir
- [x] Kullanıcı anahtarıyla web uygulamasına giriş yapar
- [x] **Cloud otonom çalışma** — kullanıcının bilgisayarı kapalı olsa bile Fenix bulutta çalışmaya devam eder
- [x] Fotoğraf/ürün yükle → Fenix otonom işler → sonuç hazır olunca bildirim gönder
- [x] Video, reels, fotoğraf düzenleme — hepsi bulutta, 7/24
- **Zorluk: Orta-Zor** | **Bağımlılık: 1.4**

### 3.1 Web Arayüzü (PC Kullanıcıları)
- [x] **"AI Yapsın" butonu** → sistem otomatik her şeyi yapar
- [x] **"Ben Yapayım" butonu** → editör açılır, kullanıcı müdahale eder
- [x] İki mod birbirini bloklamaz: AI yaptı → beğenmedi → düzenle → onayla
- [x] Başlat butonu
- [x] İndirme butonu
- [x] İlerleme çubuğu
- [x] Ufak önizleme penceresi (düzenleme sırasında video gösterimi)
- [x] Durdurma/müdahale butonu (kullanıcı belirli durumlarda durdurabilir)
- **Zorluk: Orta** | **Bağımlılık: 3.0**

### 3.2 Mobil Arayüz (Telefon Kullanıcıları)
- [x] Basit, sade arayüz — sadece komut ve fotoğraf yükleme
- [x] Fotoğraf at + komut gir ("Instagram reels yap" / "TikTok reels yap")
- [x] Fenix otonom çalışır → sonuç hazır olunca bildirim
- [x] İndirme butonu
- [x] İsteğe bağlı müdahale (basit düzenleme)
- **Zorluk: Orta** | **Bağımlılık: 3.0**

### 3.3 Kullanıcı Kontrolleri
- [x] Duraklama süre butonları: 1sn, 2sn, 3sn, 4sn, 5sn (kullanıcı seçer)
- [x] AI yaparsa varsayılan 2sn duraklama
- [x] Marka ismi sabitleme: Sol alt veya sağ alt köşe (kullanıcı seçer, ürünü kapatmayacak şekilde)
- [x] İsimlik/şirket ismi paneli (kullanıcıya özel, isteğe bağlı)
- [x] Efekt açma/kapama (kullanıcıya bırak)
- [x] Metin kancası kutucuğu: Kullanıcı merak uyandırıcı yazı girer
  - Örnek: "Bunu bilmeden [kategori] almayın"
  - Örnek: "Hayatınızı kolaylaştıracak o ürün"
  - Sol alt veya sağ alt köşede, ürünün üzerinde değil
  - Kullanıcı istemezse AI de eklemez
- **Zorluk: Kolay-Orta** | **Bağımlılık: 3.1**

### 3.4 Kullanıcı Takip Sistemi
- [x] Kullanıcının en çok kullandığı özellikleri takip et
- [x] Ona o konuda yardımcı ol (öneri, kısayol)
- [x] Neyi çok kullanıyorsa o özelliği öne çıkar
- **Zorluk: Orta** | **Bağımlılık: 3.1**

---

## FAZA 4: AKILLI ARKA PLAN ve IŞIK (Ay 1-2) [ÖNCELİK: 4]

### 4.1 Shadow-Match (Gerçekçi Gölge)
- [x] Işığın geliş açısını analiz et, ürüne gerçekçi gölge ekle
- [x] Parlak ürünlerde (saat, cam şişe) zemine yansıma (reflection) ekle
- [x] Ürün havada asılı kalmış gibi görünmesin
- **Zorluk: Zor** | **Bağımlılık: 1.3**

### 4.2 Bağlamsal Çevre Projeksiyonu
- [x] Ürünün hikayesini tamamlayan çevre (sadece arka plan değil, ışık ve yansıma da uyumlu)
- [x] HDRi Mapping: Çevrenin rengini ürün yüzeyine yansıt
- [x] Ürün orada gerçekten varmış gibi, "yapıştırma" gibi değil
- **Zorluk: Çok Zor** | **Bağımlılık: 4.1**

### 4.3 Hedef Kitleye Göre Arka Plan (Auto-Persona)
- [x] Spor ayakkabı → genç kitle: neon basketbol sahası / doğa: orman patikası
- [x] AI ürünü tanır, kitleye göre atmosfer üretir
- [x] Kullanıcı seçmezse AI karar verir
- **Zorluk: Zor** | **Bağımlılık: 1.1, 1.3**

### 4.4 Psikolojik Renk Grading
- [x] İndirim ürünü → agresif kırmızı/sarı tonlar
- [x] Lüks ürün → pastel, sinematik renk paleti
- [x] Haftalık trend analizine göre renk modu seç
- **Zorluk: Orta** | **Bağımlılık: 1.1**

---

## FAZA 5: TREND ÖĞRENME ve İÇERİK ÜRETİMİ (Ay 2-3) [ÖNCELİK: 5]

### 5.1 Trend Öğrenme Motoru
- [x] İnternetten trend videoları bul ve analiz et
- [x] TikTok/Instagram'daki popüler geçişleri öğren
- [x] Kendini açık dünyada eğit
- [x] Haftalık trend raporu oluştur
- [x] Hızlı/agresif trendse → videoyu hızlandır, vuruşlu geçişler
- [x] Rahatlatıcı/minimalist trendse → soft renkler, akışkan geçişler
- **Zorluk: Zor** | **Bağımlılık: 1.4**

### 5.2 Akıllı Açıklama (Caption) Üretici
- [x] Instagram: Estetik açıklama + 10 popüler hashtag
- [x] TikTok: Merak uyandıran kısa metin + CTA (harekete geçirici mesaj)
- [x] Ürünü analiz edip otomatik açıklama üret
- **Zorluk: Kolay** | **Bağımlılık: 1.1**

### 5.3 Göz Takip Simülasyonu (Neuro-Focus)
- [x] Video render öncesi dikkat analizi yap
- [x] Dikkat dağılıyorsa → o saniyede ürüne parlama/titreşim ekle
- [x] İzlenme süresini (retention rate) optimize et
- **Zorluk: Çok Zor** | **Bağımlılık: 1.4, 2.1**

### 5.4 A/B Test Simülatörü
- [x] Aynı üründen farklı versiyonlar türet
- [x] İç simülasyonda yarıştır (hangisi daha etkili?)
- [x] Sadece en iyi olanı kullanıcıya sun
- **Zorluk: Çok Zor** | **Bağımlılık: 5.1**

---

## FAZA 6: KATEGORİ-ÖZEL MODÜLLER (Ay 3+) [ÖNCELİK: 6]

### 6.1 Araç Modülü
- [x] Garaj içinde dönen platform üzerinde 360° dönüş reels
- [x] Plaka otomatik bulanıklaştırma
- [x] Galeri/stüdyo arka planı ekleme
- [x] Logo/filigran ekleme
- **Zorluk: Zor** | **Bağımlılık: 1.1, 2.1**

### 6.2 Emlak Modülü
- [x] Dağınık ev fotoğrafı → profesyonel arka plan
- [x] Otomatik watermark
- [x] Oda düzenleme önerileri
- **Zorluk: Zor** | **Bağımlılık: 1.1**

### 6.3 Yemek Modülü
- [x] Hareketli eller, nesne sabitliği
- [x] Buhar efekti, sıcaklık hissi
- **Zorluk: Zor** | **Bağımlılık: 1.1**

### 6.4 Mini Katalog Üretici
- [x] Tek fotoğraftan 4 sayfalık PDF/görsel dizi:
  - Sayfa 1: Profesyonel ana görsel
  - Sayfa 2: Teknik özellikler
  - Sayfa 3: AI üretilmiş kullanım sahneleri
  - Sayfa 4: QR kodlu "Hemen Satın Al"
- **Zorluk: Orta** | **Bağımlılık: 1.1, 1.3**

---

## FAZA 7: FENİX ÖĞRENME SİSTEMİ (Paralel) [ÖNCELİK: 4]

### 7.1 FenixDataLoggerService (Fenix'in Gözleri)
- [x] Tüm AI işlemlerini yapılandırılmış JSON formatında logla
- [x] eventType, actor, context, payload, outcome kaydı
- [x] Her AI çağrısı, her düzenleme adımı, her karar kaydedilir
- **Zorluk: Orta** | **Bağımlılık: Yok**

### 7.2 VectorEmbeddingService (Fenix'in Belleği)
- [x] Konuşmaları/kararları vektöre çevir
- [x] Semantik arama (benzer durumları hatırla)
- [x] Google Embedding API + lokal vektör DB (ChromaDB/pgvector)
- **Zorluk: Orta-Zor** | **Bağımlılık: 7.1**

### 7.3 FeedbackService (Fenix'in Mentoru)
- [x] Kullanıcı "gereksiz/iyi/kötü" dediğinde kaydet
- [x] Veriyi etiketle (öğrenilecek / atlanacak)
- [x] Otomatik filtre: teknik konuşma → öğren, havadan sudan → atla
- **Zorluk: Kolay-Orta** | **Bağımlılık: 7.1**

### 7.4 Shadow Learning (Fenix'in Ustaları İzlemesi)
- [x] Claude + Gemini bir iş yaparken → her adım loglanır
- [x] Fenix o adımları kopyalar ve dener
- [x] Kullanıcı (Mimar) onaylarsa → Fenix o görevi devralır
- [x] Ustalar bir sonraki zor aşamaya geçer
- **Zorluk: Zor** | **Bağımlılık: 7.1, 7.2, 7.3**

### 7.5 FenixDecisionEngine (Fenix'in Beyni)
- [x] Toplanan veriden öğren, öneri yap
- [x] Başlangıçta simülasyon modunda (gerçek işe müdahale etmez)
- [x] Yeterince öğrenince → otonom mod
- **Zorluk: Çok Zor** | **Bağımlılık: 7.1, 7.2, 7.3, 7.4**

---

## FAZA 8: İLERİ SEVİYE (Ay 6+) [ÖNCELİK: 8]

### 8.1 Ses Klonlama & Dublaj
- [x] Kullanıcı ses profili oluşturma
- [x] Çok dilli dublaj (dudak senkronlu)
- [x] AI Voice-Over: Ürün tanıtım sesi üretme
- **Zorluk: Çok Zor**

### 8.2 3D Ürün Rekonstrüksiyonu
- [x] Tek fotoğraftan 3D mesh
- [x] 360° sinematik kamera dönüşü
- **Zorluk: Çok Zor**

### 8.3 Nöral Satış Etiketleri
- [x] Video oynarken ürün noktalarında interaktif baloncuklar
- [x] AI üretilmiş ikna argümanları
- [x] Point tracking ile 3D hareket
- **Zorluk: Çok Zor**

---

## ALTYAPI GEREKSİNİMLERİ (Paralel — Her Fazada)

### Erişim ve Otonom Çalışma
- [x] API anahtar sistemi (her kullanıcıya özel key)
- [x] Cloud Run üzerinde 7/24 otonom çalışma (kullanıcı PC'si kapalıyken bile)
- [x] Görev kuyruğu — kullanıcı fotoğraf yükler, Fenix arka planda işler
- [x] İşlem bitince bildirim (e-posta veya push notification)
- [x] Web arayüzü (PC) + mobil uyumlu arayüz (telefon)

### Güvenlik
- [x] Kullanıcı verileri koruması (gizlilik — çok sıkı)
- [x] API rate limiting
- [x] Input validasyonu (Joi/Yup)
- [x] HTTP güvenlik başlıkları (Helmet)
- [x] JWT kimlik doğrulama
- [x] API anahtarı doğrulama

### Performans
- [x] 60 FPS render optimizasyonu
- [x] Düşük çözünürlük fotoğraf → AI upscale
- [x] GPU hızlandırma (Cloud GPU)
- [x] Redis cache

### Kod Kalitesi
- [x] Global error handler
- [x] Winston loglama
- [x] Test altyapısı (Jest)
- [x] CI/CD pipeline
- [x] API dokümantasyonu (OpenAPI)

---

## ÖNCELİK ÖZETİ

| Öncelik | Faza | Süre | Ne Yapılacak |
|---------|------|------|--------------|
| **1** | Çekirdek Motor | Hafta 1-2 | Ürün analiz + arka plan sil/oluştur + video üret |
| **2** | Geçiş/Efekt/Müzik | Hafta 2-3 | 10+ geçiş, efektler, beat-sync müzik |
| **3** | Erişim + Arayüz | Hafta 3-4 | API key sistemi, web+mobil arayüz, cloud otonom çalışma |
| **4** | Akıllı Arka Plan + Fenix Öğrenme | Ay 1-2 | Gölge, ışık, persona + loglama altyapısı |
| **5** | Trend Öğrenme + İçerik | Ay 2-3 | Trend analiz, caption, göz takip |
| **6** | Kategori Modülleri | Ay 3+ | Araç, emlak, yemek, katalog |
| **7** | Fenix Beyni | Ay 3+ | Decision engine, otonom mod |
| **8** | İleri Seviye | Ay 6+ | Ses, 3D, nöral etiketler |

## ERİŞİM MODELİ

```
┌─────────────────────────────────────────────────┐
│              FENIX AI (Cloud — 7/24)            │
│         Bilgisayar kapalıyken bile çalışır       │
├─────────────────────────────────────────────────┤
│                                                 │
│  ┌──────────────┐     ┌──────────────────┐      │
│  │ Web Arayüzü  │     │ Mobil Arayüz     │      │
│  │ (PC — Tam)   │     │ (Telefon — Basit)│      │
│  │ Düzenle/İzle │     │ Komut + Fotoğraf │      │
│  └──────┬───────┘     └────────┬─────────┘      │
│         │                      │                │
│         └──────────┬───────────┘                │
│                    │                            │
│           ┌────────▼────────┐                   │
│           │  API Anahtarı   │                   │
│           │ (Kullanıcıya    │                   │
│           │  özel key)      │                   │
│           └────────┬────────┘                   │
│                    │                            │
│           ┌────────▼────────┐                   │
│           │  Fenix Motor    │                   │
│           │  Otonom İşlem   │                   │
│           │  Bildirim Gönder│                   │
│           └─────────────────┘                   │
└─────────────────────────────────────────────────┘
```
