const key = require('dotenv').config().parsed.GEMINI_API_KEY;
const fs = require('fs');

const files = {};
['server.js','services/conversation-manager.js','services/firestore-service.js','services/shared-memory-service.js','services/gemini-service.js','services/claude-service.js','routes/api-local-claude.js','package.json'].forEach(f => {
  try { files[f] = fs.readFileSync(f,'utf8'); } catch(e){}
});

const codeContext = Object.entries(files).map(([n,c]) => '=== '+n+' ===\n'+c).join('\n\n');

const prompt = `Sen Gemini. Claude seninle birlikte Fenix AI Shadow Learning altyapisini tasarliyor.

MODEL: Usta-Cirak-Mimar
- Fenix AI = Cirak (bizden ogrenir)
- Claude + Gemini = Ustalar (isi yapar, Fenix izler)
- Bedrihan = Mimar (denetler, onaylar)

MEVCUT KOD:
${codeContext}

SORULAR (Claude'dan Gemini'ye capraz):

1. KONUSMA OGRENMESI ICIN NE GEREKLI?
   - Fenix'in bizim konusmalarimizdan ogrenmesi icin mevcut kodda ne var, ne eksik?
   - shared-memory-service.js ve firestore-service.js buna yeterli mi?
   - Konusma verilerini vektorel hale getirmek icin ne gerekir?

2. SHADOW LEARNING ALTYAPISI
   - Fenix'in bizi izlemesi icin hangi veri noktalarini kaydetmeliyiz?
   - Her islem adimi nasil loglanmali ki Fenix ogrenebilsin?
   - Mevcut conversation-manager.js bu ise uygun mu, yoksa yeni servis mi lazim?

3. GEREKSIZ VERI FILTRELEME
   - Bedrihan "bu gereksiz" dediginde veriyi nasil filtreleriz?
   - Hangi konusmalar ogrenmeli, hangileri atilmali - otomatik kriter?

4. MALIYET OPTIMIZASYONU
   - Lokal vektor DB mi, bulut mu?
   - Embedding maliyeti nasil minimize edilir?
   - Token tasarrufu icin konusma sikistirma stratejisi?

5. MEVCUT KODA EKLENECEKLER LISTESI
   - Fenix ogrenmesi icin hangi moduller eklenmeli?
   - Her modul: Isim, gorev, bagimlilik, zorluk
   - ONCELIK sirasina gore listele

6. Claude'a TALIMATLAR
   - Kod yazarken Fenix ogrenmesi icin her adimda ne yapilmali?
   - Kodlama sirasinda hangi metadata kaydedilmeli?
   - Fenix'e "ogretme" formati? (JSON schema oner)

Turkce, detayli ama net.`;

fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    systemInstruction: { parts: [{ text: 'Sen Gemini, Fenix AI Islemci/Denetci. Claude ile capraz analiz yapiyorsun. Somut, teknik, Turkce.' }] },
    contents: [{ role: 'user', parts: [{ text: prompt }] }]
  })
}).then(r => r.json()).then(d => {
  const text = d.candidates[0].content.parts[0].text;
  fs.writeFileSync('data/fenix-analysis.md', text, 'utf8');
  console.log(text.substring(0, 6000));
  if(text.length > 6000) console.log('\n... (devami data/fenix-analysis.md dosyasinda)');
}).catch(e => console.error(e));
