const express = require('express');
const router = express.Router();

// Agent durumu ve komut kuyruğu (bellekte)
const agentState = {};
const commandQueues = {};
const commandResults = {};

// Agent rapor al
router.post('/report', (req, res) => {
  const data = req.body;
  const agentId = data.agentId;
  if (!agentId) return res.json({ ok: false });

  // Komut sonucu mu?
  if (data.commandResult) {
    if (!commandResults[agentId]) commandResults[agentId] = [];
    commandResults[agentId].push({ ...data.commandResult, timestamp: new Date().toISOString() });
    // Max 50 sonuç tut
    if (commandResults[agentId].length > 50) commandResults[agentId] = commandResults[agentId].slice(-50);
    return res.json({ ok: true });
  }

  // Sistem raporu
  agentState[agentId] = { ...data, lastSeen: new Date().toISOString() };

  // Socket.io ile dashboard'a bildir
  if (global.io) {
    global.io.emit('agent_update', agentState[agentId]);
  }

  res.json({ ok: true });
});

// Agent durumunu getir
router.get('/status/:agentId?', (req, res) => {
  const agentId = req.params.agentId;
  if (agentId) {
    res.json(agentState[agentId] || { offline: true });
  } else {
    res.json(agentState);
  }
});

// Agent'a komut gönder
router.post('/command/:agentId', (req, res) => {
  const agentId = req.params.agentId;
  const { type, data } = req.body;

  if (!commandQueues[agentId]) commandQueues[agentId] = [];
  const cmd = { id: Date.now().toString(), type, data, timestamp: new Date().toISOString() };
  commandQueues[agentId].push(cmd);

  if (global.io) {
    global.io.emit('agent_command_sent', { agentId, command: cmd });
  }

  res.json({ ok: true, commandId: cmd.id });
});

// Agent bekleyen komutları al (agent tarafından çağrılır)
router.get('/commands/:agentId', (req, res) => {
  const agentId = req.params.agentId;
  const commands = commandQueues[agentId] || [];
  commandQueues[agentId] = []; // temizle
  res.json({ commands });
});

// Komut sonuçlarını getir
router.get('/results/:agentId', (req, res) => {
  const agentId = req.params.agentId;
  const results = commandResults[agentId] || [];
  res.json({ results });
});

// Komut sonuçlarını temizle
router.delete('/results/:agentId', (req, res) => {
  const agentId = req.params.agentId;
  commandResults[agentId] = [];
  res.json({ ok: true });
});

module.exports = router;
