const express = require('express');
const ConversationManager = require('../services/conversation-manager');
const { validate, schemas } = require('../middlewares/validate');
const { promptInjectionGuard, auditLog } = require('../middlewares/security');

module.exports = function(io) {
  const router = express.Router();
  const manager = new ConversationManager(io);

  // Prompt injection sadece loglama (engelleme değil — kullanıcı deneyimi öncelikli)
  router.use(function(req, res, next) {
    var text = req.body && (req.body.text || req.body.topic) || '';
    var { detectPromptInjection } = require('../middlewares/security');
    if (detectPromptInjection(text)) {
      require('../utils/logger').warn('Prompt injection şüphesi (chat)', { text: text.substring(0,50) });
    }
    next();
  });

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

  // Gemini Kod Asistanı — function calling ile dosya erişimi
  router.post('/gemini-code', validate(schemas.sendMessage), auditLog('chat:gemini-code'), async (req, res) => {
    try {
      const { text, context } = req.body;
      const geminiService = require('../services/gemini-service');
      const history = manager.getHistory().slice(-8);

      // Fenix Bug Hafızası — bilinen bugları prompt'a enjekte et
      let enrichedText = text;
      try {
        const fenixBrain = require('../services/fenix-brain');
        const grouped = await fenixBrain.getLessonsByCategory();
        const categories = Object.keys(grouped);
        if (categories.length > 0) {
          const memLines = ['📚 Fenix Bug Hafızası (bilinen sorunlar ve çözümleri):'];
          categories.forEach(cat => {
            memLines.push(`[${cat}]`);
            grouped[cat].slice(0, 3).forEach(l => memLines.push('  ' + l));
          });
          memLines.push('---');
          enrichedText = memLines.join('\n') + '\n\n' + text;
        }
      } catch(e) { /* hafıza yoksa devam */ }

      const result = await geminiService.sendMessageWithTools(history, enrichedText, 'chat');
      res.json({ ok: true, ...result });
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
