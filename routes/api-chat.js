const express = require('express');
const ConversationManager = require('../services/conversation-manager');

module.exports = function(io) {
  const router = express.Router();
  const manager = new ConversationManager(io);

  // Otomatik konuşma başlat
  router.post('/start', (req, res) => {
    const { topic, maxTurns } = req.body;
    if (!topic) return res.status(400).json({ error: 'Konu gerekli' });
    manager.start(topic, maxTurns || 20);
    res.json({ ok: true, message: 'Konuşma başlatıldı' });
  });

  // Durdur
  router.post('/stop', (req, res) => {
    manager.stop();
    res.json({ ok: true, message: 'Durduruldu' });
  });

  // Duraklat
  router.post('/pause', (req, res) => {
    manager.pause();
    res.json({ ok: true });
  });

  // Devam et
  router.post('/resume', (req, res) => {
    manager.resume();
    res.json({ ok: true });
  });

  // Kullanıcı mesajı gönder
  router.post('/inject', (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Mesaj gerekli' });
    manager.injectMessage(text);
    res.json({ ok: true });
  });

  // Gemini'ye tek mesaj
  router.post('/gemini', async (req, res) => {
    try {
      const { text } = req.body;
      const response = await manager.sendToGemini(text);
      res.json({ ok: true, response });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Claude'a tek mesaj
  router.post('/claude', async (req, res) => {
    try {
      const { text } = req.body;
      const response = await manager.sendToClaude(text);
      res.json({ ok: true, response });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Durum
  router.get('/status', (req, res) => {
    res.json(manager.getState());
  });

  // Geçmiş
  router.get('/history', (req, res) => {
    res.json(manager.getHistory());
  });

  return router;
};
