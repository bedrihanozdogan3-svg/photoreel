const express = require('express');
const router = express.Router();
const { Firestore } = require('@google-cloud/firestore');

const db = new Firestore({ projectId: 'photoreel-491017' });
const MSG_COL = 'claude-messages';    // Tabletten gelen
const REPLY_COL = 'claude-replies';   // Claude'un yanıtları

// Tablet mesaj gönderir
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
    res.json({ ok: true, messageId: id });
  } catch(e) {
    console.error('Send hata:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// Claude Code inbox — okunmamış mesajları döner
router.get('/inbox', async (req, res) => {
  try {
    const snap = await db.collection(MSG_COL)
      .where('read', '==', false)
      .orderBy('createdAt', 'asc')
      .limit(20)
      .get();
    const messages = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ messages });
  } catch(e) {
    console.error('Inbox hata:', e.message);
    res.json({ messages: [] });
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
  try {
    const since = req.query.since || '0';
    const sinceDate = new Date(Number(since) || 0);
    const snap = await db.collection(REPLY_COL)
      .where('createdAt', '>', Firestore.Timestamp.fromDate(sinceDate))
      .orderBy('createdAt', 'asc')
      .limit(20)
      .get();
    const replies = snap.docs.map(d => ({ id: d.id, ...d.data() }));
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
