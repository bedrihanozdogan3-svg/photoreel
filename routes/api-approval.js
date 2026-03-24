const express = require('express');
const router = express.Router();

// Onay kuyruğu
const pendingApprovals = [];
const approvalResults = [];

// Onay isteği gönder (Claude bu endpoint'i çağırır)
router.post('/request', (req, res) => {
  const { title, description, type } = req.body;
  const approval = {
    id: Date.now().toString(),
    title: title || 'Onay Gerekli',
    description: description || '',
    type: type || 'general',
    timestamp: new Date().toISOString(),
    status: 'pending'
  };
  pendingApprovals.push(approval);

  // Socket ile tablete bildir
  if (global.io) {
    global.io.emit('approval_request', approval);
  }

  console.log(`\n🔔 ONAY İSTEĞİ: ${title}\n   ${description}\n`);
  res.json({ ok: true, approvalId: approval.id });
});

// Bekleyen onayları getir (tablet poll eder)
router.get('/pending', (req, res) => {
  const pending = pendingApprovals.filter(a => a.status === 'pending');
  res.json({ approvals: pending });
});

// Onay ver veya reddet (tabletten gelir)
router.post('/respond/:id', (req, res) => {
  const { id } = req.params;
  const { decision } = req.body; // 'approved' veya 'rejected'

  const approval = pendingApprovals.find(a => a.id === id);
  if (!approval) return res.json({ ok: false, error: 'Onay bulunamadı' });

  approval.status = decision;
  approval.respondedAt = new Date().toISOString();

  approvalResults.push(approval);

  if (global.io) {
    global.io.emit('approval_response', approval);
  }

  console.log(`\n${decision === 'approved' ? '✅' : '❌'} ONAY SONUCU: ${approval.title} → ${decision}\n`);
  res.json({ ok: true, approval });
});

// Son onay sonucunu kontrol et (Claude poll eder)
router.get('/result/:id', (req, res) => {
  const approval = pendingApprovals.find(a => a.id === req.params.id);
  if (!approval) return res.json({ status: 'not_found' });
  res.json({ status: approval.status, approval });
});

module.exports = router;
