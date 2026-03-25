const express = require('express');
const router = express.Router();
const { validate, schemas } = require('../middlewares/validate');
const stateService = require('../services/state-service');
const logger = require('../utils/logger');

// Onay isteği gönder
router.post('/request', validate(schemas.approvalRequest), async (req, res) => {
  const { title, description, type } = req.body;
  const approval = {
    id: Date.now().toString(),
    title: title || 'Onay Gerekli',
    description: description || '',
    type: type || 'general',
    timestamp: new Date().toISOString(),
    status: 'pending'
  };
  await stateService.pushApproval(approval);

  if (global.io) {
    global.io.emit('approval_request', approval);
  }

  logger.info('Onay isteği', { title, id: approval.id });
  res.json({ ok: true, approvalId: approval.id });
});

// Bekleyen onayları getir
router.get('/pending', async (req, res) => {
  const approvals = await stateService.getPendingApprovals();
  res.json({ approvals });
});

// Onay ver veya reddet
router.post('/respond/:id', validate(schemas.approvalResponse), async (req, res) => {
  const { id } = req.params;
  const { decision } = req.body;

  const approval = await stateService.respondApproval(id, decision);
  if (!approval) return res.json({ ok: false, error: 'Onay bulunamadı' });

  if (global.io) {
    global.io.emit('approval_response', approval);
  }

  logger.info('Onay yanıtlandı', { id, decision });
  res.json({ ok: true, approval });
});

// Onay durumunu kontrol et
router.get('/result/:id', async (req, res) => {
  const approval = await stateService.getApprovalById(req.params.id);
  if (!approval) return res.json({ status: 'not_found' });
  res.json({ status: approval.status, approval });
});

module.exports = router;
