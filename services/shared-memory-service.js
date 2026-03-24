const fs = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, '..', 'data', 'shared-memory.md');

// Hafızayı oku
function readMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return fs.readFileSync(MEMORY_FILE, 'utf-8');
    }
  } catch (e) {
    console.error('Hafıza okuma hatası:', e.message);
  }
  return '';
}

// Kararlar bölümüne yeni karar ekle
function addDecision(text) {
  try {
    let content = readMemory();
    const date = new Date().toISOString().split('T')[0];
    const newLine = `- [${date}] ${text}`;
    content = content.replace(
      '## Konuşma Özeti',
      `${newLine}\n\n## Konuşma Özeti`
    );
    fs.writeFileSync(MEMORY_FILE, content, 'utf-8');
    console.log(`Hafızaya karar eklendi: ${text}`);
  } catch (e) {
    console.error('Hafıza yazma hatası:', e.message);
  }
}

// Konuşma özetine ekle
function addConversationNote(sender, summary) {
  try {
    let content = readMemory();
    const date = new Date().toISOString().split('T')[0];
    const time = new Date().toTimeString().split(' ')[0].substring(0, 5);
    const newLine = `- [${date} ${time}] **${sender}:** ${summary}`;

    // Konuşma Özeti bölümünün sonuna ekle
    if (content.includes('## Konuşma Özeti')) {
      content = content.replace('## Konuşma Özeti', `## Konuşma Özeti\n${newLine}`);
    } else {
      content += `\n\n## Konuşma Özeti\n${newLine}`;
    }

    // Max 30 konuşma notu tut
    const lines = content.split('\n');
    let noteCount = 0;
    const filtered = [];
    let inNotes = false;
    for (const line of lines) {
      if (line.startsWith('## Konuşma Özeti')) inNotes = true;
      if (inNotes && line.startsWith('- [')) {
        noteCount++;
        if (noteCount > 30) continue; // Eskileri at
      }
      filtered.push(line);
    }

    fs.writeFileSync(MEMORY_FILE, filtered.join('\n'), 'utf-8');
  } catch (e) {
    console.error('Konuşma notu yazma hatası:', e.message);
  }
}

// System prompt için hafıza özeti oluştur
function getSystemContext() {
  const memory = readMemory();
  if (!memory) return '';

  return `\n\n--- PAYLAŞIMLI HAFIZA (shared-memory.md) ---\n${memory}\n--- HAFIZA SONU ---\n\nBu hafızayı kullanarak kaldığın yerden devam et. Önceki konuşmaları ve kararları dikkate al.`;
}

// Mesajın önemli bir karar/bilgi içerip içermediğini kontrol et
function shouldSaveToMemory(text) {
  const keywords = [
    'karar', 'kararlaştır', 'değiştir', 'güncelle', 'ekle', 'kaldır', 'sil',
    'plan', 'strateji', 'hedef', 'öncelik', 'bug', 'hata', 'çöz', 'düzelt',
    'deploy', 'yayınla', 'versiyon', 'release', 'önemli', 'kritik',
    'decision', 'change', 'update', 'add', 'remove', 'fix', 'deploy', 'important'
  ];
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

module.exports = {
  readMemory,
  addDecision,
  addConversationNote,
  getSystemContext,
  shouldSaveToMemory
};
