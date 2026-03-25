require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'https://photoreel-194617495310.europe-west1.run.app'
];

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: ALLOWED_ORIGINS } });
app.use(cors({
  origin: function(origin, cb) {
    // Sunucu-sunucu istekler (origin yok) veya izinli origin'ler
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(null, false);
  }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Dashboard ana sayfa
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// PhotoReel v9 app
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'photoreel_v9.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

// API routes
const chatRoutes = require('./routes/api-chat');
app.use('/api/chat', chatRoutes(io));

// Agent API (tablet uzaktan kontrol)
const agentRoutes = require('./routes/api-agent');
app.use('/api/agent', agentRoutes);

// Local Claude (API key olmadan tablet↔Claude iletişimi)
const localClaudeRoutes = require('./routes/api-local-claude');
app.use('/api/claude-local', localClaudeRoutes);

// Tablet kontrol paneli
app.get('/kontrol', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kontrol.html'));
});

// Onay sistemi API
const approvalRoutes = require('./routes/api-approval');
app.use('/api/approval', approvalRoutes);

// Terminal output API (bilgisayardan tablete canlı kod akışı)
const terminalBuffer = [];
app.post('/api/terminal/output', (req, res) => {
  const { text } = req.body;
  if (text) {
    terminalBuffer.push({ text, timestamp: new Date().toISOString() });
    if (terminalBuffer.length > 200) terminalBuffer.shift();
    if (global.io) global.io.emit('terminal_output', text);
  }
  res.json({ ok: true });
});

// Terminal buffer getir (polling için)
app.get('/api/terminal/lines', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const newLines = terminalBuffer.slice(since);
  res.json({ lines: newLines, total: terminalBuffer.length });
});

// Health check (Cloud Run için)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Socket.io connection
global.io = io;

io.on('connection', (socket) => {
  console.log('Dashboard bağlandı:', socket.id);
  socket.emit('status', { state: 'idle', message: 'Bağlantı kuruldu' });

  socket.on('disconnect', () => {
    console.log('Dashboard ayrıldı:', socket.id);
  });
});

// === KOTA & MALIYET TAKIP SISTEMI (dosya tabanlı — restart'ta korunur) ===
const QUOTA_FILE = path.join(__dirname, 'data', 'quota.json');

function loadQuota() {
  try {
    const fs = require('fs');
    if (fs.existsSync(QUOTA_FILE)) {
      return JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8'));
    }
  } catch(e) {}
  return {
    gemini: { used: 0, limit: 1500, resetDate: new Date().toISOString().slice(0, 7) },
    claude: { used: 0, limit: 500, resetDate: new Date().toISOString().slice(0, 7) },
    cloudRun: { used: 0, limit: 2000000, resetDate: new Date().toISOString().slice(0, 7) },
    warnings: { gemini80: false, claude80: false, gemini100: false, claude100: false }
  };
}

function saveQuota() {
  try {
    const fs = require('fs');
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(QUOTA_FILE, JSON.stringify(quotaTracker, null, 2));
  } catch(e) {
    console.error('Kota kaydetme hatası:', e.message);
  }
}

const quotaTracker = loadQuota();

// Ay degisince kotayi sifirla
function checkQuotaReset() {
  const currentMonth = new Date().toISOString().slice(0, 7);
  ['gemini', 'claude', 'cloudRun'].forEach(service => {
    if (quotaTracker[service].resetDate !== currentMonth) {
      quotaTracker[service].used = 0;
      quotaTracker[service].resetDate = currentMonth;
    }
  });
  quotaTracker.warnings = { gemini80: false, claude80: false, gemini100: false, claude100: false };
}

// Kota kullanimi kaydet ve uyar
async function trackUsage(service) {
  checkQuotaReset();
  if (!quotaTracker[service]) return;
  quotaTracker[service].used++;
  saveQuota();

  const q = quotaTracker[service];
  const percent = (q.used / q.limit) * 100;

  // %80 uyarisi
  if (percent >= 80 && percent < 100 && !quotaTracker.warnings[`${service}80`]) {
    quotaTracker.warnings[`${service}80`] = true;
    await sendQuotaAlert(service, percent, q.used, q.limit);
  }
  // %100 uyarisi
  if (percent >= 100 && !quotaTracker.warnings[`${service}100`]) {
    quotaTracker.warnings[`${service}100`] = true;
    await sendQuotaAlert(service, percent, q.used, q.limit);
  }
}

async function sendQuotaAlert(service, percent, used, limit) {
  const serviceNames = { gemini: 'Gemini API', claude: 'Claude API', cloudRun: 'Cloud Run' };
  const status = percent >= 100 ? 'LIMIT DOLDU!' : 'Limite yaklasiliyor!';
  console.log(`Kota uyarisi: ${serviceNames[service]} - ${status} - ${used}/${limit} (%${Math.round(percent)})`);
}

// Kota bilgisini disari ac (dashboard icin)
global.quotaTracker = quotaTracker;
global.trackUsage = trackUsage;

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`PhotoReel Dashboard: http://localhost:${PORT}`);
  console.log(`PhotoReel App: http://localhost:${PORT}/app`);
});
