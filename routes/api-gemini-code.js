/**
 * Fenix AI — Gemini Kod Asistanı API
 * Tablet'ten dosya okuma, arama, düzenleme, komut çalıştırma
 */

const express = require('express');
const router = express.Router();
const codeAssistant = require('../services/code-assistant');
const logger = require('../utils/logger');

// ═══ FAZ 1: READ-ONLY ENDPOINTS ═══

// Dosya oku
router.get('/file', async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ ok: false, error: 'path parametresi gerekli' });
    const result = await codeAssistant.readFile(filePath);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Dosya listele
router.get('/files', async (req, res) => {
  try {
    const result = await codeAssistant.listFiles(req.query.dir || '.', req.query.glob);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Kod arama
router.get('/search', async (req, res) => {
  try {
    const pattern = req.query.pattern;
    if (!pattern) return res.status(400).json({ ok: false, error: 'pattern parametresi gerekli' });
    const result = await codeAssistant.searchCode(pattern, req.query.glob);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Proje yapısı
router.get('/structure', async (req, res) => {
  try {
    const tree = await codeAssistant.getProjectStructure();
    res.json({ ok: true, tree });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ═══ FAZ 2: DÜZENLEME (ONAYLI) ═══

router.post('/edit', async (req, res) => {
  try {
    const { path: filePath, edits } = req.body;
    if (!filePath || !edits) return res.status(400).json({ ok: false, error: 'path ve edits gerekli' });

    // Onay gerekli mi kontrol et
    if (req.body.approved !== true) {
      // Önce diff oluştur, onay iste
      const file = await codeAssistant.readFile(filePath);
      return res.json({
        ok: true,
        needsApproval: true,
        file: filePath,
        currentLines: file.lines,
        edits,
        message: 'Bu düzenleme onay gerektiriyor. approved: true ile tekrar gönderin.'
      });
    }

    const result = await codeAssistant.editFile(filePath, edits);
    logger.info('Dosya düzenlendi', { path: filePath, edits: edits.length, backup: result.backup });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Dosya oluştur
router.post('/create', async (req, res) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath || content === undefined) return res.status(400).json({ ok: false, error: 'path ve content gerekli' });

    if (req.body.approved !== true) {
      return res.json({
        ok: true,
        needsApproval: true,
        file: filePath,
        contentLength: content.length,
        message: 'Dosya oluşturma onay gerektiriyor.'
      });
    }

    const result = await codeAssistant.createFile(filePath, content);
    logger.info('Dosya oluşturuldu', { path: filePath, size: result.size });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ═══ FAZ 3: KOMUT ÇALIŞTIRMA (ONAYLI) ═══

router.post('/exec', async (req, res) => {
  try {
    const { command, cwd } = req.body;
    if (!command) return res.status(400).json({ ok: false, error: 'command gerekli' });

    if (req.body.approved !== true) {
      return res.json({
        ok: true,
        needsApproval: true,
        command,
        cwd: cwd || '.',
        message: 'Komut çalıştırma onay gerektiriyor.'
      });
    }

    const result = await codeAssistant.executeCommand(command, cwd);
    logger.info('Komut çalıştırıldı', { command, exitCode: result.exitCode });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

module.exports = router;
