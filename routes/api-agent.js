const express = require('express');
const router = express.Router();
const { validate, schemas } = require('../middlewares/validate');
const stateService = require('../services/state-service');
const logger = require('../utils/logger');

// Agent rapor al
router.post('/report', async (req, res) => {
  const data = req.body;
  const agentId = data.agentId;
  if (!agentId) return res.json({ ok: false });

  // Komut sonucu mu?
  if (data.commandResult) {
    await stateService.pushCommandResult(agentId, data.commandResult);
    return res.json({ ok: true });
  }

  // Sistem raporu
  await stateService.setAgentState(agentId, data);

  if (global.io) {
    global.io.emit('agent_update', { ...data, lastSeen: new Date().toISOString() });
  }

  res.json({ ok: true });
});

// Agent durumunu getir
router.get('/status/:agentId?', async (req, res) => {
  const agentId = req.params.agentId;
  if (agentId) {
    res.json(await stateService.getAgentState(agentId));
  } else {
    res.json(await stateService.getAllAgentStates());
  }
});

// Agent'a komut gönder
router.post('/command/:agentId', validate(schemas.agentCommand), async (req, res) => {
  const agentId = req.params.agentId;
  const { type, data } = req.body;

  const cmd = { id: Date.now().toString(), type, data, timestamp: new Date().toISOString() };
  await stateService.pushCommand(agentId, cmd);

  if (global.io) {
    global.io.emit('agent_command_sent', { agentId, command: cmd });
  }

  res.json({ ok: true, commandId: cmd.id });
});

// Agent bekleyen komutları al
router.get('/commands/:agentId', async (req, res) => {
  const commands = await stateService.getAndClearCommands(req.params.agentId);
  res.json({ commands });
});

// Komut sonuçlarını getir
router.get('/results/:agentId', async (req, res) => {
  const results = await stateService.getCommandResults(req.params.agentId);
  res.json({ results });
});

module.exports = router;
