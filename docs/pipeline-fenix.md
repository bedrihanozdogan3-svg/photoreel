# FENIX — KALICI ÜRETİM PIPELINE KURALLARI
# Tüm gelecek API'lere ve video/reels üretimlerine uygulanır.
# Son güncelleme: 2026-03-28

---

## 1. OTONOM MOD — TAM AKIŞ

```
KULLANICI                        FENİX
────────────────────────────────────────────────────────
Ürün yükle (foto veya kısa video)
                             → Kategori OTOMATİK tara (görselden)
                             → Sahne tipi seç: Sade veya Canlı
                             → Arka plan üret (kategoriye göre)
                             → BPM'e göre müzik seç
                             → Efekt seç (öncekinden FARKLI)
                             → Video içi: ürün tespiti + zoom/blur/pan
                             → Geçişler: kategoriye göre sert/keskin
                             → Bitiş kartı: şirket ismi + logo (varsa)
                             → Reels çıkar (9:16, MP4)
Videoyu izle / Onayla        ←
```

### Kullanıcı Talimat Vermezse:
- Şirket ismi daha önce kaydedildiyse → otomatik kullan
- Şirket ismi yoksa → branding ekleme (boş bırak)
- Kategori otomatik tespit edilir — kullanıcı yazmaz

---

## 2. KATEGORİ BAZLI KURALLAR

| Kategori    | LUT           | Arka Plan | BPM | Efekt        | Ton      |
|-------------|---------------|-----------|-----|--------------|----------|
| gida        | golden-hour   | ahsap     | 78  | slow-zoom    | sicak    |
| icecek      | cinema        | siyah     | 104 | flash        | dinamik  |
| kozmetik    | none          | beyaz     | 85  | soft-fade    | luks     |
| parfum      | cinema        | siyah     | 85  | glitch-soft  | gizem    |
| giyim       | none          | beyaz     | 104 | slide        | trend    |
| ayakkabi    | teal-orange   | tas       | 128 | zoom-punch   | guc      |
| elektronik  | cinema        | siyah     | 120 | glitch       | teknik   |
| spor        | teal-orange   | doga      | 128 | shake-zoom   | enerji   |
| taki        | cinema        | siyah     | 90  | slow-zoom    | luks     |
| ev-yasam    | golden-hour   | ahsap     | 78  | slow-pan     | huzur    |

### AKSİYON / EKSTREM SPOR KATEGORİLERİ:

| Kategori   | LUT            | Arka Plan | BPM | Efekt       | Ton       | 360° Orbit    | Rüzgar |
|------------|----------------|-----------|-----|-------------|-----------|---------------|--------|
| motor      | teal-orange    | asfalt    | 135 | speed-ramp  | guc       | low-angle     | filtre |
| suAlti     | deep-blue      | su        | 95  | slow-zoom   | gizem     | surround      | yok    |
| parasut    | high-contrast  | gokyuzu   | 128 | smash-cut   | ozgurluk  | free-fall     | filtre |
| snowboard  | cold-blue      | kar       | 128 | shake-zoom  | enerji    | follow-cam    | filtre |
| tekne      | teal-cyan      | deniz     | 115 | zoom-punch  | dinamik   | horizon       | filtre |
| pist       | teal-orange    | pist      | 140 | speed-ramp  | guc       | cockpit       | filtre |

#### Aksiyon Kategorisi Pipeline Kuralları:
1. Video geldi → kategori tara (motor/sualtı/paraşüt/snowboard/tekne/pist)
2. **Rüzgar sesi** → FFmpeg ile filtrele ve bastır (sualtı hariç)
3. **Odak noktası** → sporcu/araç/tekne kilitlen, kaybetme
4. **BPM yüksek** → geçişler milimetrik ve frame-perfect
5. **Hız rampalama** (speed-ramp) → en hızlı anı daha hızlı, duraklamayı daha yavaş göster
6. **360° orbit tipi** kategoriye göre: low-angle (motor), surround (sualtı), free-fall (paraşüt), follow-cam (snowboard), horizon (tekne), cockpit (pist)
7. **Plaka bulanıklaştır** (motor/pist için otomatik)
8. **Reels çıkarken** 9:16, yüksek enerjili kanca metin ekle (ilk 3sn)

### Sahne Tipleri:
- **Sade**: Ürün + temiz arka plan (white/black/ahsap — kategoriye göre)
- **Canlı**: Ürün lifestyle bağlamında (cadde, doğa, iç mekan)

---

## 3. RİTİM ZEKASI KURALLARI

### Efekt Tekrar Önleme:
```
Aynı ürün → aynı efekt ÜST ÜSTE KULLANILMAZ
Her üretimde efekt havuzundan FARKLI seçilir
Son kullanılan efekt Firestore'da saklanır: {productHash: lastEffect}
```

### 5 Video Ritim Kuralı:
```
Kullanıcı aynı kategoride 5 video ürettiyse
+ Hepsi sakin/yumuşak çıktıysa
→ Fenix zorla SERT/KESKİN moda geçer
→ Geçişler milimetrik (kare hassasiyetinde)
→ Sonra tekrar sakinleşebilir — kalıba takılmaz
```

### Milimetrik Birleştirme:
- Geçişler frame-perfect yapılır (±1 kare tolerans)
- BPM senkronizasyonu: her beat'te sahne değişimi

---

## 4. KISA VİDEO YÜKLENINCE (Reels için video tarama)

