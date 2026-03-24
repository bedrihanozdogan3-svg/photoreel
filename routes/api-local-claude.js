const express = require('express');
const router = express.Router();

// Mesaj kuyruğu — tablet gönderir, Claude Code okur ve cevaplar
const messageQueue = [];    // Tabletten gelen mesajlar
const responseQueue = [];   // Claude'un cevapları

// Tablet mesaj gönderir
router.post('/send', (req, res) => {
  const { text, from } = req.body;
  if (!text) return res.json({ ok: false, error: 'Mesaj boş' });

  const msg = {
    id: Date.now().toString(),
    text,
    from: from || 'tablet',
    timestamp: new Date().toISOString(),
    read: false
  };
  messageQueue.push(msg);

  // Socket ile bildir
  if (global.io) {
    global.io.emit('claude_message_received', msg);
  }

  console.log(`\n💬 [TABLET → CLAUDE] ${text}\n`);

  res.json({ ok: true, messageId: msg.id });
});

// Claude Code bu endpoint'i poll eder — yeni mesajları okur
router.get('/inbox', (req, res) => {
  const unread = messageQueue.filter(m => !m.read);
  unread.forEach(m => m.read = true);
  res.json({ messages: unread });
});

// Claude Code cevap yazar
router.post('/reply', (req, res) => {
  const { text, replyTo } = req.body;
  if (!text) return res.json({ ok: false });

  const reply = {
    id: Date.now().toString(),
    text,
    from: 'claude',
    replyTo,
    timestamp: new Date().toISOString(),
    read: false
  };
  responseQueue.push(reply);

  // Socket ile tablete bildir
  if (global.io) {
    global.io.emit('claude_reply', reply);
  }

  console.log(`\n🔵 [CLAUDE → TABLET] ${text}\n`);

  res.json({ ok: true });
});

// Tablet cevapları okur
router.get('/replies', (req, res) => {
  const unread = responseQueue.filter(r => !r.read);
  unread.forEach(r => r.read = true);
  res.json({ replies: unread });
});

// Tüm geçmiş
router.get('/history', (req, res) => {
  const all = [
    ...messageQueue.map(m => ({ ...m, direction: 'tablet→claude' })),
    ...responseQueue.map(r => ({ ...r, direction: 'claude→tablet' }))
  ].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  res.json({ history: all.slice(-50) });
});

module.exports = router;
