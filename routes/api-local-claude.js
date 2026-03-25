const express = require('express');
const router = express.Router();
const { Firestore } = require('@google-cloud/firestore');

const db = new Firestore({ projectId: 'photoreel-491017' });
const MSG_COL = 'claude-messages';    // Tabletten gelen
const REPLY_COL = 'claude-replies';   // Claude'un yanıtları

// Claude API auto-reply helper
async function claudeAutoReply(userText) {
  try {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return null;

    // Son mesaj geçmişini Firestore'dan al
    let history = '';
    try {
      const snap = await db.collection(MSG_COL).orderBy('createdAt', 'desc').limit(5).get();
      const msgs = snap.docs.map(d => d.data()).reverse();
      history = msgs.map(m => `${m.from}: ${m.text}`).join('\n');
    } catch(e) {}

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        system: `Sen Claude'sun. Bedrihan sana tablet üzerinden yazıyor. PhotoReel AI projesinde çalışıyorsunuz. Türkçe, kısa ve net yanıt ver. Dosya düzenleme veya deploy gibi işler istenirse "Bu işi bilgisayardaki Claude Code oturumundan yapabilirim" de.\n\nSon mesajlar:\n${history}`,
        messages: [{ role: 'user', content: userText }]
      })
    });
    const data = await res.json();
    return data?.content?.[0]?.text || null;
  } catch(e) {
    console.error('Claude auto-reply hata:', e.message);
    return null;
  }
}

// Tablet mesaj gönderir + otomatik Gemini yanıtı
router.post('/send', async (req, res) => {
  try {
    const { text, from } = req.body;
    if (!text) return res.json({ ok: false, error: 'Mesaj boş' });

    const id = Date.now().toString();
    await db.collection(MSG_COL).doc(id).set({
      text,
      from: from || 'tablet',
      timestamp: new Date().toISOString(),
      read: false,
      createdAt: Firestore.Timestamp.now()
    });

    if (global.io) global.io.emit('claude_message_received', { id, text });
    console.log(`\n💬 [TABLET → CLAUDE] ${text}\n`);

    // Hemen yanıt dön, Gemini arka planda yanıt verecek
    res.json({ ok: true, messageId: id });

    // Arka planda Claude API otomatik yanıt
    const claudeReply = await claudeAutoReply(text);
    if (claudeReply) {
      const replyId = Date.now().toString();
      await db.collection(REPLY_COL).doc(replyId).set({
        text: claudeReply,
        from: 'claude',
        timestamp: new Date().toISOString(),
        createdAt: Firestore.Timestamp.now()
      });
      if (global.io) global.io.emit('claude_reply', { id: replyId, text: claudeReply });
      console.log(`\n🤖 [AUTO-REPLY] ${claudeReply}\n`);
    }
  } catch(e) {
    console.error('Send hata:', e.message, e.stack);
    if (!res.headersSent) res.json({ ok: false, error: e.message });
  }
});

// Claude Code inbox — okunmamış mesajları döner
router.get('/inbox', async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  try {
    const snap = await db.collection(MSG_COL)
      .where('read', '==', false)
      .limit(20)
      .get();
    const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => Number(a.id) - Number(b.id));
    res.json({ messages });
  } catch(e) {
    console.error('Inbox hata:', e.message);
    res.json({ messages: [], error: e.message });
  }
});

// Mesajları okundu yap
router.post('/inbox/ack', async (req, res) => {
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
router.post('/reply', async (req, res) => {
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
    const snap = await db.collection(REPLY_COL)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();
    const replies = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(r => Number(r.id) > since)
      .sort((a, b) => Number(a.id) - Number(b.id));
    res.json({ replies });
  } catch(e) {
    console.error('Replies hata:', e.message);
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
