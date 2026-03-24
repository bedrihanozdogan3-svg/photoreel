/**
 * Terminal Stream — Bilgisayardaki değişiklikleri tablete canlı gönderir
 * Git log, dosya değişiklikleri, sistem olayları
 */
const fs = require('fs');
const path = require('path');

const CLOUD_URL = 'https://photoreel-194617495310.europe-west1.run.app';
const REPO_PATH = 'C:/Users/ASUS/Desktop/photoreel-repo';
const WATCH_PATHS = [
  'C:/Users/ASUS/Desktop/photoreel-repo',
  'C:/Users/ASUS/Desktop/muhasebe'
];
const INTERVAL = 3000;

let lastGitLog = '';
let lastFiles = {};

async function send(text) {
  try {
    await fetch(CLOUD_URL + '/api/terminal/output', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
  } catch(e) {}
}

// Git log değişikliklerini takip et
async function checkGitLog() {
  try {
    const { execSync } = require('child_process');
    const log = execSync('git log --oneline -5', { cwd: REPO_PATH, encoding: 'utf8', windowsHide: true });
    if (log !== lastGitLog && lastGitLog !== '') {
      const newLines = log.split('\n').filter(l => !lastGitLog.includes(l) && l.trim());
      for (const line of newLines) {
        await send('📝 ' + line);
      }
    }
    lastGitLog = log;
  } catch(e) {}
}

// Dosya değişikliklerini takip et
async function checkFileChanges() {
  try {
    const { execSync } = require('child_process');
    const status = execSync('git status --short', { cwd: REPO_PATH, encoding: 'utf8', windowsHide: true });
    if (status.trim()) {
      const lines = status.trim().split('\n');
      for (const line of lines) {
        const key = line.trim();
        if (!lastFiles[key]) {
          lastFiles[key] = true;
          await send('📄 ' + key);
        }
      }
    } else {
      lastFiles = {};
    }
  } catch(e) {}
}

// Başlangıç mesajı
async function init() {
  await send('🟢 Terminal Stream başlatıldı');
  await send('📡 Bilgisayar: ' + require('os').hostname());
  await send('⏰ ' + new Date().toLocaleString('tr-TR'));
  await send('---');

  // İlk git log
  try {
    const { execSync } = require('child_process');
    const log = execSync('git log --oneline -3', { cwd: REPO_PATH, encoding: 'utf8', windowsHide: true });
    await send('Son commitler:');
    for (const line of log.trim().split('\n')) {
      await send('  ' + line);
    }
    await send('---');
    lastGitLog = log;
  } catch(e) {}
}

// Dosya içerik değişikliklerini izle
let watchedFiles = {};
async function checkFileContents() {
  const files = ['public/kontrol.html', 'server.js', 'services/gemini-service.js', 'services/claude-service.js', 'routes/api-whatsapp.js'];
  for (const file of files) {
    try {
      const fullPath = path.join(REPO_PATH, file);
      const stat = fs.statSync(fullPath);
      const mtime = stat.mtimeMs;
      if (watchedFiles[file] && watchedFiles[file] !== mtime) {
        const size = Math.round(stat.size / 1024);
        await send('✏️ Dosya değişti: ' + file + ' (' + size + 'KB)');
      }
      watchedFiles[file] = mtime;
    } catch(e) {}
  }
}

// Ana döngü
async function run() {
  await init();
  setInterval(async () => {
    await checkGitLog();
    await checkFileChanges();
    await checkFileContents();
  }, INTERVAL);
}

run();
console.log('Terminal Stream başlatıldı — tablet\'e canlı gönderim aktif');
