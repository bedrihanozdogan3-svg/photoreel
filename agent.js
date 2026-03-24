/**
 * PhotoReel Bilgisayar Agent'ı
 * Arka planda çalışır, sistem bilgilerini Cloud'a gönderir
 * Tabletten gelen komutları uygular
 */

const os = require('os');
const { execSync, exec } = require('child_process');
const https = require('https');
const http = require('http');

const CLOUD_URL = process.env.CLOUD_URL || 'https://photoreel-194617495310.europe-west1.run.app';
const LOCAL_URL = 'http://localhost:3000';
const AGENT_ID = 'bedrihan-pc';
const REPORT_INTERVAL = 10000; // 10 saniye

// === SİSTEM BİLGİLERİ ===

function getSystemInfo() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // CPU kullanımı (PowerShell - Windows 11 uyumlu)
  let cpuUsage = 0;
  try {
    const result = execSync('powershell -command "Get-CimInstance Win32_Processor | Select -Expand LoadPercentage"', { encoding: 'utf8', timeout: 8000 });
    const val = parseInt(result.trim());
    if (!isNaN(val)) cpuUsage = val;
  } catch(e) {
    // Fallback: os modülü ile hesapla
    const cpuStart = os.cpus().map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b) }));
    cpuUsage = Math.round(cpuStart.reduce((acc, c) => acc + (1 - c.idle / c.total), 0) / cpuStart.length * 100);
  }

  // Disk bilgisi (PowerShell - Windows 11 uyumlu)
  let diskInfo = { total: 0, free: 0, used: 0 };
  try {
    const result = execSync('powershell -command "Get-PSDrive C | Select-Object @{N=\'Used\';E={$_.Used}},@{N=\'Free\';E={$_.Free}} | ConvertTo-Json"', { encoding: 'utf8', timeout: 8000 });
    const data = JSON.parse(result.trim());
    const usedBytes = data.Used || 0;
    const freeBytes = data.Free || 0;
    diskInfo.total = Math.round((usedBytes + freeBytes) / 1073741824);
    diskInfo.free = Math.round(freeBytes / 1073741824);
    diskInfo.used = Math.round(usedBytes / 1073741824);
  } catch(e) {}

  // Açık uygulamalar
  let apps = [];
  try {
    const result = execSync('tasklist /fo csv /nh', { encoding: 'utf8', timeout: 5000 });
    const lines = result.split('\n').filter(l => l.trim());
    const appSet = new Set();
    lines.forEach(line => {
      const match = line.match(/"([^"]+)"/);
      if (match) {
        const name = match[1].replace('.exe', '');
        if (!['svchost', 'conhost', 'csrss', 'lsass', 'services', 'System', 'Registry', 'smss', 'wininit', 'dwm', 'fontdrvhost', 'winlogon', 'LogonUI', 'RuntimeBroker', 'dllhost', 'sihost', 'taskhostw', 'ctfmon', 'SearchHost', 'StartMenuExperienceHost', 'TextInputHost', 'ShellExperienceHost', 'SecurityHealthSystray', 'spoolsv', 'dasHost'].includes(name)) {
          appSet.add(name);
        }
      }
    });
    apps = Array.from(appSet).slice(0, 30);
  } catch(e) {}

  // İnternet hızı (basit ping)
  let internetStatus = 'bilinmiyor';
  try {
    execSync('ping -n 1 -w 2000 8.8.8.8', { timeout: 5000 });
    internetStatus = 'bağlı';
  } catch(e) {
    internetStatus = 'bağlantı yok';
  }

  // Uptime
  const uptimeHours = Math.round(os.uptime() / 3600);

  return {
    agentId: AGENT_ID,
    hostname: os.hostname(),
    platform: os.platform(),
    timestamp: new Date().toISOString(),
    cpu: {
      model: cpus[0]?.model || 'Bilinmiyor',
      cores: cpus.length,
      usage: cpuUsage
    },
    memory: {
      total: Math.round(totalMem / 1073741824),
      used: Math.round(usedMem / 1073741824),
      free: Math.round(freeMem / 1073741824),
      percent: Math.round((usedMem / totalMem) * 100)
    },
    disk: diskInfo,
    internet: internetStatus,
    uptime: uptimeHours,
    apps,
    user: os.userInfo().username
  };
}

// === EKRAN GÖRÜNTÜSÜ ===

async function takeScreenshot() {
  try {
    const path = require('path');
    const screenshotPath = path.join(os.tmpdir(), 'agent-screenshot.jpg');
    // PowerShell ile ekran görüntüsü
    execSync(`powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bitmap = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $graphics = [System.Drawing.Graphics]::FromImage($bitmap); $graphics.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bitmap.Save('${screenshotPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Jpeg); }"`, { timeout: 10000 });
    const fs = require('fs');
    const data = fs.readFileSync(screenshotPath);
    return data.toString('base64');
  } catch(e) {
    console.log('Screenshot hatası:', e.message);
    return null;
  }
}

// === KOMUT ÇALIŞTIR ===

