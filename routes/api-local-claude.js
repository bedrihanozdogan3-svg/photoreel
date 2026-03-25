const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

// Mesaj kuyruğu — tablet gönderir, Claude Code okur ve cevaplar
const messageQueue = [];    // Tabletten gelen mesajlar
const responseQueue = [];   // Claude'un cevapları

// Konuşmaları dosyaya kaydet
const LOG_FILE = path.join(__dirname, '..', 'chat-history.json');
function saveToLog(msg) {
  try {
    let history = [];
    if (fs.existsSync(LOG_FILE)) {
      history = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    }
    history.push(msg);
    // Son 500 mesajı tut
    if (history.length > 500) history = history.slice(-500);
    fs.writeFileSync(LOG_FILE, JSON.stringify(history, null, 2));
  } catch(e) { console.log('Log kayit hatasi:', e.message); }
}

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
  saveToLog({ from: 'tablet', text, timestamp: msg.timestamp });

  res.json({ ok: true, messageId: msg.id });
});

// Claude Code bu endpoint'i poll eder — yeni mesajları okur
// read=true yapmaz, sadece /inbox/ack ile okundu yapılır
router.get('/inbox', (req, res) => {
  const unread = messageQueue.filter(m => !m.read);
  res.json({ messages: unread });
});

// Mesajları okundu yap (Claude okuduktan sonra çağırır)
router.post('/inbox/ack', (req, res) => {
  const { ids } = req.body;
  if (ids && ids.length) {
    ids.forEach(id => {
      const msg = messageQueue.find(m => m.id === id);
      if (msg) msg.read = true;
    });
  }
  res.json({ ok: true });
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
  saveToLog({ from: 'claude', text, timestamp: reply.timestamp });

  res.json({ ok: true });
});

// Tablet cevapları okur (son 20 reply her zaman döner — read flag kaldırıldı)
router.get('/replies', (req, res) => {
  const since = req.query.since || '0';
  const newer = responseQueue.filter(r => r.id > since);
  res.json({ replies: newer.slice(-20) });
});

// SSE stream — tablet bağlanır, gerçek zamanlı mesaj alır
router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('data: {"type":"connected"}\n\n');

  // Yeni reply gelince gönder
  const onReply = (reply) => {
    res.write(`data: ${JSON.stringify({type:'reply', ...reply})}\n\n`);
  };
  // Yeni mesaj gelince gönder (tablet→claude bildirim)
  const onMessage = (msg) => {
    res.write(`data: ${JSON.stringify({type:'message', ...msg})}\n\n`);
  };

  if (global.io) {
    global.io.on('claude_reply', onReply);
    global.io.on('claude_message_received', onMessage);
  }

  // Keepalive
  const keepalive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(keepalive);
    if (global.io) {
      global.io.removeListener('claude_reply', onReply);
      global.io.removeListener('claude_message_received', onMessage);
    }
  });
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
