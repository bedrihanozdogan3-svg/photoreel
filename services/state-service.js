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

// Firestore lazy init
function getDb() {
  if (db) return db;
  try {
    const { Firestore } = require('@google-cloud/firestore');
    db = new Firestore({ projectId: config.firestoreProjectId });
    firestoreAvailable = true;
    return db;
  } catch (e) {
    logger.warn('Firestore bağlanamadı, bellek fallback aktif', { error: e.message });
    firestoreAvailable = false;
    return null;
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
      logger.error('Agent state okuma hatası', { agentId, error: e.message });
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
      logger.error('Agent state yazma hatası', { agentId, error: e.message });
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
      logger.error('Agent states okuma hatası', { error: e.message });
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
      logger.error('Komut kaydetme hatası', { agentId, error: e.message });
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
      logger.error('Komut okuma hatası', { agentId, error: e.message });
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
      logger.error('Komut sonucu kaydetme hatası', { error: e.message });
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
      logger.error('Komut sonuçları okuma hatası', { error: e.message });
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
      logger.error('Onay kaydetme hatası', { error: e.message });
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
      logger.error('Bekleyen onaylar okuma hatası', { error: e.message });
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
      logger.error('Onay yanıtlama hatası', { id, error: e.message });
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
      logger.error('Onay okuma hatası', { id, error: e.message });
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
      logger.error('Kota okuma hatası', { error: e.message });
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
      logger.error('Kota kaydetme hatası', { error: e.message });
    }
  }
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
  // Meta
  isFirestoreAvailable: () => firestoreAvailable
};
