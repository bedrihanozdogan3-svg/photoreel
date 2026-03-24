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

// WhatsApp Sandbox otomatik hatirlatma (48 saatte bir)
const SANDBOX_REMINDER_INTERVAL = 48 * 60 * 60 * 1000; // 48 saat
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
}, 60 * 60 * 1000); // Her saat kontrol et

// WhatsApp baglanti testi (her 6 saatte)
setInterval(async () => {
  try {
    const twilio = require('twilio');
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    // Hesap durumunu kontrol et
    const account = await client.api.accounts(process.env.TWILIO_ACCOUNT_SID).fetch();
    console.log(`WhatsApp durum kontrolu: ${account.status} - Bakiye: $${account.balance || 'N/A'}`);
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
