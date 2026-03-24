/**
 * Claude Bridge — Tabletten gelen mesajları okur, Claude Code cevaplar
 * Bu script bu terminalde çalışır, Claude Code ile birlikte
 */

const http = require('http');
const readline = require('readline');

const SERVER = 'http://localhost:3000';
const POLL_INTERVAL = 3000;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function checkMessages() {
  try {
    const data = await fetch(`${SERVER}/api/claude-local/inbox`);
    if (data.messages && data.messages.length > 0) {
      data.messages.forEach(msg => {
        console.log(`\n${'─'.repeat(50)}`);
        console.log(`💬 TABLET'TEN MESAJ [${new Date(msg.timestamp).toLocaleTimeString('tr-TR')}]`);
        console.log(`   "${msg.text}"`);
        console.log(`${'─'.repeat(50)}`);
        console.log(`Cevaplamak için yaz ve Enter'a bas:`);
      });
    }
  } catch(e) {}
}

async function sendReply(text) {
  try {
    await fetch(`${SERVER}/api/claude-local/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    console.log('✅ Cevap tablete gönderildi\n');
  } catch(e) {
    console.error('❌ Gönderilemedi:', e.message);
  }
}

console.log('🔵 Claude Bridge başlatıldı');
console.log('   Tabletten gelen mesajları bekliyor...');
console.log('   Cevap yazmak için yazıp Enter\'a basın\n');

// Mesajları kontrol et
setInterval(checkMessages, POLL_INTERVAL);

// Kullanıcı girişi (Claude Code cevap yazar)
rl.on('line', async (input) => {
  const text = input.trim();
  if (text) await sendReply(text);
});
