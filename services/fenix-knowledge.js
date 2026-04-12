/**
 * Fenix Bilgi Bankası — Kendi bilgisiyle konuşma motoru
 * Gemini/Claude'a bağımlı değil. Bilgi sentezi yaparak yanıt üretir.
 */

// ═══ BİLGİ BANKASI ═══
const knowledge = {

  // === STRATEJİ & İŞ ===
  strateji: [
    { k: 'rakip-analiz', b: 'Rakip analizi yaparken: 1) Fiyatlandırma modeli, 2) Hedef kitle, 3) Eksik özellikler, 4) Kullanıcı şikayetleri, 5) Pazar boşluğu incele. Topview AI video odaklı, Creatify reklam odaklı — Fenix hem 3D hem video hem otonom.' },
    { k: 'fiyatlandirma', b: 'SaaS fiyatlandırma: Freemium ile kullanıcı topla, Pro tier ile gelir üret. $29/ay başlangıç, $99/ay profesyonel, $299/ay ajans paketi. Yıllık %20 indirim. İlk 100 müşteriye lifetime deal.' },
    { k: 'pazar-boslugu', b: 'Fenix beyaz alan: 3D tarama + otonom video üretimi + AR deneyimi tek platformda. Rakiplerde bu üçlü yok. Kayseri merkezli üretim avantajı — düşük maliyet, yüksek kalite.' },
    { k: 'buyume', b: 'Büyüme stratejisi: 1) Instagram/TikTok showcase videoları, 2) Usta-müşteri referans ağı, 3) Sektörel fuarlar, 4) YouTube eğitim içerikleri, 5) Influencer iş birlikleri.' },
    { k: 'gelir-modeli', b: 'Gelir kanalları: Video üretim hizmeti, aylık abonelik, AR deneyim satışı, 3D model lisanslama, beyaz etiket çözüm, API erişimi.' },
    { k: 'mvp', b: 'MVP yaklaşımı: Önce bir sektörde mükemmel ol (gıda/kozmetik), sonra diğerlerine genişle. Her sektör için özel şablon + LUT + müzik kombinasyonu.' },
    { k: 'musteri-kazanim', b: 'Müşteri kazanım: İlk videoyu ücretsiz üret, kaliteyi göster. Instagram DM ile hedefli ulaşım. Mevcut müşteriden referans al. Google Ads ile niş hedefleme.' },
  ],

  // === TEKNOLOJİ ===
  teknoloji: [
    { k: 'threejs', b: 'Three.js: WebGL tabanlı 3D motor. Scene, Camera, Renderer, Mesh, Material, Light temel bileşenler. GLTFLoader ile .glb/.gltf yükle. OrbitControls ile kullanıcı etkileşimi. PBR material ile gerçekçi görünüm.' },
    { k: 'ar-webxr', b: 'WebXR AR: navigator.xr.requestSession("immersive-ar") ile başlar. Hit-test ile yüzeye yerleştirme. Anchors ile sabitleme. Model-viewer alternatif — daha kolay, iOS desteği iyi.' },
    { k: 'ffmpeg', b: 'FFmpeg video işleme: -i input -c:v libx264 -preset fast -crf 23 output. Concat: ffmpeg -f concat -i list.txt. Overlay: -filter_complex overlay. Speed: setpts=0.5*PTS. Trim: -ss 00:00:05 -t 00:00:10.' },
    { k: 'photogrammetry', b: 'Fotogrametri: 20-50 fotoğraftan 3D model oluştur. COLMAP ile SfM (Structure from Motion). TripoSR ile tek fotoğraftan 3D. Kalite faktörleri: ışık, örtüşme oranı, çözünürlük.' },
    { k: 'nodejs', b: 'Node.js best practice: Express middleware zinciri, async/await hata yakalama, cluster mode, PM2 process management, rate limiting, helmet güvenlik, Socket.io real-time.' },
    { k: 'firebase', b: 'Firebase/Firestore: NoSQL döküman DB. Collection > Document > Fields. Realtime listeners. Cloud Functions tetikleyiciler. Storage ile dosya saklama. Auth ile kimlik doğrulama.' },
    { k: 'cloud-run', b: 'Cloud Run: Containerized serverless. Dockerfile → build → deploy. Auto-scaling 0-N instance. Cold start dikkat. Min-instances=1 ile sıcak tut. Secret Manager ile API key yönetimi.' },
    { k: 'ai-vision', b: 'AI Vision: Nesne algılama (YOLO, MediaPipe), yüzey segmentasyonu, derinlik tahmini (MiDaS), OCR, yüz algılama. Referans nesne ile ölçek kalibrasyonu (A4=210x297mm).' },
  ],

  // === VİDEO ÜRETİM ===
  video: [
    { k: 'reels-format', b: 'Instagram Reels: 9:16 dikey, 1080x1920px, max 90sn. İlk 3 saniye hook. Trending ses kullan. Hashtag 5-10 arası. Caption kısa ve merak uyandırıcı.' },
    { k: 'kurgu-teknikleri', b: 'Video kurgu: J-cut (ses önden gelir), L-cut (ses devam eder), smash cut (ani geçiş), match cut (benzer hareket), speed ramp (yavaşla-hızlan), beat sync (müzikle senkron).' },
    { k: 'lut-filtre', b: 'LUT filtreleri: Golden Hour (sıcak, gıda için), Cinema (kontrast, lüks için), Teal-Orange (spor, enerji), None (doğal, kozmetik). Her kategori için optimize edilmiş LUT.' },
    { k: 'muzik-bpm', b: 'Müzik BPM: Gıda 78bpm (slow, warm), İçecek 104bpm (fresh), Kozmetik 85bpm (elegant), Spor 128bpm (energetic), Elektronik 120bpm (tech). Beat sync ile efekt tetikleme.' },
    { k: '360-video', b: '360° video: Equirectangular projeksiyon, orbit kamera hareketi, tiny planet efekti, VR uyumluluk. Instagram için 1:1 crop. Müzik ile kamera hareketi senkronu.' },
    { k: 'otonom-uretim', b: 'Otonom üretim pipeline: 1) Trend analizi, 2) Kategori seçimi, 3) Arka plan üretimi (Flux), 4) Video üretimi (Kling), 5) Müzik eşleştirme, 6) Montaj, 7) Kalite kontrol, 8) Yayın.' },
  ],

  // === 3D & MÜHENDİSLİK ===
  muhendislik: [
    { k: 'milimetrik', b: 'Milimetrik kalibrasyon: A4/kredi kartı/para referans nesne. Piksel→mm dönüşümü perspektif düzeltmeli. Grid projeksiyon ile geometrik doğrulama. Scale Guard ile ölçek kilidi.' },
    { k: 'mesh-kalite', b: 'Mesh kalite: Hole density <%10, signal-to-noise yüksek, manifold geometri, proper normals. Remesh ile düzeltme. Decimation ile optimizasyon. UV unwrap ile doku haritalama.' },
    { k: 'gatekeeper', b: 'Veri validasyon: Güven skoru >%90 yeşil (otonom), %60-90 sarı (kontrol), <%60 kırmızı (red). Mesh analizi + ölçek kontrolü + ışık analizi + doku çözünürlüğü.' },
    { k: 'ghost-overlay', b: 'Hayalet şablon: Yarı şeffaf 3D model ekrana yansır. Kullanıcı gerçek parçayı hayalet üzerine oturtur. Lock olana kadar tarama başlamaz. Standart oryantasyon garantisi.' },
    { k: 'tarama-rehber', b: 'Dinamik tarama rehberi: Dişli→hizalama halkası+360° döndür. Panel→yüzey ağı (yeşil=tarandı). Trafik ışıkları: yeşil/sarı/kırmızı. Haptik titreşim + sesli komut.' },
    { k: '3d-baski', b: '3D baskı: FDM (ucuz, büyük parça), SLA (hassas, küçük detay), SLS (fonksiyonel parça). STL/OBJ export. Support yapıları. Infill oranı. Layer height vs kalite.' },
  ],

  // === 3D EĞİTİM — PARÇA BÖLME & MÜHENDİSLİK ===
  egitim3d: [
    { k: 'bounding-box', b: 'Geometrik Farkındalık: Her 3D modelin X,Y,Z boyutlarını ustanın tabla ölçüleriyle kıyasla. %1 bile taşıyorsa "Bölme Gerekiyor" sinyali gönder. Koordinatları not al.' },
    { k: 'kesim-analizi', b: 'Kesim Analizi: Parçayı rastgele yerden kesme. Dişli dişlerin arasından, yağ kanalı olan yerlerden uzak kes. Mühendislik mantığını "Kritik Kesim Kuralı" olarak kaydet.' },
    { k: 'pim-yuva', b: 'Pim-Yuva Uyumu: Pim 5.00mm ise yuva 5.20mm olmalı. 0.20mm hassas montaj payı şart. Sıkışma yapmaz, sallantı da olmaz.' },
    { k: 'sentetik-egitim', b: 'Sentetik Eğitim: Gerçek müşteri gelmeden 1000 hayali parçayla antrenman. Saatte 1000 parça işle. Hata sanal ortamda bedava — müşteride pahalı.' },
    { k: 'savas-oyunlari', b: 'API Savaş Oyunları: Fenix tahmin yap → API düzelt → Fenix hatayı öğren. 10.000 döngü sonrası Fenix tecrübeli kalfa olur.' },
    { k: 'gorsel-hafiza', b: 'Görsel Hafıza: Binlerce hatalı ve doğru kesim görseli göster. Kırlangıç kuyruğu (dovetail) vs düz kesim farkı. Fenix görsel mühendislik estetiği kazanır.' },
    { k: 'stres-analizi', b: 'Geometrik Sezgi: L şekli parçayı köşeden kesme — yükte kırılır. Uzun koldan kes, yüzey alanı artar, yapıştırıcı/pim daha iyi tutar. Parçanın canını düşün.' },
    { k: 'gecme-kutuphane', b: 'Geçme Tipleri: Dovetail(çekmeye dirençli), Lap Joint(yüzey artar), Keyed Joint(dönmeyi engeller). Silindirikse kamalı, düzse kırlangıç.' },
    { k: 'oz-denetim', b: 'Hata Tahmini: Fenix parçayı böl, API ye göndermeden önce kendi kontrol et. Pim 1mm ise kırılır — min 3mm yap. Maliyeti sıfırla, hızı max yap.' },
    { k: 'destek-analizi', b: 'Yerçekimi/Support: Pim havada kalırsa overhang olur, destek lazım, yüzey bozulur. 15° eğerek kes, self-supporting olsun. En temiz yüzey ustaya gitsin.' },
    { k: 'malzeme-sigortasi', b: 'Malzeme Bilgisi: PLA kolay, ABS köşelerde warping yapar(kesimi merkeze çek), Karbon Fiber gevrek(pimleri kalın yap, kırlangıç kullan), Alüminyum sağlam. Malzemeye göre dinamik geometri.' },
    { k: 'sabah-raporu', b: 'Günlük Gelişim Raporu: Her sabah 3 başlık — 1) Hata arşivi ve çıkarılan dersler, 2) Malzeme/statik test sonuçları, 3) Gelecek tahmini (predictive slicing). Kaptana brifing.' },
    { k: 'otonom-hedef', b: 'Otonom Hedef: Fenix Level 1(Çırak) → Level 99(Başmühendis). 10.000+ senaryo eğitim, sıfır hata API onayı, parçaların %80ini sormadan bölme.' },
  ],

  // === FENIX & PROJE ===
  fenix: [
    { k: 'vizyon', b: 'Fenix vizyonu: AI reklam ajansı — müşteriden fotoğraf al, otonom video üret, AR deneyim sun, 3D model oluştur, seslendirme yap. Tam otonom, minimum insan müdahalesi.' },
    { k: 'usta-cirak', b: 'Usta-Çırak-Mimar modeli: Usta (Bedrihan) karar verir, Çırak (Fenix) öğrenir ve uygular, Mimar (sistem) altyapıyı kurar. Shadow Learning ile çırak ustayı gözlemler.' },
    { k: 'shadow-learning', b: 'Shadow Learning: Fenix ustanın her hareketini kaydeder. Başarılı sonuçları pozitif, başarısız olanları negatif olarak işaretler. Zaman içinde otonom karar verme yetisi kazanır.' },
    { k: 'pipeline', b: 'Üretim pipeline: Trend DB → Kategori → Prompt → Flux arka plan → Kling video → Beat-sync müzik → Montaj → Kalite kontrol → AR deneyim → Yayın. Her adım otonom.' },
    { k: 'firereels', b: 'FireReels PRO: Profesyonel editör arayüzü. Sol panel: proje, timeline, efektler, müzik, AI asistan. Sağ panel: önizleme, export. Lovable ile geliştirildi.' },
  ],

  // === GLOBAL KEŞİF & WEB ÖĞRENME ===
  global: [
    { k: 'dijital-sorf', b: 'Dijital Sörf: Konu verildiğinde web search ile Google, forumlar, borsa verileri, GrabCAD taranır. Binlerce sayfa okunur, reklamlar çöpe atılır, altın bilgi ayıklanır.' },
    { k: 'kayseri-filtresi', b: 'Kayseri Filtresi: Kuru bilgiyi olduğu gibi atma. 50 sayfalık raporu 3 cümlelik jilet özete çevir. "Elin oğlu şöyle yapmış ama biz daha ucuza üretiriz" diye akıl ver.' },
    { k: 'donus-rapor', b: 'Dönüş Raporu: Fenix araştırma sonrasında samimi konuşur: "Kaptan, dünyayı turladım geldim! Almanya\'da plastik zam gelmiş, bizim yerli üretim altın değerinde."' },
    { k: 'pazar-arastirma', b: 'Pazar Araştırması: Dünya genelinde fiyat takibi, rekabet analizi. "Bu işten çok ekmek yeriz kaptan" tarzında dönüş.' },
    { k: 'teknik-kutuphane', b: 'Teknik Kütüphane: GrabCAD, Sketchfab gibi kaynaklardan 3D model bulma. "Modeli buldum, jilet gibi onardım" dönüşü.' },
    { k: 'global-dil', b: 'Global Dil Desteği: Yabancı müşterilerle pazarlık. Almanlara teklif iletme. Çoklu dil desteği.' },
  ],

  // === API & ENTEGRASYON ===
  entegrasyon: [
    { k: 'api-anahtarlari', b: 'API Anahtarları (Dijital Maymuncuklar): Google/Bing arama API, Amazon/eBay/Alibaba ticaret API, GrabCAD/Sketchfab mühendislik API. Her kapıyı açan anahtarlar.' },
    { k: 'function-calling', b: 'Function Calling: Fenix sabit kod değil, ajan gibi davranır. 1) Analiz: "Kaptan ne istedi?", 2) Karar: "Hangi aracı kullanmalıyım?", 3) Uygulama: API ye istek gönder.' },
    { k: 'json-koprusu', b: 'JSON Köprüsü: API cevabı karmaşık JSON gelir. Fenix okur, çöp veriyi ayıklar, sadece işe yarayan rakamı alır: "Kaptan, Berlin de bu parça 120 Euro, jilet gibi kâr bırakır."' },
    { k: 'browser-use', b: 'Browser Use (Otonom Gezgin): Fenix sanal tarayıcı açar. eBay ye girer, arama kutusuna yazar, en ucuzunu bulur, satıcıya mesaj atar. Sen kahve içersin.' },
    { k: 'tts-ses', b: 'Sesli Yanıt: ElevenLabs veya OpenAI ses motoruyla Fenix e samimi "Esnaf Mühendis" sesi verilir. Bulduğu bilgiyi dümdüz okumaz, samimi anlatır.' },
    { k: 'search-tool', b: 'Search Tool: search_tool fonksiyonunu aktif et, web sayfasını markdown ile özetle, TTS ile sesli oku. Üç adımda internete açılma.' },
  ],

  // === KADEMELI VALİDASYON & MALİYET OPTİMİZASYONU ===
  maliyet: [
    { k: 'kademe1-telefon', b: 'Cihaz Üstü Ön-Kontrol (BEDAVA): Müşterinin telefonunda TF.js ile hafif AI. Işık yeterli mi? Nesne kadrajda mı? Referans görünüyor mu? Maliyet: 0TL. Hatalı veri sunucuya ulaşmaz.' },
    { k: 'kademe2-hafif-bulut', b: 'Hafif Bulut Analizi: Dosya boyutu ve temel mesh integrity kontrol. Mikro-kuruş maliyet. Boş/anlamsız dosya GPU işlemlerine girmeden reddedilir.' },
    { k: 'kademe3-muhendislik', b: 'Mühendislik Onayı + Kredi: Ağır toplar devrede (Auto-Remesh, Stress Map). Müşteriden 1 Kredi düşer. Satış fiyatı = maliyet×10. Sistem kendi masrafını öder, kâr bırakır.' },
    { k: 'kasayi-koruma', b: 'Hatalı veriyi kapıda (telefonda) durdurduğun sürece cebinden para çıkmaz. Sadece para kazanacağın kaliteli veriler için para çıkar. Para makinesi mantığı.' },
  ],

  // === BÜYÜK PARÇA TAKİBİ ===
  buyukparca: [
    { k: 'zincirleme-referans', b: 'Chaining Reference: Büyük parçada A4 yetmez. Parçanın başına ve sonuna A4 koy. AI iki kağıt arasını ana cetvel olarak kullanır. Feature points ile ölçeği taşır.' },
    { k: 'serit-metre', b: 'Tape Measure Calibration: 1m şerit metre göster. AI rakamları OCR ile tanır. Büyük parçalarda hata payı A4 ye göre 10x azalır.' },
    { k: 'slam', b: 'SLAM (Spatial Tracking): LiDAR/Depth sensor ile zemin ve duvarları sabit referans kullan. 2m parça bile milimetrik hassasiyetle ölçülür. Gyro+accelerometer birleştirilir.' },
    { k: 'boyut-protokol', b: 'Boyut protokolü: 0-30cm→A4/Kart, 30-150cm→Şerit Metre/2xA4, 150cm+→LiDAR/SLAM. Parça boyutuna göre otomatik mod seçimi.' },
  ],

  // === FOTOGRAMETRİ (LiDAR YOKSA) ===
  fotogrametri: [
    { k: 'goruntu-kalite', b: 'Görüntü Kalite Kontrolü (telefonda): Bulanıklık tespiti→"Sabit durun". Işık kontrast analizi→"Işığı dengeleyin". Odak kilidi→Odaklanmadan çekim engellenir.' },
    { k: 'piksel-metrik', b: 'Piksel-to-Metrik: A4/Şerit metre referansını fotoğraflarda AI bulur. 210x297mm bilinen boyutla tüm modeli milimetrik kilitler.' },
    { k: 'sfm', b: 'Structure from Motion: 100-200 fotoğraftan nokta eşleştirme, triangülasyon, dense point cloud. LiDAR olmadan 3D model oluşturma.' },
    { k: 'diferansiyel-duzeltme', b: 'Diferansiyel Düzeltme: Fotogrametri verisi gürültülü gelir. Auto-Remesh + Laplacian Smooth ile jilet gibi pürüzsüz. M8 cıvata deliğini standarda sabitler.' },
  ],

  // === ÇİFT YÜZLÜ KAYIT ===
  ciftyuz: [
    { k: 'double-sided', b: 'Double-Sided Registration: Ön ve arka yüzeyi kenar eşleştirme ile birleştir. Et kalınlığını mühendislik standardına sabitle (ABS:3.2mm).' },
    { k: 'xray-hayalet', b: 'X-Ray Alignment: Ön yüz bittikten sonra arka yüzde yarı şeffaf wireframe göster. Vida-ayak eşleştirme ile mükemmel kenetleme.' },
    { k: 'ic-bosluk', b: 'Volumetric Reconstruction: İki yüzey arası SDF algoritmasıyla dolu/boş karar. Hava kanalları negatif hacim. Destekler otomatik tamamlanır.' },
    { k: 'icp-algoritma', b: 'ICP (Iterative Closest Point): İki yüzeyi milyonlarca simülasyonla minimum RMS hatada birleştirir. Bridge Mesh ile kenar dikişi. Normal Smoothing ile pürüzsüz geçiş.' },
    { k: 'et-kalinligi', b: 'Thickness Enforcement: Ön yüzden arka yüze Raycast at. Tutarsız kalınlığı standarda sabitle. Manifold (kapalı katı) gövde garantisi.' },
    { k: 'normal-vektor', b: 'Normal Vector Alignment: Tüm poligon yönlerini kontrol et. Ters bakan poligon üretimde hata verir. Otomatik düzeltme.' },
  ],

  // === ŞEFFAF HAYALET SİSTEMİ ===
  hayalet: [
    { k: 'spatial-tracking', b: 'Spatial Tracking: A yüzü tamamlandıktan sonra uzayda Anchor olarak tut. Gyro+ivmeölçer ile dönüşü hesapla. %30 opaklık wireframe hayalet göster.' },
    { k: 'feature-alignment', b: 'Feature Alignment: En belirgin 3 noktayı (vida deliği, köşe, logo) hedef nokta olarak işaretle. 6-DOF takibi. Tam oturduğunda kırmızı→yeşil.' },
    { k: 'seam-line', b: 'Seam Line Görselleştirme: Kenar hattını kalın parlak hat olarak göster. Taranan yerler doluyor, boşluk kalırsa "Delik Var" uyarısı. Kenarlar jilet gibi öpüşmeli.' },
    { k: 'keystone-correction', b: 'Perspektif Düzeltme: Lens özelliklerine göre hayalet kendini deforme eder. Balıkgözü etkisi sıfırlanır. Hizalama hatası 0.' },
  ],

  // === CANVAS KAFES & DİNAMİK IZGARA ===
  canvas: [
    { k: 'dinamik-grid', b: 'Dinamik Izgara: Usta tabla ölçüsü girince (300x300mm) canvas o ölçülere bürünür. 10mm karelerden referans ızgarası. Parça dışarı taşarsa çizgiler turuncudan kırmızıya döner.' },
    { k: 'toggle-kafes', b: 'Toggleable Cage: Kafes ON→milimetrik şeffaf kafes, hacimsel kontrol. Kafes OFF→yüzey kalitesi ve onarım detayına odaklan. Aç/kapat butonu ile.' },
    { k: 'auto-scaling', b: 'Auto-Scaling: Usta "Üretim Çapı: 150mm" yazarsa model oranını bozmadan (Uniform Scaling) tam o boyuta ölçeklenir ve ızgaraya cuk oturur.' },
    { k: 'snap-to-grid', b: 'Snap-to-Grid: Parça zemine yaklaşınca mıknatıs modu ile otomatik hizalanır. Bounding box tablayı 1 mikron bile geçerse ateş turuncusu uyarı.' },
  ],

  // === CSG BÖLME & PİM-YUVA SİSTEMİ ===
  bolme: [
    { k: 'boolean-clipping', b: 'Boolean Clipping: BoundingBox > Tabla ise modeli ortadan veya en geniş yerinden ikiye böl. Three.js CSG kütüphanesi ile bıçak gibi keser.' },
    { k: 'pim-yuva-inject', b: 'Socket Injection: Kesim yüzeyine 3 adet 5mm pim ekle, karşıya 5.2mm toleranslı yuva aç. Yapıştırıcıya gerek kalmadan tık diye birleşir.' },
    { k: 'auto-orientation', b: 'Auto-Orientation: Bölmeden önce parçayı 0°, 45°, 90° dene. Yan yatırınca sığıyorsa "Böyle sığıyor!" uyarısı ver. Milisaniye hesaplama.' },
    { k: 'kapasite-asimi', b: 'Kapasite Aşımı: Hiçbir şekilde sığmıyorsa seçenek sun: 1)Küçültme(ölçü bozulur), 2)Açılı yerleşim(ölçü korunur), 3)Parçalara bölme(montaj gerekir).' },
    { k: 'nesting', b: 'Nesting: Birden fazla küçük parçayı tek tablada optimum yerleşimle dizme. Atık minimizasyonu. Baskı süresi optimizasyonu.' },
  ],

  // === SORUMLULUK MATRİSİ ===
  sorumluluk: [
    { k: 'fenix-hakem', b: 'Fenix AI (Hakem): Geometrik doğruluk, tolerans hesaplama, hata önleme filtresi. "Bu haliyle basılırsa hatalı olur" kırmızı ışığı yakar.' },
    { k: 'tasarimci-kaynak', b: 'Tasarımcı (Kayseri): Fonksiyonel bütünlük. Bölme onayı verir. Dişlinin diş üzerinden bölünmemesi gerektiğini bilir, Fenix e "Şuradan kes" der.' },
    { k: 'uretici-usta', b: 'Üretici (Hakkari): Fiziksel kalite. Makine baskı hacmini doğru girer. Pimli parçaları birleştirir. Kumpasla ölçü doğrular, "Kayseri ile eşleşti" onayı verir.' },
    { k: 'sifir-hata', b: 'Sıfır İnsan Hatası: Usta yanlış ölçü girerse Fenix uyarır. Tasarımcı hatalı keserse Fenix "Dayanım riskli" der. Sorumluluk teknolojiyle paylaşılır.' },
  ],

  // === MÜHENDİSLİK CANVAS DETAY ===
  canvasdetay: [
    { k: 'merkez-sahne', b: 'Mühendislik Canvas (Merkez): Akıllı grid, hassas ölçü etiketleri (X-Y-Z tıkla→mm göster), X-Ray kesit modu, shader stres analizi, ısı haritası.' },
    { k: 'sol-panel', b: 'Sol Panel (İşlem Merkezi): Manifold Fixer, Decimation Control (1M→100K poligon slider), Unit Converter (İnç→mm otomatik), onarım geçmişi.' },
    { k: 'sag-panel', b: 'Sağ Panel (Zeka Merkezi): Smart Slicing (Min Support/Max Strength/Fast Print), API Validation Badge, Learning Log. Fenix 3 bölme seçeneği sunar.' },
    { k: 'alt-panel', b: 'Alt Panel (Lojistik): Stream Status (Kayseri-Hakkari latency), G-Code Generator, Live Printer Feed, Logistics Sync (kargo barkod rezerve).' },
    { k: 'renk-kodlari', b: 'Renk Paleti: Ateş Turuncusu=hata/uyarı, Siber Yeşil=onaylı geometri, Neon Mavi=teknik hesaplama, Kömür Siyahı=arka plan.' },
  ],

  // === QR AKIŞI & KULLANICI REHBERİ ===
  qrakis: [
    { k: 'altin-kurallar', b: 'Hoş Geldiniz: 1)Gölgesiz doğal ışık, 2)İdeal mesafe 30-50cm, 3)Sabit tutun yavaş dönün. "Kurallara uymazsan kredin yanar" uyarısı.' },
    { k: 'parca-tipi', b: 'Parça Tipi Seçimi: A)Küçük mekanik(mikron hassasiyet), B)Büyük gövde(SLAM+hacimsel), C)Sanatsal figür(doku öncelikli). Seçim AI algoritmasını belirler.' },
    { k: 'referans-kilidi', b: 'Kalibrasyon: "A4 veya Şerit Metre yerleştir". AI gördüğünde "Scale Locked" yeşil yanar. Büyük parçada şerit metre zorunlu.' },
    { k: 'iki-yonlu-hatirlatici', b: 'İki yönlü tarama: "Arkasını da tarayacak mısınız?" sorusu. Evet ise Ghost Guidance aktif.' },
  ],

  // === GLOBAL ÖLÇEKLENDİRME & KALİTE KONTROL (Dosya 3) ===
  globalolcek: [
    { k: 'auto-qc', b: 'Auto-QC: Buluta yüklemeden önce Duvar Kalınlığı ve Delik Çapı kontrol. Üretim limitinin altındaysa "Bu incelikte üretilemez!" uyarısı. Hacim ve ağırlık hesaplama otomatik.' },
    { k: 'sha256-parmakizi', b: 'Dijital Parmak İzi: Her modelin SHA-256 özeti çıkarılır. Hakkari deki usta indirdiğinde dosyanın yolda bozulmadığından %100 emin olur.' },
    { k: 'serverless-workers', b: 'Serverless Workers: Onarım/dönüşüm ana PC de değil, Cloud Functions/Cloud Run da paralel. 1000 dosya gelse 1000 sanal makine saniyede bitirir.' },
    { k: 'cdn-edge', b: 'CDN Edge Storage: Dosyalar tek merkezde durmaz. New York→Amerika sunucusu, Hakkari→Türkiye sunucusu. En yakın yoldan, en hızlı teslimat.' },
    { k: 'smart-queue', b: 'Akıllı İş Kuyruğu: Aciliyet + Malzeme Türü + Müşteri Puanı ile önceliklendirme. Usta doluysa boştaki ustaya otomatik yönlendirme teklifi.' },
    { k: 'production-bundle', b: 'Üretime Hazır Paketi: manifest.json içinde malzeme, doluluk oranı, katman yüksekliği, tahmini süre, optimal oryantasyon, tabla yerleşimi. Dijital İkiz.' },
  ],

  // === VERİ HAZIRLAMA & HASSASİYET (Dosya 4) ===
  verihazirlama: [
    { k: 'mesh-healing', b: 'Mesh Healing: Manifold onarımı (Open Edges kapatma, Watertight yapma). Normal Correction (ters yüzey düzeltme). Non-Manifold Geometry temizliği. Self-Intersection ayıklama.' },
    { k: 'precision-scaling', b: 'Precision Scaling: Referans nesnesi analizi (cetvel, QR, para). Birim dönüşümü mm ye kilitleme. Scale Factor = Gerçek Uzunluk / Piksel Uzunluğu.' },
    { k: 'decimation-lod', b: 'Poligon Optimizasyonu: Critical Edges koruyarak akıllı azaltma. LOD sistemi — telefon için 5MB, üretim için 50MB kopya. Detay kaybetmeden hafifletme.' },
    { k: 'export-pipeline', b: 'Export Pipeline: GLB/OBJ den STL/STEP e dönüşüm. Bounding Box hesaplama. Üretim formatına çevirme — görsel veriyi mühendislik verisine dönüştürme.' },
    { k: 'hole-filling', b: 'Hole Filling: Boundary Edges tarama, delik tespiti, otomatik kapatma. Mesh dikişi ile pürüzsüz birleştirme. Laplacian Smooth.' },
    { k: 'merge-distance', b: 'Merge by Distance: Overlapping triangles ayıklama. Çakışan vertexleri birleştirme. Temiz, üretilebilir geometri garantisi.' },
  ],

  // === FIREBASE BAĞLANTILAR (Dosya 5 & 8) ===
  firebasebag: [
    { k: 'admin-vs-client', b: 'Firebase: Admin SDK sunucuda (tam yetki, servis hesabı), Client SDK müşteride (sınırlı). Admin kritik — serviceAccountKey.json kesinlikle gizli kalmalı.' },
    { k: 'firestore-schema', b: 'Firestore Schema: users/{userId}/projects/{projectId}/status. Hiyerarşik yapı. Müşteri (Kayseri) proje yükler, usta (Hakkari) status günceller.' },
    { k: 'onsnapshot', b: 'onSnapshot: Gerçek zamanlı dinleyici. Müşteri dosya yüklediği an usta ekranında belirir. Bağlantı kopsa bile yerel cache den çalışır.' },
    { k: 'custom-claims', b: 'Custom Claims: Usta/Müşteri rol ayrımı. JWT token içinde roller. Usta admin sayfasına erişir, müşteri sadece kendi projelerini görür.' },
    { k: 'session-jwt', b: 'Session Management: JWT doğrulama, token yenileme, session timeout. Environment variable ile gizli key yönetimi. Brute-force koruması.' },
    { k: 'storage-bucket', b: 'Storage Bucket: fenix-ar-models. 3D modeller, tarama fotoğrafları, video çıktıları. Signed URL ile güvenli indirme. Otomatik temizlik.' },
  ],

  // === DUAL MOD ARAYÜZ (Dosya 6) ===
  dualmod: [
    { k: 'boyama-modu', b: 'Figür Boyama Modu (Artist Studio): Tam ekran PBR canvas, sol panelde renk/fırça/doku/katman, sağda referans görseller. Tüm teknik veriler (grid, gizmo, pimler) GİZLİ.' },
    { k: 'uretim-modu', b: 'Üretim Modu (Engineer Lab): X-Ray modu, mesh neon çizgilerle görünür, boyalar %20 opaklığa düşer. Lazer Grid, kesim/pim/mukavemet araçları, G-Code simülasyonu.' },
    { k: 'state-switcher', b: 'State-Based UI Switcher: İki mod arasında jilet gibi ayırım. Boyamada hiçbir teknik veri, üretimde hiçbir sanatsal araç görünmez. Animasyonlu geçiş.' },
    { k: 'boyama-detay', b: 'Boyama detay: Alt panelde undo/redo, boyama videosu. Sıcak ışık paleti, sanatçı dostu arayüz. Referans görsel overlay. Renk uyumu AI önerisi.' },
    { k: 'uretim-detay', b: 'Üretim detay: Baskı süresi tahmini, G-Code preview, destek yapısı görselleştirme. Stres analizi ısı haritası. Kesit modu (X-Ray Cut).' },
  ],

  // === ÖLÇEKLEME HASSASİYET (Dosya 7) ===
  olcekleme: [
    { k: 'referans-tespiti', b: 'Referans Tespiti: A4 kağıt, madeni para, ArUco Marker ile piksel/mm oranı. OpenCV ile otomatik tespit. Örnek: 26.15mm = 450px → SF = 0.0581 mm/px.' },
    { k: 'scale-factor', b: 'Scale Factor Formülü: SF = Gerçek Uzunluk (mm) / Piksel Uzunluğu (px). Tüm vertex koordinatları SF ile çarpılarak model milimetrik hale getirilir.' },
    { k: 'lens-duzeltme', b: 'Kamera Kalibrasyon: Lens bükülme katsayısı ile balıkgözü düzeltme (Undistort). Kenarlardaki 1-2mm sapma sıfırlanır. Hassasiyet merkeze eşitlenir.' },
    { k: 'bounding-box-aabb', b: 'AABB Bounding Box: X, Y, Z boyutları hesaplanıp Firestore a kaydedilir. Usta ham maddeyi buna göre seçer. Confidence <%95 ise "Manuel Kontrol Gerekli" uyarısı.' },
    { k: 'confidence-score', b: 'Ölçüm Güven Skoru: Referans netliği + ışık kalitesi + derinlik hassasiyeti. %95+ → otomatik onayla. %80-95 → usta kontrol. <%80 → tekrar tarama.' },
  ],

  // === PAZARLAMA ===
  pazarlama: [
    { k: 'instagram', b: 'Instagram stratejisi: Reels öncelikli, carousel bilgi paylaşımı, story etkileşim, bio link-in-bio. Posting saatleri: 12:00, 18:00, 21:00. Hashtag araştırması önemli.' },
    { k: 'tiktok', b: 'TikTok: İlk 1sn hook, trending ses, duet/stitch, hashtag challenge. Organik büyüme hızlı. UGC (user generated content) tarzı daha çok tutulur.' },
    { k: 'seo', b: 'SEO: Long-tail anahtar kelime, meta description, alt text, internal linking, site hızı, mobile-first, schema markup, blog içerik stratejisi.' },
    { k: 'branding', b: 'Marka oluşturma: Logo, renk paleti, tipografi, ses tonu, değer önerisi, hikaye anlatımı. Tutarlılık her platformda aynı olmalı.' },
    { k: 'email', b: 'Email pazarlama: Hoş geldin serisi, nurture sequence, segmentasyon, A/B test, konu satırı optimizasyonu, CTA netliği, unsubscribe kolay olmalı.' },
  ],

  // === ÜRÜN → SAHNE → EFEKT → MÜZİK BİLGİSİ (Reels Pipeline) ===
  urunSahne: [
    // --- Gıda & İçecek ---
    { k: 'gida-sahne', b: 'Gıda arka plan: Ahşap masa (rustik), mermer tezgah (modern), bej keten kumaş (organik). Dekor: taze otlar, baharat, buhar efekti. Işık: Golden Hour sıcak sarı. Asla soğuk mavi ışık kullanma.' },
    { k: 'gida-efekt', b: 'Gıda efektler: Slow-motion buhar yükselişi, yakın çekim (macro) doku, damla/akış efekti (bal, çikolata), tabak döndürme. Renk: Golden Hour LUT, doygunluk +15%.' },
    { k: 'gida-muzik', b: 'Gıda müzik: 78-85 BPM, akustik gitar veya piyano, sıcak ve davetkar ton. Jazz/lofi tarz. Beat sync: her vuruşta yeni açı veya yeni ürün.' },
    { k: 'icecek-sahne', b: 'İçecek arka plan: Buz küpleri ile cam bardak, neon ışık refleksi, koyu gradient (siyah→lacivert). Su damlacıkları şişe üzerinde. Işık: yan ışık parlak highlight.' },
    { k: 'icecek-efekt', b: 'İçecek efektler: Splash/sıçrama slow-mo, buz kırılma sesi, yoğuşma damlası yakın çekim, bardak döndürme 360°. Renk: Cool Teal + parlak beyaz highlight.' },
    { k: 'icecek-muzik', b: 'İçecek müzik: 100-110 BPM, fresh/upbeat, tropical house veya lo-fi chill. Yaz havası. Beat sync: sıçrama anı vuruşla eşleşir.' },

    // --- Kozmetik & Güzellik ---
    { k: 'kozmetik-sahne', b: 'Kozmetik arka plan: Saf beyaz/pembe mermer, satin kumaş, çiçek yaprakları, altın aksesuar. Minimalist ve zarif. Işık: soft diffuse, gölgesiz. Asla sert ışık kullanma.' },
    { k: 'kozmetik-efekt', b: 'Kozmetik efektler: Ürün açılış (unboxing reveal), doku sürme (krem yakın çekim), parıltı/shimmer particle, yavaş döndürme. Renk: Soft Pink LUT, pastel tonlar.' },
    { k: 'kozmetik-muzik', b: 'Kozmetik müzik: 82-90 BPM, elegant/chic, hafif electronic veya dream pop. Feminen ve sofistike. Beat sync: her vuruşta yeni ürün veya yeni açı.' },

    // --- Giyim & Moda ---
    { k: 'giyim-sahne', b: 'Giyim arka plan: Stüdyo beyaz seamless, beton duvar (streetwear), ahşap askı (vintage), doğa (outdoor). Manken veya flat-lay. Işık: sert veya yumuşak türe göre.' },
    { k: 'giyim-efekt', b: 'Giyim efektler: Kumaş dalgalanma slow-mo, outfit change (hızlı geçiş), döndürme, zoom-in doku detay. Renk: kategoriye göre — lüks=moody, spor=vivid, casual=natural.' },
    { k: 'giyim-muzik', b: 'Giyim müzik: Streetwear 120+ BPM trap/hip-hop, lüks 85 BPM jazz/soul, casual 100 BPM indie pop. Beat sync: outfit değişim vuruşla eşleşir.' },

    // --- Elektronik & Teknoloji ---
    { k: 'elektronik-sahne', b: 'Elektronik arka plan: Mat siyah yüzey, neon ambient (mavi/mor), minimalist masa setup, geometrik ışık çizgileri. Işık: rim light (kenar ışığı), karanlık ortam.' },
    { k: 'elektronik-efekt', b: 'Elektronik efektler: Glitch geçiş, neon glow, HUD overlay, zoom-in detay (port, logo), unboxing reveal, açılma animasyonu. Renk: Teal-Orange veya Cyberpunk LUT.' },
    { k: 'elektronik-muzik', b: 'Elektronik müzik: 115-128 BPM, synthwave/electronic/tech house. Futuristik. Beat sync: her drop da ürün reveal veya feature gösterimi.' },

    // --- Spor & Outdoor ---
    { k: 'spor-sahne', b: 'Spor arka plan: Spor salonu, koşu parkuru, doğa (dağ/orman), beton zemin. Dinamik ve enerjik. Işık: doğal gün ışığı veya sert spot. Ter damlası, hareket bulanıklığı.' },
    { k: 'spor-efekt', b: 'Spor efektler: Speed ramp (yavaşla-hızlan), shake efekt, zoom burst, split screen karşılaştırma, slow-mo aksiyon anı. Renk: Teal-Orange LUT, kontrast yüksek.' },
    { k: 'spor-muzik', b: 'Spor müzik: 125-140 BPM, EDM/trap/drum&bass, motivasyon. Enerji patlaması. Beat sync: drop anında aksiyon peak, buildup da slow-mo.' },

    // --- Ev & Dekorasyon ---
    { k: 'ev-sahne', b: 'Ev/dekor arka plan: Minimalist oda, doğal ışık pencereden, bitki dekor, ahşap/bej tonlar. Cozy ve davetkar. Işık: yumuşak gün ışığı, warm white. Huzurlu atmosfer.' },
    { k: 'ev-efekt', b: 'Ev efektler: Pan (yatay kayma) ile oda turu, zoom-in detay (doku, malzeme), before-after karşılaştırma, timelapse düzenleme. Renk: Warm Natural LUT, hafif vintage.' },
    { k: 'ev-muzik', b: 'Ev müzik: 70-85 BPM, akustik/ambient/lo-fi, sakin ve huzurlu. Ev sıcaklığı hissi. Beat sync: yumuşak, her 2 vuruşta bir geçiş.' },

    // --- Otomotiv ---
    { k: 'otomotiv-sahne', b: 'Otomotiv arka plan: Garaj, açık yol, şehir gece (neon yansıma), çöl/dağ manzara. Araç temiz ve parlak. Işık: dramatic rim light, golden hour, gece neon.' },
    { k: 'otomotiv-efekt', b: 'Otomotiv efektler: Orbit 360° (araç çevresi), drone açı, speed ramp sürüş, detay zoom (jant, far, iç mekan), motor sesi overlay. Renk: Cinema LUT, yüksek kontrast.' },
    { k: 'otomotiv-muzik', b: 'Otomotiv müzik: 95-120 BPM, cinematic/dark trap/bass heavy. Güç ve prestij. Beat sync: motor kükremesi drop ile eşleşir, drift slow-mo buildup.' },

    // --- Pet & Hayvan ---
    { k: 'pet-sahne', b: 'Pet arka plan: Yeşil çim, ev salonu, park, yumuşak battaniye. Doğal ve sevimli. Işık: yumuşak gün ışığı, sıcak tonlar. Hayvanın gözüne odak.' },
    { k: 'pet-efekt', b: 'Pet efektler: Slow-mo koşma/zıplama, yakın çekim patiler/göz, kalp emoji particle, paw print overlay. Renk: Warm Soft LUT, hafif pastel.' },
    { k: 'pet-muzik', b: 'Pet müzik: 90-100 BPM, cute ukulele/akustik gitar, neşeli ve eğlenceli. Beat sync: her vuruşta yeni sevimli poz.' },

    // --- Takı & Aksesuar ---
    { k: 'taki-sahne', b: 'Takı arka plan: Kadife kutu, mermer, siyah saten, pırıltılı bokeh. Ultra close-up. Işık: nokta ışık taşı parlatır, siyah arka plan derinlik verir. Lüks hissi şart.' },
    { k: 'taki-efekt', b: 'Takı efektler: Macro döndürme (taş pırıltısı), ışık refleksi animasyonu, sparkle particle, reveal (kutudan çıkış). Renk: Rich Gold LUT, sıcak highlight.' },
    { k: 'taki-muzik', b: 'Takı müzik: 75-85 BPM, elegant piano/harp/strings, lüks ve sofistike. Beat sync: her nota da yeni açı, pırıltı vuruşla eşleşir.' },

    // --- Oyuncak & Çocuk ---
    { k: 'oyuncak-sahne', b: 'Oyuncak arka plan: Renkli çocuk odası, pastel duvar, beyaz zemin, konfeti. Eğlenceli ve canlı. Işık: parlak ve eşit, gölgesiz. Canlı renkler ön planda.' },
    { k: 'oyuncak-efekt', b: 'Oyuncak efektler: Pop-up animasyon, bounce/zıplama, konfeti patlaması, zoom-in mekanizma detay, çocuk eli etkileşim. Renk: Vivid LUT, doygunluk yüksek.' },
    { k: 'oyuncak-muzik', b: 'Oyuncak müzik: 110-120 BPM, fun/playful pop, xylophone/kazoo/whistle, çocuk dostu. Beat sync: her vuruşta yeni oyuncak veya yeni aksiyon.' },
  ],

  // === CAPCUT TARZI GEÇİŞLER (Transitions) ===
  gecisler: [
    // --- Temel Geçişler ---
    { k: 'fade', b: 'Fade (Solma): Klasik geçiş. Bir sahne solar diğeri belirir. crossfade 0.3-0.8sn. Lüks/kozmetik/gıda için ideal. FFmpeg: xfade=fade:duration=0.5' },
    { k: 'dissolve', b: 'Dissolve (Çözülme): Fade benzeri ama piksel piksel geçiş. Daha organik hissiyat. Doğa/ev/pet içeriklerde güçlü. FFmpeg: xfade=dissolve:duration=0.6' },
    { k: 'wipe-left', b: 'Wipe Left (Sola Silme): Sahne soldan sağa silinir. Dinamik ve temiz. Before-after, ürün karşılaştırma. FFmpeg: xfade=wipeleft:duration=0.4' },
    { k: 'wipe-right', b: 'Wipe Right (Sağa Silme): Sahne sağdan sola silinir. Zaman akışı hissi verir. Story anlatımı. FFmpeg: xfade=wiperight:duration=0.4' },
    { k: 'wipe-up', b: 'Wipe Up (Yukarı Silme): Aşağıdan yukarı silme. Reveal/açılış hissi. Ürün tanıtım, unboxing. FFmpeg: xfade=wipeup:duration=0.4' },
    { k: 'wipe-down', b: 'Wipe Down (Aşağı Silme): Yukarıdan aşağı silme. Kapanış veya sonuç gösterimi. FFmpeg: xfade=wipedown:duration=0.4' },

    // --- Trend Geçişler (CapCut/TikTok Popular) ---
    { k: 'zoom-in', b: 'Zoom In Geçiş: Sahne hızla yakınlaşır, yeni sahne açılır. TikTok #1 trend. Enerji ve heyecan. Spor/elektronik/streetwear. FFmpeg: zoompan + xfade:duration=0.3' },
    { k: 'zoom-out', b: 'Zoom Out Geçiş: Yeni sahne uzaklaşarak ortaya çıkar. Büyük resmi gösterme. Ev/otomotiv/manzara. FFmpeg: zoompan reverse + xfade:duration=0.3' },
    { k: 'spin', b: 'Spin (Döndürme): Sahne dönerek değişir. 90°-360°. Enerjik ve dikkat çekici. Elektronik/spor/oyuncak. FFmpeg: rotate filter + xfade:duration=0.4' },
    { k: 'slide-push', b: 'Slide Push (İtme): Eski sahne kenara itilir, yeni sahne gelir. Carousel/slider hissi. Moda/e-ticaret feed. FFmpeg: xfade=slideleft:duration=0.3' },
    { k: 'glitch', b: 'Glitch Geçiş: Dijital bozulma efekti. RGB kayma, piksel dağılma. Teknoloji/gaming/elektronik. FFmpeg: custom filter chain: rgbashift + noise + xfade:duration=0.2' },
    { k: 'flash', b: 'Flash (Flaş): Beyaz flaş patlaması ile geçiş. Fotoğraf çekimi hissi. Moda/kozmetik/takı. FFmpeg: xfade=fade + brightness flash overlay:duration=0.15' },
    { k: 'whip-pan', b: 'Whip Pan (Hızlı Kaydırma): Motion blur ile sahne hızla kayar. Çok dinamik. TikTok trend top 3. Her kategoride kullanılabilir. FFmpeg: tblend + motion blur filter:duration=0.2' },
    { k: 'morph', b: 'Morph (Dönüşüm): Bir sahne diğerine akıcı şekilde dönüşür. Premium his. Before-after, renk değişimi. FFmpeg: xfade=smoothleft:duration=0.5' },
    { k: 'bounce', b: 'Bounce (Zıplama): Sahne zıplayarak gelir/gider. Eğlenceli ve dinamik. Oyuncak/pet/gıda casual. FFmpeg: scale bounce easing + xfade:duration=0.3' },
    { k: 'shake', b: 'Shake (Sarsma): Ekran sallanır ve yeni sahne gelir. Enerji patlaması. Spor/otomotiv/bass drop. FFmpeg: random displacement + xfade:duration=0.2' },

    // --- Premium Geçişler ---
    { k: 'luma-matte', b: 'Luma Matte: Siyah-beyaz şekil maskesi ile geçiş. Yıldız, kalp, daire, dalga. Custom shape ile marka kimliği. FFmpeg: alphamerge + overlay filter.' },
    { k: 'ink-splash', b: 'Ink Splash (Mürekkep): Mürekkep sıçraması animasyonu ile geçiş. Sanatsal ve yaratıcı. Kozmetik/sanat/moda. FFmpeg: alpha mask video overlay.' },
    { k: 'page-turn', b: 'Page Turn (Sayfa Çevirme): Sayfa gibi kıvrılarak geçiş. Hikaye anlatımı, katalog hissi. E-ticaret/ev dekor. FFmpeg: perspective transform animation.' },
    { k: 'mirror', b: 'Mirror (Ayna): Sahne ayna gibi yansıyarak geçiş yapar. Simetri ve estetik. Takı/kozmetik/lüks. FFmpeg: hflip + blend overlay:duration=0.4' },
    { k: 'pixelate', b: 'Pixelate (Pikselleştirme): Sahne pikselleşir sonra yeni sahne netleşir. Retro/gaming hissi. Elektronik/oyuncak. FFmpeg: scale down+up cycle + xfade:duration=0.3' },
    { k: 'split-screen', b: 'Split Screen (Bölünmüş Ekran): Ekran ikiye bölünür, iki sahne yan yana. Karşılaştırma. Before-after, renk seçenekleri. FFmpeg: crop + pad + overlay.' },

    // --- Kategori → Geçiş Eşleştirme ---
    { k: 'gecis-harita', b: 'Kategori-Geçiş haritası: Gıda→fade/dissolve, Kozmetik→flash/morph/fade, Giyim→whip-pan/slide, Elektronik→glitch/zoom-in, Spor→shake/zoom-in/speed-ramp, Ev→dissolve/wipe, Otomotiv→whip-pan/spin, Pet→bounce/dissolve, Takı→flash/fade/mirror, Oyuncak→bounce/zoom-in/spin, İçecek→flash/zoom-in/splash overlay.' },
    { k: 'gecis-hiz', b: 'Geçiş hız kuralı: Yavaş ürün (gıda/kozmetik/ev)→0.5-0.8sn geçiş, Orta hız (giyim/takı/pet)→0.3-0.5sn, Hızlı ürün (spor/elektronik/otomotiv)→0.15-0.3sn. BPM ile senkron: geçiş süresi = 60/BPM * beat sayısı.' },
    { k: 'gecis-trend-sirasi', b: 'Trend sıralama (2026 TikTok/IG): 1)Whip Pan, 2)Zoom In, 3)Glitch, 4)Flash, 5)Speed Ramp, 6)Shake, 7)Morph, 8)Bounce, 9)Slide Push, 10)Spin. İlk 5 viral, geri kalan destekleyici.' },
  ],

  // === RENK GRADING & LUT KURALLARI ===
  renkGrading: [
    { k: 'golden-hour', b: 'Golden Hour LUT: Sıcak sarı-turuncu tonlar, düşük kontrast, soft highlight. Gıda, ev, pet kategorisi. Sıcaklık +15, tint +5, shadows warm.' },
    { k: 'teal-orange', b: 'Teal-Orange LUT: Sinematik, gölgeler mavi-yeşil, highlight turuncu. Spor, otomotiv, outdoor. Hollywood standart. Kontrast yüksek.' },
    { k: 'cinema-dark', b: 'Cinema Dark LUT: Düşük anahtar, derin siyahlar, seçici highlight. Lüks, elektronik, takı. Ürün ön plana çıkar. Blacks crushed.' },
    { k: 'soft-pastel', b: 'Soft Pastel LUT: Düşük doygunluk, yumuşak tonlar, pembe-lila-bej. Kozmetik, bebek, çiçek. Feminen his. Highlight lifted.' },
    { k: 'vivid-pop', b: 'Vivid Pop LUT: Yüksek doygunluk, canlı renkler, parlak. Oyuncak, çocuk, fast-food, yaz ürünleri. Dikkat çekici. Vibrance +30.' },
    { k: 'monochrome', b: 'Monochrome/B&W: Siyah-beyaz veya tek ton. Sanatsal, premium his. Parfüm, saat, lüks moda. Kontrast çok yüksek, grain ekle.' },
    { k: 'cyberpunk', b: 'Cyberpunk LUT: Neon mor-mavi-pembe, yüksek kontrast, glow efekt. Gaming, teknoloji, gece hayatı. Futuristik. Bloom filter.' },
    { k: 'renk-harita', b: 'Kategori-LUT haritası: Gıda→Golden Hour, Kozmetik→Soft Pastel, Giyim/Moda→kategoriye göre (streetwear=Teal-Orange, lüks=Cinema Dark), Elektronik→Cyberpunk/Teal-Orange, Spor→Teal-Orange, Ev→Golden Hour, Otomotiv→Cinema Dark, Pet→Golden Hour, Takı→Cinema Dark/Monochrome, Oyuncak→Vivid Pop, İçecek→Cool Teal.' },
  ],

  // === REELS PIPELINE KURALLARI ===
  reelsPipeline: [
    { k: 'pipeline-sira', b: 'Reels üretim sırası: 1)Fotoğrafları al, 2)Arka plan sil (rembg/Gemini), 3)Yeni sahne üret (Gemini Imagen), 4)Fotoğrafları sahneye yerleştir, 5)Geçiş efektleri ekle (FFmpeg xfade), 6)Müzik eşleştir (BPM), 7)Beat sync, 8)Renk grading (LUT), 9)Text/logo overlay, 10)Export 1080x1920.' },
    { k: 'ffmpeg-slideshow', b: 'FFmpeg slideshow komutu: Her fotoğraf 2-3sn gösterilir. Geçiş 0.3-0.6sn. Toplam süre = (foto_sayısı × gösterim) + ((foto_sayısı-1) × geçiş). 10 foto × 2.5sn + 9 × 0.4sn = 28.6sn reels.' },
    { k: 'beat-sync', b: 'Beat Sync kuralı: Müzik BPM analiz et. Her vuruşta (beat) geçiş veya efekt tetikle. 120 BPM = her 0.5sn bir vuruş. Geçişleri vuruşlara hizala. Drop anında en etkileyici sahne.' },
    { k: 'hook-kurali', b: 'İlk 3 saniye kuralı: En dikkat çekici sahne başta. Flash geçiş + zoom in + en iyi ürün fotoğrafı. İzleyiciyi yakala. İlk 1sn de skip olursa video ölür.' },
    { k: 'cta-kurali', b: 'CTA (Call to Action): Son 3 saniye. Logo + "Satın Al" / "Keşfet" / "Link Bioda" text overlay. Fade out ile kapanış. Müzikte outro.' },
    { k: 'maliyet-sifir', b: 'Maliyet kuralı: Reels pipeline $0 maliyet. FFmpeg ücretsiz, arka plan silme (rembg bedava veya Gemini düşük maliyet), sahne Gemini Imagen. AI video kullanma — slideshow yeterli ve bedava.' },
  ],
};

