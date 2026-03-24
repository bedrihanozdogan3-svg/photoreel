require('dotenv').config();
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
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

// WhatsApp webhook
const whatsappRoutes = require('./routes/api-whatsapp');
app.use('/webhook/whatsapp', whatsappRoutes(io));

// Health check (Cloud Run için)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Socket.io connection
io.on('connection', (socket) => {
  console.log('Dashboard bağlandı:', socket.id);
  socket.emit('status', { state: 'idle', message: 'Bağlantı kuruldu' });

  socket.on('disconnect', () => {
    console.log('Dashboard ayrıldı:', socket.id);
  });
});

// === KOTA & MALIYET TAKIP SISTEMI ===
const quotaTracker = {
  gemini: { used: 0, limit: 1500, resetDate: new Date().toISOString().slice(0, 7) },  // aylik
  claude: { used: 0, limit: 500, resetDate: new Date().toISOString().slice(0, 7) },
  twilio: { used: 0, limit: 200, resetDate: new Date().toISOString().slice(0, 7) },
  cloudRun: { used: 0, limit: 2000000, resetDate: new Date().toISOString().slice(0, 7) },
  warnings: { gemini80: false, claude80: false, twilio80: false, gemini100: false, claude100: false, twilio100: false }
};

// Ay degisince kotayi sifirla
function checkQuotaReset() {
  const currentMonth = new Date().toISOString().slice(0, 7);
  ['gemini', 'claude', 'twilio', 'cloudRun'].forEach(service => {
    if (quotaTracker[service].resetDate !== currentMonth) {
      quotaTracker[service].used = 0;
      quotaTracker[service].resetDate = currentMonth;
    }
  });
  quotaTracker.warnings = { gemini80: false, claude80: false, twilio80: false, gemini100: false, claude100: false, twilio100: false };
}

// Kota kullanimi kaydet ve uyar
async function trackUsage(service) {
  checkQuotaReset();
  if (!quotaTracker[service]) return;
  quotaTracker[service].used++;

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
  try {
    const twilio = require('twilio');
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const serviceNames = { gemini: 'Gemini API', claude: 'Claude API', twilio: 'Twilio WhatsApp', cloudRun: 'Cloud Run' };
    const icon = percent >= 100 ? '🔴' : '🟡';
    const status = percent >= 100 ? 'LIMIT DOLDU!' : 'Limite yaklasiliyor!';

    await client.messages.create({
      from: 'whatsapp:+14155238886',
      to: `whatsapp:+${process.env.ADMIN_PHONE || '905309070098'}`,
      body: `${icon} KOTA UYARISI: ${serviceNames[service]}\n\n` +
        `${status}\n` +
        `Kullanilan: ${used}/${limit} (%${Math.round(percent)})\n\n` +
        `Ucretsiz limitler:\n` +
        `• Gemini: ${quotaTracker.gemini.used}/${quotaTracker.gemini.limit}\n` +
        `• Claude: ${quotaTracker.claude.used}/${quotaTracker.claude.limit}\n` +
        `• Twilio: ${quotaTracker.twilio.used}/${quotaTracker.twilio.limit}\n\n` +
        `WhatsApp'tan /durum yazarak guncel durumu gorebilirsiniz.`
    });
    console.log(`Kota uyarisi gonderildi: ${service} %${Math.round(percent)}`);
  } catch(e) {
    console.log('Kota uyarisi gonderilemedi:', e.message);
  }
}

// Kota bilgisini disari ac (WhatsApp ve dashboard icin)
global.quotaTracker = quotaTracker;
global.trackUsage = trackUsage;

// WhatsApp Sandbox otomatik hatirlatma (48 saatte bir)
const SANDBOX_REMINDER_INTERVAL = 48 * 60 * 60 * 1000;
let lastSandboxReminder = Date.now();

setInterval(async () => {
  const now = Date.now();
  if (now - lastSandboxReminder >= SANDBOX_REMINDER_INTERVAL) {
    lastSandboxReminder = now;
    try {
      const twilio = require('twilio');
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await client.messages.create({
        from: 'whatsapp:+14155238886',
        to: `whatsapp:+${process.env.ADMIN_PHONE || '905309070098'}`,
        body: '⚠️ WhatsApp Sandbox suresi dolmak uzere!\n\nBaglantinin devam etmesi icin +1 415 523 8886 numarasina "join tea-student" yazin.\n\nBu otomatik bir hatirlatmadir.'
      });
      console.log('Sandbox hatirlatma mesaji gonderildi');
    } catch(e) {
      console.log('Sandbox hatirlatma gonderilemedi:', e.message);
    }
  }
}, 60 * 60 * 1000);

// WhatsApp baglanti ve bakiye testi (her 6 saatte)
setInterval(async () => {
  try {
    const twilio = require('twilio');
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const account = await client.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    const balance = parseFloat(account.balance || '0');
    console.log(`WhatsApp durum: ${account.status} - Bakiye: $${balance}`);

    // Bakiye $2'nin altindaysa uyar
    if (balance < 2) {
      await client.messages.create({
        from: 'whatsapp:+14155238886',
        to: `whatsapp:+${process.env.ADMIN_PHONE || '905309070098'}`,
        body: `🔴 Twilio bakiyeniz dusuk: $${balance}\n\nWhatsApp mesajlari durabilir. Twilio hesabiniza kredi yukleyin.\nconsole.twilio.com`
      });
    }
  } catch(e) {
    console.log('WhatsApp durum kontrolu basarisiz:', e.message);
  }
}, 6 * 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`PhotoReel Dashboard: http://localhost:${PORT}`);
  console.log(`PhotoReel App: http://localhost:${PORT}/app`);
  console.log('WhatsApp Sandbox hatirlatma: Aktif (48 saat aralik)');
  console.log('WhatsApp durum kontrolu: Aktif (6 saat aralik)');
});
