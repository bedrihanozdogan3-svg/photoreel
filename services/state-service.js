/**
 * Fenix AI — Merkezi State Yönetimi
 * Bellekte tutulan tüm state'i Firestore'a taşır.
 * Cloud Run uyumlu: restart'ta veri kaybolmaz, çoklu instance tutarlı.
 *
 * Fallback: Firestore erişilemezse bellek kullanır (graceful degradation).
 */

const logger = require('../utils/logger');
const config = require('../config');

let db = null;
let firestoreAvailable = false;
let firestoreFailed = false; // Bir kez başarısız olursa tekrar deneme

// Firestore lazy init — başarısız olursa bir daha deneme (restart'a kadar)
function getDb() {
  if (db) return db;
  if (firestoreFailed) return null; // Zaten başarısız — spam engelle
  try {
    const { Firestore } = require('@google-cloud/firestore');
    db = new Firestore({ projectId: config.firestoreProjectId });
    // Bağlantı testi (senkron değil, ilk çağrıda anlaşılacak)
    firestoreAvailable = true;
    return db;
  } catch (e) {
    logger.warn('Firestore bağlanamadı, bellek fallback aktif', { error: e.message });
    firestoreAvailable = false;
    firestoreFailed = true;
    return null;
  }
}

// Firestore ilk hatada kalıcı olarak devre dışı kal (local dev için)
function markFirestoreFailed() {
  if (!firestoreFailed) {
    firestoreFailed = true;
    firestoreAvailable = false;
    db = null;
    logger.warn('Firestore kalıcı olarak devre dışı — bellek modu aktif');
  }
}

// === BELLEK FALLBACK ===
const memoryFallback = {
  agents: {},
  commandQueues: {},
  commandResults: {},
  approvals: [],
  approvalResults: [],
  quota: null,
  terminalBuffer: []
};

// === AGENT STATE ===

async function getAgentState(agentId) {
  const firestore = getDb();
  if (firestore) {
    try {
      const doc = await firestore.collection('agent-state').doc(agentId).get();
      return doc.exists ? doc.data() : { offline: true };
    } catch (e) {
      if (e.message.includes('credentials')) { markFirestoreFailed(); } else logger.error('Agent state okuma hatası', { agentId, error: e.message });
    }
  }
  return memoryFallback.agents[agentId] || { offline: true };
}

async function setAgentState(agentId, data) {
  memoryFallback.agents[agentId] = { ...data, lastSeen: new Date().toISOString() };
  const firestore = getDb();
  if (firestore) {
    try {
      await firestore.collection('agent-state').doc(agentId).set(memoryFallback.agents[agentId]);
    } catch (e) {
      if (e.message.includes('credentials')) { markFirestoreFailed(); } else logger.error('Agent state yazma hatası', { agentId, error: e.message });
    }
  }
}

async function getAllAgentStates() {
  const firestore = getDb();
  if (firestore) {
    try {
      const snap = await firestore.collection('agent-state').get();
      const states = {};
      snap.docs.forEach(doc => { states[doc.id] = doc.data(); });
      return states;
    } catch (e) {
      if (e.message.includes('credentials')) { markFirestoreFailed(); } else logger.error('Agent states okuma hatası', { error: e.message });
    }
  }
  return memoryFallback.agents;
}

// === COMMAND QUEUE ===

async function pushCommand(agentId, command) {
  if (!memoryFallback.commandQueues[agentId]) memoryFallback.commandQueues[agentId] = [];
  memoryFallback.commandQueues[agentId].push(command);

  const firestore = getDb();
  if (firestore) {
    try {
      await firestore.collection('agent-commands').add({
        agentId,
        ...command,
        processed: false,
        createdAt: new Date().toISOString()
      });
    } catch (e) {
      if (e.message.includes('credentials')) { markFirestoreFailed(); } else logger.error('Komut kaydetme hatası', { agentId, error: e.message });
    }
  }
}

async function getAndClearCommands(agentId) {
  const firestore = getDb();
  if (firestore) {
    try {
      const snap = await firestore.collection('agent-commands')
        .where('agentId', '==', agentId)
        .where('processed', '==', false)
        .limit(20)
        .get();

      if (snap.empty) return [];

      const batch = firestore.batch();
      const commands = [];
      snap.docs.forEach(doc => {
        commands.push({ id: doc.id, ...doc.data() });
        batch.update(doc.ref, { processed: true });
      });
      await batch.commit();
      return commands;
    } catch (e) {
      if (e.message.includes('credentials')) { markFirestoreFailed(); } else logger.error('Komut okuma hatası', { agentId, error: e.message });
    }
  }
  // Fallback: bellekten al ve temizle
  const cmds = memoryFallback.commandQueues[agentId] || [];
  memoryFallback.commandQueues[agentId] = [];
  return cmds;
}

// === COMMAND RESULTS ===

async function pushCommandResult(agentId, result) {
  if (!memoryFallback.commandResults[agentId]) memoryFallback.commandResults[agentId] = [];
  memoryFallback.commandResults[agentId].push({ ...result, timestamp: new Date().toISOString() });
  if (memoryFallback.commandResults[agentId].length > 50) {
    memoryFallback.commandResults[agentId] = memoryFallback.commandResults[agentId].slice(-50);
  }

  const firestore = getDb();
  if (firestore) {
    try {
      await firestore.collection('agent-results').add({
        agentId, ...result, timestamp: new Date().toISOString()
      });
    } catch (e) {
      if (e.message.includes('credentials')) { markFirestoreFailed(); } else logger.error('Komut sonucu kaydetme hatası', { error: e.message });
    }
  }
}

