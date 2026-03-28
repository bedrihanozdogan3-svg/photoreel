const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { validate, schemas } = require('../middlewares/validate');
const logger = require('../utils/logger');

// Firestore lazy init — credentials yoksa bellekte çalış
let _firestoreDb = null;
let _firestoreAvailable = false;
function getDb() {
  if (_firestoreDb) return _firestoreDb;
  try {
    const { Firestore } = require('@google-cloud/firestore');
    _firestoreDb = new Firestore({ projectId: 'photoreel-491017' });
    _firestoreAvailable = true;
    return _firestoreDb;
  } catch(e) {
    logger.warn('Claude-local: Firestore bağlanamadı, bellek modu');
    _firestoreAvailable = false;
    return null;
  }
}

// Bellek fallback
const memMessages = [];
const memReplies = [];

// Dosya listesini başlangıçta 1 kez oku, önbellekte tut
let _cachedFileList = null;
function getCachedFileList() {
  if (_cachedFileList) return _cachedFileList;
  try {
    const baseDir = path.join(__dirname, '..');
    const files = fs.readdirSync(baseDir).filter(f => !f.startsWith('.') && !f.startsWith('node_'));
    let list = '\nProje dosyaları: ' + files.join(', ');
    list += '\npublic/: ' + fs.readdirSync(path.join(baseDir, 'public')).join(', ');
    list += '\nroutes/: ' + fs.readdirSync(path.join(baseDir, 'routes')).join(', ');
    list += '\nservices/: ' + fs.readdirSync(path.join(baseDir, 'services')).join(', ');
    _cachedFileList = list;
    return list;
  } catch(e) { return ''; }
}

const MSG_COL = 'claude-messages';    // Tabletten gelen
const REPLY_COL = 'claude-replies';   // Claude'un yanıtları

// Gemini auto-reply (Claude gibi davranır)
async function autoReply(userText) {
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;

    // Son mesaj geçmişini Firestore'dan al
    let history = '';
    try {
      const snap = await db.collection(REPLY_COL).orderBy('createdAt', 'desc').limit(5).get();
      const replies = snap.docs.map(d => d.data()).reverse();
      const msgSnap = await db.collection(MSG_COL).orderBy('createdAt', 'desc').limit(5).get();
      const msgs = msgSnap.docs.map(d => d.data()).reverse();
      const all = [
        ...msgs.map(m => ({ text: `Bedrihan: ${m.text}`, ts: m.createdAt?._seconds || 0 })),
        ...replies.map(r => ({ text: `Claude: ${r.text}`, ts: r.createdAt?._seconds || 0 }))
      ].sort((a, b) => a.ts - b.ts);
      history = all.slice(-8).map(a => a.text).join('\n');
    } catch(e) {}

    // Firestore context
    let context = '';
    try {
      const firestoreService = require('../services/firestore-service');
      context = await firestoreService.getSystemContext();
    } catch(e) {}

    // Dosya yapısını önbellekten al (başlangıçta 1 kez oku)
    const fileList = getCachedFileList();

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: `Sen PhotoReel AI projesinin asistanısın. Bedrihan sana tablet üzerinden yazıyor. Türkçe, kısa ve net yanıt ver. Proje: PhotoReel AI - yapay zeka destekli fotoğraf/video düzenleme uygulaması. Cloud Run (europe-west1) üzerinde çalışıyor. Firestore veritabanı, Express.js server, Socket.io kullanılıyor. Gemini + Claude API entegrasyonu var.\n${fileList}\n\nSon konuşma:\n${history}\n${context}\n\nÖnemli: Dosya düzenleme veya deploy gibi işler istenirse yapamayacağını söyle ama projeyi analiz edebilir, eksikleri bulabilir, önerilerde bulunabilirsin.` }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }]
      })
    });
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch(e) {
    console.error('Auto-reply hata:', e.message);
    return null;
  }
}

