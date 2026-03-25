const express = require('express');
const ConversationManager = require('../services/conversation-manager');
const { validate, schemas } = require('../middlewares/validate');
const { promptInjectionGuard, auditLog } = require('../middlewares/security');

module.exports = function(io) {
  const router = express.Router();
  const manager = new ConversationManager(io);

  // Tüm mesaj endpoint'lerine prompt injection koruması
  router.use(promptInjectionGuard);

  // Otomatik konuşma başlat
  router.post('/start', validate(schemas.startConversation), auditLog('chat:start'), (req, res) => {
    const { topic, maxTurns } = req.body;
    manager.start(topic, maxTurns || 20);
    res.json({ ok: true, message: 'Konuşma başlatıldı' });
  });

  router.post('/stop', auditLog('chat:stop'), (req, res) => {
    manager.stop();
    res.json({ ok: true, message: 'Durduruldu' });
  });

  router.post('/pause', (req, res) => {
    manager.pause();
    res.json({ ok: true });
  });

  router.post('/resume', (req, res) => {
    manager.resume();
    res.json({ ok: true });
  });

  router.post('/inject', validate(schemas.sendMessage), auditLog('chat:inject'), (req, res) => {
    const { text } = req.body;
    manager.injectMessage(text);
    res.json({ ok: true });
  });

  router.post('/gemini', validate(schemas.sendMessage), auditLog('chat:gemini'), async (req, res) => {
    try {
      const { text } = req.body;
      const response = await manager.sendToGemini(text);
      res.json({ ok: true, response });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post('/claude', validate(schemas.sendMessage), auditLog('chat:claude'), async (req, res) => {
    try {
      const { text } = req.body;
      const response = await manager.sendToClaude(text);
      res.json({ ok: true, response });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.get('/status', (req, res) => {
    res.json(manager.getState());
  });

  router.get('/history', (req, res) => {
    res.json(manager.getHistory());
  });

  return router;
};