async function getCommandResults(agentId) {
  const firestore = getDb();
  if (firestore) {
    try {
      const snap = await firestore.collection('agent-results')
        .where('agentId', '==', agentId)
        .orderBy('timestamp', 'desc')
        .limit(50)
        .get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      if (e.message.includes('credentials')) { markFirestoreFailed(); } else logger.error('Komut sonuçları okuma hatası', { error: e.message });
    }
  }
  return memoryFallback.commandResults[agentId] || [];
}

// === APPROVAL STATE ===

async function pushApproval(approval) {
  memoryFallback.approvals.push(approval);
  const firestore = getDb();
  if (firestore) {
    try {
      await firestore.collection('approvals').doc(approval.id).set(approval);
    } catch (e) {
      if (e.message.includes('credentials')) { markFirestoreFailed(); } else logger.error('Onay kaydetme hatası', { error: e.message });
    }
  }
}

async function getPendingApprovals() {
  const firestore = getDb();
  if (firestore) {
    try {
      const snap = await firestore.collection('approvals')
        .where('status', '==', 'pending')
        .orderBy('timestamp', 'desc')
        .limit(20)
        .get();
      return snap.docs.map(d => d.data());
    } catch (e) {
      if (e.message.includes('credentials')) markFirestoreFailed();
      else if (e.message.includes('credentials')) { markFirestoreFailed(); } else logger.error('Bekleyen onaylar okuma hatası', { error: e.message });
    }
  }
  return memoryFallback.approvals.filter(a => a.status === 'pending');
}

async function respondApproval(id, decision) {
  // Bellekte güncelle
  const approval = memoryFallback.approvals.find(a => a.id === id);
  if (approval) {
    approval.status = decision;
    approval.respondedAt = new Date().toISOString();
  }

  const firestore = getDb();
  if (firestore) {
    try {
      await firestore.collection('approvals').doc(id).update({
        status: decision,
        respondedAt: new Date().toISOString()
      });
      const doc = await firestore.collection('approvals').doc(id).get();
      return doc.exists ? doc.data() : approval;
    } catch (e) {
      if (e.message.includes('credentials')) { markFirestoreFailed(); } else logger.error('Onay yanıtlama hatası', { id, error: e.message });
    }
  }
  return approval;
}

async function getApprovalById(id) {
  const firestore = getDb();
  if (firestore) {
    try {
      const doc = await firestore.collection('approvals').doc(id).get();
      if (doc.exists) return doc.data();
    } catch (e) {
      if (e.message.includes('credentials')) { markFirestoreFailed(); } else logger.error('Onay okuma hatası', { id, error: e.message });
    }
  }
  return memoryFallback.approvals.find(a => a.id === id);
}

// === QUOTA STATE ===

async function getQuota() {
  const firestore = getDb();
  if (firestore) {
    try {
      const doc = await firestore.collection('system').doc('quota').get();
      if (doc.exists) return doc.data();
    } catch (e) {
      if (e.message.includes('credentials')) { markFirestoreFailed(); } else logger.error('Kota okuma hatası', { error: e.message });
    }
  }
  return null;
}

async function saveQuota(quotaData) {
  const firestore = getDb();
  if (firestore) {
    try {
      await firestore.collection('system').doc('quota').set(quotaData);
    } catch (e) {
      if (e.message.includes('credentials')) { markFirestoreFailed(); } else logger.error('Kota kaydetme hatası', { error: e.message });
    }
  }
}

// === FEEDBACK (Beğeni/Beğenmeme — Fenix öğrenme döngüsü) ===

async function saveFeedback(feedback) {
  const entry = {
    ...feedback,
    timestamp: new Date().toISOString()
  };
  const firestore = getDb();
  if (firestore) {
    try {
      await firestore.collection('feedback').add(entry);
      return true;
    } catch (e) {
      if (e.message.includes('credentials')) { markFirestoreFailed(); } else logger.error('Feedback kaydetme hatası', { error: e.message });
    }
  }
  return false;
}

async function getFeedbackHistory(userId, limit = 50) {
  const firestore = getDb();
  if (firestore) {
    try {
      let query = firestore.collection('feedback')
        .orderBy('timestamp', 'desc')
        .limit(limit);
      if (userId) query = query.where('userId', '==', userId);
      const snap = await query.get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      if (e.message.includes('credentials')) { markFirestoreFailed(); } else logger.error('Feedback okuma hatası', { error: e.message });
    }
  }
  return [];
}

async function getFeedbackStats() {
  const firestore = getDb();
  if (firestore) {
    try {
      const snap = await firestore.collection('feedback').get();
      const stats = { total: 0, liked: 0, disliked: 0, categories: {} };
      snap.docs.forEach(doc => {
        const d = doc.data();
        stats.total++;
        if (d.rating === 'like') stats.liked++;
        else if (d.rating === 'dislike') stats.disliked++;
        if (d.category) {
          if (!stats.categories[d.category]) stats.categories[d.category] = { liked: 0, disliked: 0 };
          if (d.rating === 'like') stats.categories[d.category].liked++;
          else stats.categories[d.category].disliked++;
        }
      });
      return stats;
    } catch (e) {
      if (e.message.includes('credentials')) { markFirestoreFailed(); } else logger.error('Feedback istatistik hatası', { error: e.message });
    }
  }
  return { total: 0, liked: 0, disliked: 0, categories: {} };
}

module.exports = {
  // Agent
  getAgentState, setAgentState, getAllAgentStates,
  // Commands
  pushCommand, getAndClearCommands,
  pushCommandResult, getCommandResults,
  // Approvals
  pushApproval, getPendingApprovals, respondApproval, getApprovalById,
  // Quota
  getQuota, saveQuota,
  // Feedback
  saveFeedback, getFeedbackHistory, getFeedbackStats,
  // Meta
  isFirestoreAvailable: () => firestoreAvailable
};
