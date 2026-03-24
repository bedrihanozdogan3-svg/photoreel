const { Firestore } = require('@google-cloud/firestore');

const db = new Firestore({
  projectId: 'photoreel-491017'
});

// Koleksiyonlar
const COLLECTIONS = {
  fikirler: 'fikirler',
  buglar: 'buglar',
  kararlar: 'kararlar',
  gorevler: 'gorevler',
  notlar: 'notlar',
  hafiza: 'hafiza'
};

// === EKLEME ===

async function addItem(collection, text, from = 'whatsapp') {
  const doc = {
    text,
    from,
    createdAt: Firestore.Timestamp.now(),
    date: new Date().toISOString().split('T')[0],
    time: new Date().toTimeString().split(' ')[0].substring(0, 5),
    status: 'aktif'
  };
  const ref = await db.collection(collection).add(doc);
  return ref.id;
}

async function addFikir(text, from) {
  return addItem(COLLECTIONS.fikirler, text, from);
}

async function addBug(text, from) {
  return addItem(COLLECTIONS.buglar, text, from);
}

async function addKarar(text, from) {
  return addItem(COLLECTIONS.kararlar, text, from);
}

async function addGorev(text, from) {
  return addItem(COLLECTIONS.gorevler, text, from);
}

async function addNot(text, from) {
  return addItem(COLLECTIONS.notlar, text, from);
}

// === LİSTELEME ===

async function getItems(collection, limit = 20, statusFilter = null) {
  let query = db.collection(collection).orderBy('createdAt', 'desc').limit(limit);
  if (statusFilter) {
    query = db.collection(collection).where('status', '==', statusFilter).orderBy('createdAt', 'desc').limit(limit);
  }
  const snapshot = await query.get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function getFikirler(limit = 20) {
  return getItems(COLLECTIONS.fikirler, limit);
}

async function getBuglar(limit = 20) {
  return getItems(COLLECTIONS.buglar, limit, 'aktif');
}

async function getKararlar(limit = 20) {
  return getItems(COLLECTIONS.kararlar, limit);
}

async function getGorevler(limit = 20) {
  return getItems(COLLECTIONS.gorevler, limit, 'aktif');
}

async function getNotlar(limit = 20) {
  return getItems(COLLECTIONS.notlar, limit);
}

// === DURUM GÜNCELLEME ===

async function updateStatus(collection, docId, status) {
  await db.collection(collection).doc(docId).update({ status });
}

async function closeBug(docId) {
  return updateStatus(COLLECTIONS.buglar, docId, 'çözüldü');
}

async function completeGorev(docId) {
  return updateStatus(COLLECTIONS.gorevler, docId, 'tamamlandı');
}

// === KONUŞMA HAFıZASI ===

async function saveConversation(sender, text, aiResponse) {
  await db.collection(COLLECTIONS.hafiza).add({
    sender,
    userText: text,
    aiResponse: aiResponse.substring(0, 500),
    createdAt: Firestore.Timestamp.now(),
    date: new Date().toISOString().split('T')[0]
  });
}

// === ÖZET İÇİN TÜM VERİ ===

async function getFullContext(limit = 10) {
  const [fikirler, buglar, kararlar, gorevler, notlar] = await Promise.all([
    getFikirler(limit),
    getBuglar(limit),
    getKararlar(limit),
    getGorevler(limit),
    getNotlar(limit)
  ]);

  let context = '## PhotoReel Beyin Merkezi\n\n';

  if (fikirler.length) {
    context += '### 💡 Son Fikirler\n';
    fikirler.forEach(f => { context += `- [${f.date}] ${f.text}\n`; });
    context += '\n';
  }

  if (buglar.length) {
    context += '### 🐛 Açık Buglar\n';
    buglar.forEach(b => { context += `- [${b.date}] ${b.text}\n`; });
    context += '\n';
  }

  if (kararlar.length) {
    context += '### ✅ Kararlar\n';
    kararlar.forEach(k => { context += `- [${k.date}] ${k.text}\n`; });
    context += '\n';
  }

  if (gorevler.length) {
    context += '### 📋 Açık Görevler\n';
    gorevler.forEach(g => { context += `- [${g.date}] ${g.text}\n`; });
    context += '\n';
  }

  if (notlar.length) {
    context += '### 📝 Notlar\n';
    notlar.forEach(n => { context += `- [${n.date}] ${n.text}\n`; });
    context += '\n';
  }

  return context;
}

// === SİSTEM PROMPT İÇİN BAĞLAM ===

async function getSystemContext() {
  try {
    const context = await getFullContext(10);
    if (!context || context === '## PhotoReel Beyin Merkezi\n\n') return '';
    return `\n\n--- PHOTOREEL BEYİN MERKEZİ (Firestore) ---\n${context}--- BEYİN MERKEZİ SONU ---\n\nBu verileri kullanarak Bedrihan'a yardım et. Fikirlerini, buglarını, kararlarını ve görevlerini bil.`;
  } catch (e) {
    console.error('Firestore context hatası:', e.message);
    return '';
  }
}

module.exports = {
  addFikir, addBug, addKarar, addGorev, addNot,
  getFikirler, getBuglar, getKararlar, getGorevler, getNotlar,
  closeBug, completeGorev,
  saveConversation, getFullContext, getSystemContext
};