// Tablet mesaj gönderir + otomatik Gemini yanıtı
router.post('/send', validate(schemas.sendToTablet), async (req, res) => {
  try {
    const { text, from } = req.body;
    if (!text) return res.json({ ok: false, error: 'Mesaj boş' });

    const id = Date.now().toString();
    const db = getDb();
    if (db) {
      try {
        const { Firestore } = require('@google-cloud/firestore');
        await db.collection(MSG_COL).doc(id).set({ text, from: from || 'tablet', timestamp: new Date().toISOString(), read: false, createdAt: Firestore.Timestamp.now() });
      } catch(fe) { logger.warn('Firestore mesaj kayıt hatası, bellek kullanılıyor'); }
    }
    memMessages.push({ id, text, from: from || 'tablet', timestamp: new Date().toISOString(), read: false });
    if (memMessages.length > 100) memMessages.shift();

    if (global.io) global.io.emit('claude_message_received', { id, text });
    logger.info(`TABLET → CLAUDE: ${text.substring(0,50)}`);

    res.json({ ok: true, messageId: id });

    // Arka planda Gemini yanıt
    const aiReply = await autoReply(text);
    if (aiReply) {
      const replyId = Date.now().toString();
      if (db) {
        try {
          const { Firestore } = require('@google-cloud/firestore');
          await db.collection(REPLY_COL).doc(replyId).set({ text: aiReply, from: 'claude', timestamp: new Date().toISOString(), createdAt: Firestore.Timestamp.now() });
        } catch(fe) {}
      }
      memReplies.push({ id: replyId, text: aiReply, from: 'claude', timestamp: new Date().toISOString() });
      if (memReplies.length > 100) memReplies.shift();
      if (global.io) global.io.emit('claude_reply', { id: replyId, text: aiReply });
      logger.info(`AUTO-REPLY: ${aiReply.substring(0,50)}`);
    }
  } catch(e) {
    logger.error('Send hata:', { error: e.message });
    if (!res.headersSent) res.json({ ok: false, error: e.message });
  }
});

// Claude Code inbox — okunmamış mesajları döner
router.get('/inbox', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const db = getDb();
    if (db) {
      try {
        const snap = await db.collection(MSG_COL).where('read', '==', false).limit(20).get();
        const messages = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => Number(a.id) - Number(b.id));
        return res.json({ messages });
      } catch(fe) {}
    }
    const messages = memMessages.filter(m => !m.read);
    res.json({ messages });
  } catch(e) {
    res.json({ messages: [] });
  }
});

// Mesajları okundu yap
router.post('/inbox/ack', validate(schemas.ackMessages), async (req, res) => {
  try {
    const { ids } = req.body;
    if (ids && ids.length) {
      const batch = db.batch();
      ids.forEach(id => {
        batch.update(db.collection(MSG_COL).doc(id), { read: true });
      });
      await batch.commit();
    }
    res.json({ ok: true });
  } catch(e) {
    console.error('ACK hata:', e.message);
    res.json({ ok: true });
  }
});

// Claude cevap yazar
router.post('/reply', validate(schemas.replyMessage), async (req, res) => {
  try {
    const { text, replyTo } = req.body;
    if (!text) return res.json({ ok: false });

    const id = Date.now().toString();
    await db.collection(REPLY_COL).doc(id).set({
      text,
      from: 'claude',
      replyTo: replyTo || null,
      timestamp: new Date().toISOString(),
      createdAt: Firestore.Timestamp.now()
    });

    if (global.io) global.io.emit('claude_reply', { id, text });
    console.log(`\n🔵 [CLAUDE → TABLET] ${text}\n`);
    res.json({ ok: true });
  } catch(e) {
    console.error('Reply hata:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// Tablet cevapları okur — since timestamp'ten sonrakileri döner
router.get('/replies', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const since = Number(req.query.since) || 0;
    const db = getDb();
    if (db) {
      try {
        const snap = await db.collection(REPLY_COL).orderBy('createdAt', 'desc').limit(20).get();
        const replies = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => Number(r.id) > since).sort((a, b) => Number(a.id) - Number(b.id));
        return res.json({ replies });
      } catch(fe) {}
    }
    // Bellek fallback
    const replies = memReplies.filter(r => Number(r.id) > since);
    res.json({ replies });
  } catch(e) {
    res.json({ replies: [] });
  }
});

// Geçmiş
router.get('/history', async (req, res) => {
  try {
    const [msgSnap, replySnap] = await Promise.all([
      db.collection(MSG_COL).orderBy('createdAt', 'desc').limit(25).get(),
      db.collection(REPLY_COL).orderBy('createdAt', 'desc').limit(25).get()
    ]);
    const msgs = msgSnap.docs.map(d => ({ id: d.id, ...d.data(), direction: 'tablet→claude' }));
    const replies = replySnap.docs.map(d => ({ id: d.id, ...d.data(), direction: 'claude→tablet' }));
    const all = [...msgs, ...replies].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    res.json({ history: all.slice(-50) });
  } catch(e) {
    res.json({ history: [] });
  }
});

module.exports = router;