```
Kullanıcı kısa video yüklerse:
→ Video içindeki ürün anları tespit edilir
→ Ürünün göründüğü anlara: zoom / blur / pan / yakınlaştırma eklenir
→ Geçişler ürün kategorisine göre sert veya yumuşak yapılır
→ Müzik BPM'e göre eşlenir
→ Reels formatında (9:16) çıkarılır
```

---

## 5. MARKALAŞMA KURALLARI

### Şirket İsmi:
```
Varsa:
  → Fotoğraflarda: SOL ALT köşe watermark
  → Videolarda: SON KARE bitiş kartı (şirket ismi + logo + CTA)
  → Renk: kategoriye uygun

Yoksa:
  → HİÇBİR ŞEY gösterilmez — boş placeholder YASAK
```

### Logo Sistemi:
```
İlk logo → ÜCRETSİZ (Flux ile otomatik üretilir)
2. logo ve sonrası → KREDİ SİSTEMİ (ücretli)
Yeni kullanıcıya: 1 logo kredisi hediye
```

---

## 6. E-TİCARET FOTOĞRAF KURALLARI

### Manken + Ürün:
```
Fotoğrafta manken tespit edilirse:
→ Manken KORUNUR (silinmez, kırpılmaz)
→ Ürün KORUNUR
→ Ürün üzerindeki PARLAKLIK → normalize et (highlight düzelt)
→ Ürün üzerindeki KIRIŞIKLIK → AI ile düzelt
→ Kumaş dokusu korunsun — sadece bozukluklar düzelsin
```

### Geçerli Kategoriler: giyim, ayakkabi, aksesuar, kozmetik (model varsa)

---

## 7. 360° MOD KURALLARI

### Genel:
- Three.js equirectangular görüntüleyici
- Gyroscope desteği (telefon hareketi)
- Pinch zoom + mouse wheel zoom
- Export: MP4 / YT360 / VR / Tiny Planet

### Kategoriye Özel 360°:
| Kategori    | 360° Yaklaşım                            |
|-------------|------------------------------------------|
| gida        | Yavaş orbit, sıcak ışık, yüzey detayı   |
| spor        | Aksiyon takibi, dinamik hareket, rüzgar sesi engelle |
| elektronik  | 360° ekran showcase, detay zoom          |
| ev-yasam    | Geniş mekan turu, ortam hissi            |
| kozmetik    | Yakın çekim texture turu                 |
| giyim       | Manken etrafında orbit                   |

### 360° Özel Kurallar:
```
- Rüzgar sesi → filtrele ve engelle
- Odak noktası → aksiyon/ürün neredeyse oraya kilitlen
- Hareket takibi → ürün kaçmasın, izleyen kaybetmesin
- Sahneler arası 360° geçiş → kategoriye göre sert/yumuşak
```

---

## 8. BİTİŞ KARTI YAPISI

```
┌─────────────────────────────┐
│                             │
│   [ŞİRKET LOGOSU]           │
│   Şirket Adı                │
│   ─────────────────         │
│   [ÜRÜN ADI / SLOGAN]       │
│                             │
│   [ CTA BUTONU ]            │
│                             │
└─────────────────────────────┘
Renk: Kategoriye göre (golden/cinema/teal-orange)
Süre: Son 2-3 saniye
Koşul: Şirket ismi KAYITLIYSA göster — yoksa GÖSTERME
```

---

## 9. KATEGORİ KANCA METİNLERİ (Hook)

| Kategori   | Kancalar |
|------------|----------|
| gida       | "Bu lezzeti denediniz mi?" / "Bugün masanıza geliyor" / "Taze. Doğal. Lezzetli." |
| icecek     | "Serinlemenin tam zamanı" / "Bu yaz favorin" / "Bir yudumda fark et" |
| kozmetik   | "Cildini seviyor" / "Profesyonel sonuç" / "Her gün bakım rutinin" |
| parfum     | "Bir damla yeter" / "Unutulmaz iz bırak" / "Senin imzan" |
| giyim      | "Bu sezonun trendi" / "Stilini tamamla" / "Şimdi giy, şimdi hisset" |
| ayakkabi   | "Her adımda fark yarat" / "Konfor + stil" / "Bugün sen öndesin" |
| elektronik | "Teknolojiyi hisset" / "Bir sonraki seviye" / "Geleceğin şimdisi" |
| spor       | "Limitlerini zorla" / "Her antrenman bir adım" / "Sen kazanmak için varsın" |
| taki       | "Işıltını taşı" / "Her anı değerli kıl" / "Senin tarzın, senin mücevherin" |
| ev-yasam   | "Evinize değer katın" / "Konfor her köşede" / "Yaşam kalitesi bir seçim" |

---

## 10. GELECEK API'LERE UYGULAMA KURALI

```
Hangi API gelirse gelsin (Kling, Runway, Pika, Sora, vb.):
→ Bu pipeline kuralları değişmeden uygulanır
→ Sadece API endpoint'i değişir
→ Kategori kararları, efektler, branding → HEP AYNI
→ Yeni API geldiğinde fenix-director.js'de sadece API çağrısı güncellenir
```

---

## 11. FENIX ÖĞRENME DÖNGÜSÜ

```
Üretim yapıldı
    ↓
Kullanıcı → ✅ BEĞENDİM veya ❌ YENİDEN YAP
    ↓
Fenix brain'e kaydet: {kategori, efekt, lut, skor, geri_bildirim}
    ↓
100 geri bildirim sonrası → ağırlıklar güncellenir
    ↓
Aynı kategoride → daha iyi tahmin
```