function runCommand(cmd) {
  try {
    const result = execSync(cmd, { encoding: 'utf8', timeout: 30000 });
    return { success: true, output: result.substring(0, 2000) };
  } catch(e) {
    return { success: false, output: e.message.substring(0, 500) };
  }
}

// === UYGULAMA KONTROL ===

function closeApp(appName) {
  try {
    execSync(`taskkill /IM "${appName}.exe" /F`, { timeout: 5000 });
    return { success: true, message: `${appName} kapatıldı` };
  } catch(e) {
    return { success: false, message: e.message };
  }
}

function openApp(appPath) {
  try {
    exec(`start "" "${appPath}"`);
    return { success: true, message: `Uygulama açıldı` };
  } catch(e) {
    return { success: false, message: e.message };
  }
}

// === SUNUCUYA RAPOR GÖNDER ===

function sendReport(url, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const isHttps = url.startsWith('https');
    const mod = isHttps ? https : http;
    const parsed = new URL(url + '/api/agent/report');

    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve({}); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// === KOMUTLARI KONTROL ET ===

async function checkCommands(url) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith('https');
    const mod = isHttps ? https : http;
    const parsed = new URL(url + '/api/agent/commands/' + AGENT_ID);

    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: 'GET'
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { resolve({ commands: [] }); }
      });
    });
    req.on('error', () => resolve({ commands: [] }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ commands: [] }); });
    req.end();
  });
}

async function processCommands(commands) {
  for (const cmd of commands) {
    console.log(`Komut alındı: ${cmd.type} - ${cmd.data || ''}`);

    let result = {};
    switch (cmd.type) {
      case 'screenshot':
        const img = await takeScreenshot();
        result = { type: 'screenshot', data: img ? `data:image/jpeg;base64,${img}` : null };
        break;
      case 'run':
        result = { type: 'run', ...runCommand(cmd.data) };
        break;
      case 'close_app':
        result = { type: 'close_app', ...closeApp(cmd.data) };
        break;
      case 'open_app':
        result = { type: 'open_app', ...openApp(cmd.data) };
        break;
      case 'shutdown':
        result = { type: 'shutdown', message: 'Bilgisayar kapatılıyor...' };
        setTimeout(() => execSync('shutdown /s /t 5'), 2000);
        break;
      case 'restart':
        result = { type: 'restart', message: 'Bilgisayar yeniden başlatılıyor...' };
        setTimeout(() => execSync('shutdown /r /t 5'), 2000);
        break;
      case 'lock':
        execSync('rundll32.exe user32.dll,LockWorkStation');
        result = { type: 'lock', message: 'Bilgisayar kilitlendi' };
        break;
      case 'message':
        // Mesajı göster
        try {
          execSync(`msg * "${cmd.data}"`, { timeout: 5000 });
        } catch(e) {
          // msg komutu çalışmazsa PowerShell ile
          try {
            execSync(`powershell -command "[System.Windows.Forms.MessageBox]::Show('${cmd.data}', 'PhotoReel - Tablet Mesajı')"`, { timeout: 5000 });
          } catch(e2) {}
        }
        result = { type: 'message', message: 'Mesaj gösterildi' };
        break;
      default:
        result = { type: 'unknown', message: 'Bilinmeyen komut' };
    }

    // Sonucu gönder
    try {
      await sendReport(CLOUD_URL, { agentId: AGENT_ID, commandResult: result, commandId: cmd.id });
    } catch(e) {}
    try {
      await sendReport(LOCAL_URL, { agentId: AGENT_ID, commandResult: result, commandId: cmd.id });
    } catch(e) {}
  }
}

// === ANA DÖNGÜ ===

async function mainLoop() {
  console.log('📡 PhotoReel Agent başlatıldı');
  console.log(`   Bilgisayar: ${os.hostname()}`);
  console.log(`   Cloud: ${CLOUD_URL}`);
  console.log(`   Lokal: ${LOCAL_URL}`);
  console.log(`   Rapor aralığı: ${REPORT_INTERVAL / 1000}sn`);
  console.log('');

  setInterval(async () => {
    try {
      const info = getSystemInfo();

      // Lokale gönder
      try { await sendReport(LOCAL_URL, info); } catch(e) {}

      // Cloud'a gönder
      try { await sendReport(CLOUD_URL, info); } catch(e) {}

      console.log(`[${new Date().toLocaleTimeString('tr-TR')}] CPU: ${info.cpu.usage}% | RAM: ${info.memory.percent}% | Disk: ${info.disk.used}/${info.disk.total}GB | Apps: ${info.apps.length} | Internet: ${info.internet}`);

      // Komutları kontrol et
      try {
        const localCmds = await checkCommands(LOCAL_URL);
        if (localCmds.commands?.length) await processCommands(localCmds.commands);
      } catch(e) {}

      try {
        const cloudCmds = await checkCommands(CLOUD_URL);
        if (cloudCmds.commands?.length) await processCommands(cloudCmds.commands);
      } catch(e) {}

    } catch(e) {
      console.error('Hata:', e.message);
    }
  }, REPORT_INTERVAL);
}

mainLoop();