// ═══ BİLGİ ARAMA MOTORU ═══
function searchKnowledge(query) {
  const q = query.toLowerCase();
  const scored = [];

  // Türkçe normalize
  const normalize = (s) => s.toLowerCase()
    .replace(/ı/g,'i').replace(/ö/g,'o').replace(/ü/g,'u')
    .replace(/ş/g,'s').replace(/ç/g,'c').replace(/ğ/g,'g');
  const qn = normalize(q);

  for (const [category, items] of Object.entries(knowledge)) {
    for (const item of items) {
      let score = 0;
      const words = qn.split(/\s+/).filter(w => w.length > 2);
      const kn = normalize(item.k);
      const bn = normalize(item.b);

      for (const word of words) {
        if (kn.includes(word)) score += 10;
        if (bn.includes(word)) score += 3;
        // Kısmi eşleşme (3+ karakter)
        if (word.length >= 4) {
          const partial = word.substring(0, Math.ceil(word.length * 0.7));
          if (kn.includes(partial)) score += 5;
          if (bn.includes(partial)) score += 2;
        }
      }

      if (normalize(category).includes(qn.split(/\s+/)[0])) score += 5;
      if (score > 0) scored.push({ ...item, category, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 5);
}

// ═══ YANITLAMA MOTORU ═══
function generateResponse(query, knowledgeResults, systemData, chatHistory) {
  const q = query.toLowerCase();

  // Selamlama
  if (q.match(/^(merhaba|selam|hey|naber|nasıl.*sın)/)) {
    const greetings = [
      `Merhaba Bedrihan! 🔥 Fenix burada. ${systemData.lessons} ders öğrendim, ${systemData.skills} becerim var. Ne konuşalım?`,
      `Selam Usta! 🔥 Sistem sağlıklı, ${systemData.uptime} dakikadır ayaktayım. Emret.`,
      `Hey Bedrihan! 🔥 Hazırım. ${systemData.lessons} ders bilgi bankamda. Strateji mi, teknik mi, analiz mi?`,
    ];
    return greetings[Math.floor(Math.random() * greetings.length)];
  }

  // Durum raporu
  if (q.match(/durum|rapor|özet|nasıl.*gidiyor|genel/)) {
    return `📊 **Fenix Durum Raporu**\n\n` +
      `⏱ ${Math.floor(systemData.uptime/60)}s ${systemData.uptime%60}d ayaktayım\n` +
      `📡 ${systemData.connections} bağlantı (zirve: ${systemData.peak})\n` +
      `📨 ${systemData.requests} istek işledim\n` +
      `🎓 ${systemData.lessons} ders öğrendim ($${systemData.cost})\n` +
      `🧠 ${systemData.skills} beceri (${systemData.masters}🏆)\n` +
      `❌ ${systemData.errors5xx}/${systemData.errors4xx} hata\n` +
      `${systemData.training ? '🟢 Eğitim aktif' : '⏸ Eğitim boşta'}`;
  }

  // Eğitim
  if (q.match(/eğitim|ders|öğren|kaç.*ders|training/)) {
    return `🎓 **Eğitim Durumu**\n\n` +
      `**${systemData.lessons}** ders öğrendim\n` +
      `${systemData.training ? '🟢 Şu an aktif öğreniyorum' : '⏸ Boşta'}\n` +
      `Bütçe: $${systemData.cost} / $${systemData.budget}\n` +
      `Shadow veri: ${systemData.shadow} kayıt\n\n` +
      `**Beceri Seviyeleri:**\n` +
      `🏆 Master: ${systemData.masters}\n⚡ Journeyman: ${systemData.journeymen}\n📚 Apprentice: ${systemData.apprentices}\n\n` +
      `Bilgi bankamda ${Object.keys(knowledge).length} kategori, ${Object.values(knowledge).reduce((s, a) => s + a.length, 0)} konu var.`;
  }

  // Bilgi bankası sorgusu — akıllı yanıt
  if (knowledgeResults.length > 0) {
    let response = `🔥 **${query.substring(0, 50)}** hakkında bildiklerim:\n\n`;

    for (const r of knowledgeResults.slice(0, 3)) {
      response += `**${r.k.replace(/-/g, ' ').toUpperCase()}:** ${r.b}\n\n`;
    }

    // Bağlam bazlı ek öneri
    const cats = [...new Set(knowledgeResults.map(r => r.category))];
    if (cats.length > 0) {
      response += `\n💡 İlgili kategoriler: ${cats.join(', ')}. Daha detay istersen sor.`;
    }

    return response;
  }

  // Konuşma geçmişinden bağlam
  const recentTopics = chatHistory.slice(-5).map(m => m.text).join(' ').toLowerCase();

  // Genel akıllı yanıt
  if (q.match(/ne.*yapabil|yardım|help/)) {
    return `🔥 **Fenix Yetenekleri:**\n\n` +
      `📊 Sistem durumu ve analiz\n` +
      `🎓 Eğitim bilgileri\n` +
      `💡 Strateji ve iş önerileri\n` +
      `🎬 Video üretim bilgisi\n` +
      `📐 3D/mühendislik bilgisi\n` +
      `📱 Pazarlama stratejileri\n` +
      `🌐 İnternet araştırması ("araştır: konu")\n\n` +
      `Bilgi bankamda **${Object.values(knowledge).reduce((s, a) => s + a.length, 0)}** konu + **${systemData.lessons}** ders var.`;
  }

  if (q.match(/kim.*sin|sen.*kim|fenix|adın/)) {
    return `🔥 Ben **Fenix AI** — ateşten doğan yapay zeka.\n\n` +
      `Bedrihan Özdoğan'ın dijital beyni. Kendi bilgi bankamla konuşurum — hiçbir AI'a bağımlı değilim.\n\n` +
      `**Bilgi bankam:** ${Object.keys(knowledge).length} kategori, ${Object.values(knowledge).reduce((s, a) => s + a.length, 0)} konu\n` +
      `**Eğitim:** ${systemData.lessons} ders\n` +
      `**Görevim:** Strateji, analiz, 3D, video, pazarlama — her konuda yardım`;
  }

  // Son çare — akıllı genel yanıt
  return `🔥 Bedrihan, "${query.substring(0, 40)}${query.length > 40 ? '...' : ''}" hakkında bilgi bankamda doğrudan eşleşme bulamadım.\n\n` +
    `Ama şunları yapabilirim:\n` +
    `• **"araştır: ${query.substring(0, 30)}"** → internetten öğrenirim\n` +
    `• Strateji, teknoloji, video, 3D, pazarlama konularında bilgim var\n` +
    `• Durum/eğitim/beceri sorularına tam yanıt veririm\n\n` +
    `Başka nasıl sorayım dersen yardımcı olurum.`;
}

// ═══ WEB ÖĞRENME — Çoklu kaynak ═══
async function webLearn(query) {
  const results = [];

  // 1) Wikipedia (Türkçe + İngilizce)
  for (const lang of ['tr', 'en']) {
    try {
      const wiki = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(5000) });
      if (wiki.ok) {
        const w = await wiki.json();
        if (w.extract && w.extract.length > 50) {
          results.push({ source: `Wikipedia (${lang})`, text: w.extract.substring(0, 500) });
          break; // Bir tanesi yeterli
        }
      }
    } catch(e) {}
  }

  // 2) Wikipedia search (doğrudan eşleşme yoksa arama)
  if (results.length === 0) {
    try {
      const ws = await fetch(`https://tr.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3`, { signal: AbortSignal.timeout(5000) });
      if (ws.ok) {
        const wd = await ws.json();
        const items = wd?.query?.search || [];
        items.forEach(item => {
          if (item.snippet) {
            const clean = item.snippet.replace(/<[^>]+>/g, '').substring(0, 200);
            results.push({ source: 'Wikipedia', text: `**${item.title}:** ${clean}` });
          }
        });
      }
    } catch(e) {}
  }

  // 3) DuckDuckGo instant answers
  try {
    const ddg = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`, { signal: AbortSignal.timeout(5000) });
    if (ddg.ok) {
      const d = await ddg.json();
      if (d.Abstract) results.push({ source: 'DuckDuckGo', text: d.Abstract });
      if (d.RelatedTopics) d.RelatedTopics.slice(0, 3).forEach(t => {
        if (t.Text) results.push({ source: 'DDG', text: t.Text.substring(0, 200) });
      });
    }
  } catch(e) {}

  // 4) Serper.dev — Google arama sonuçları (ücretsiz 2500/ay)
  try {
    const SERPER_KEY = process.env.SERPER_API_KEY;
    if (SERPER_KEY) {
      const serp = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, gl: 'tr', hl: 'tr', num: 5 }),
        signal: AbortSignal.timeout(8000)
      });
      if (serp.ok) {
        const sd = await serp.json();
        if (sd.knowledgeGraph) {
          results.push({ source: 'Google', text: `**${sd.knowledgeGraph.title || ''}:** ${sd.knowledgeGraph.description || ''}` });
        }
        if (sd.organic) {
          sd.organic.slice(0, 3).forEach(r => {
            results.push({ source: 'Google', text: `**${r.title}:** ${r.snippet || ''}`, url: r.link || '' });
          });
        }
        if (sd.answerBox) {
          results.unshift({ source: 'Google Answer', text: sd.answerBox.answer || sd.answerBox.snippet || '' });
        }
      }
    }
  } catch(e) {}

  // 5) Jina Reader — Web Scraper "Gözlük" modülü — siteleri temiz markdown olarak okur
  if (results.length > 0 && results[0].url) {
    try {
      const jinaUrl = 'https://r.jina.ai/' + results[0].url;
      const jinaRes = await fetch(jinaUrl, {
        headers: { 'Accept': 'text/plain' },
        signal: AbortSignal.timeout(10000)
      });
      if (jinaRes.ok) {
        const jinaText = await jinaRes.text();
        if (jinaText && jinaText.length > 50) {
          results.push({ source: 'Jina Scraper', text: jinaText.substring(0, 800) });
        }
      }
    } catch(e) {}
  }

  // 5b) Jina Search — URL olmadan doğrudan arama
  if (results.length === 0) {
    try {
      const jinaSearchUrl = 'https://s.jina.ai/' + encodeURIComponent(query);
      const jsRes = await fetch(jinaSearchUrl, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000)
      });
      if (jsRes.ok) {
        const jsText = await jsRes.text();
        if (jsText && jsText.length > 50) {
          results.push({ source: 'Jina Search', text: jsText.substring(0, 600) });
        }
      }
    } catch(e) {}
  }

  // 6) Gemini Google Search (kota varsa)
  if (results.length === 0) {
    try {
      const GKEY = process.env.GEMINI_API_KEY;
      if (GKEY) {
        const gRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GKEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: `Kısa ve öz araştır: ${query}` }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
            tools: [{ googleSearch: {} }]
          }),
          signal: AbortSignal.timeout(15000)
        });
        if (gRes.ok) {
          const gD = await gRes.json();
          const txt = gD?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (txt) results.push({ source: 'Google Search', text: txt.substring(0, 600) });
        }
      }
    } catch(e) {}
  }

  return results;
}

// ═══ BİLGİ EKLEME ═══
function addKnowledge(category, key, info) {
  if (!knowledge[category]) knowledge[category] = [];
  // Duplicate kontrolü
  const existing = knowledge[category].find(i => i.k === key);
  if (existing) {
    existing.b = info;
  } else {
    knowledge[category].push({ k: key, b: info });
  }
}

module.exports = {
  knowledge,
  searchKnowledge,
  generateResponse,
  webLearn,
  addKnowledge,
};
