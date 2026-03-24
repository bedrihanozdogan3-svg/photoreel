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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`PhotoReel Dashboard: http://localhost:${PORT}`);
  console.log(`PhotoReel App: http://localhost:${PORT}/app`);
});
