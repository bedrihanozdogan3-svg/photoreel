/**
 * PhotoReel Bilgisayar Agent'ı
 * Arka planda çalışır, sistem bilgilerini Cloud'a gönderir
 * Tabletten gelen komutları uygular
 */

const os = require('os');
const { execSync, exec } = require('child_process');
const EXEC_OPTS = { encoding: 'utf8', timeout: 8000, windowsHide: true };
const https = require('https');
const http = require('http');

const CLOUD_URL = process.env.CLOUD_URL || 'https://photoreel-194617495310.europe-west1.run.app';
const LOCAL_URL = 'http://localhost:3000';
const AGENT_ID = 'bedrihan-pc';
const REPORT_INTERVAL = 10000; // 10 saniye

// === SİSTEM BİLGİLERİ ===

async function getSystemInfo() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // CPU kullanımı (saf Node.js - CMD açmaz)
  const cpuStart = os.cpus().map(c => ({ idle: c.times.idle, total: Object.values(c.times).reduce((a, b) => a + b) }));
  let cpuUsage = Math.round(cpuStart.reduce((acc, c) => acc + (1 - c.idle / c.total), 0) / cpuStart.length * 100);

  // Disk bilgisi (saf Node.js - CMD açmaz)
  let diskInfo = { total: 0, free: 0, used: 0 };
  try {
    const fs = require('fs');
    const stats = fs.statfsSync('C:\\');
    diskInfo.total = Math.round((stats.bsize * stats.blocks) / 1073741824);
    diskInfo.free = Math.round((stats.bsize * stats.bfree) / 1073741824);
    diskInfo.used = diskInfo.total - diskInfo.free;
  } catch(e) {}

  // Açık uygulamalar (saf Node.js - CMD açmaz)
  let apps = [];
  try {
    const result = execSync('tasklist /fo csv /nh', { encoding: 'utf8', timeout: 5000, windowsHide: true, shell: false });
    const lines = result.split('\n').filter(l => l.trim());
    const appSet = new Set();
    const ignore = ['svchost','conhost','csrss','lsass','services','System','Registry','smss','wininit','dwm','fontdrvhost','winlogon','LogonUI','RuntimeBroker','dllhost','sihost','taskhostw','ctfmon','SearchHost','StartMenuExperienceHost','TextInputHost','ShellExperienceHost','SecurityHealthSystray','spoolsv','dasHost','cmd','powershell','tasklist'];
    lines.forEach(line => {
      const match = line.match(/"([^"]+)"/);
      if (match) {
        const name = match[1].replace('.exe', '');
        if (!ignore.includes(name)) appSet.add(name);
      }
    });
    apps = Array.from(appSet).slice(0, 30);
  } catch(e) {}

  // İnternet durumu (DNS resolve ile — CMD açmaz, hızlı)
  let internetStatus = 'bilinmiyor';
  try {
    const dns = require('dns');
    dns.resolve('google.com', (err) => {}); // async arka plan
    // Senkron fallback: basit HTTP
    const net = require('net');
    const sock = new net.Socket();
    sock.setTimeout(2000);
    try {
      await new Promise((resolve, reject) => {
        sock.connect(53, '8.8.8.8', () => { internetStatus = 'bağlı'; sock.destroy(); resolve(); });
        sock.on('error', () => { internetStatus = 'bağlantı yok'; sock.destroy(); resolve(); });
        sock.on('timeout', () => { internetStatus = 'bağlantı yok'; sock.destroy(); resolve(); });
      });
    } catch(e2) { internetStatus = 'bağlantı yok'; }
  } catch(e) { internetStatus = 'bağlantı yok'; }

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
    execSync(`powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object { $bitmap = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height); $graphics = [System.Drawing.Graphics]::FromImage($bitmap); $graphics.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size); $bitmap.Save('${screenshotPath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Jpeg); }"`, { timeout: 10000, windowsHide: true });
    const fs = require('fs');
    const data = fs.readFileSync(screenshotPath);
    return data.toString('base64');
  } catch(e) {
    console.log('Screenshot hatası:', e.message);
    return null;
  }
}

// === KOMUT ÇALIŞTIR (WHITELIST TABANLI — sadece izin verilenler çalışır) ===

const ALLOWED_COMMANDS = {
  'dir': { cmd: 'dir', safe: true },
  'ls': { cmd: 'dir', safe: true },
  'whoami': { cmd: 'whoami', safe: true },
  'hostname': { cmd: 'hostname', safe: true },
  'ipconfig': { cmd: 'ipconfig', safe: true },
  'systeminfo': { cmd: 'systeminfo', safe: true },
  'tasklist': { cmd: 'tasklist /fo csv /nh', safe: true },
  'git-status': { cmd: 'git status', cwd: 'C:\\Users\\ASUS\\Desktop\\photoreel-repo', safe: true },
  'git-log': { cmd: 'git log --oneline -10', cwd: 'C:\\Users\\ASUS\\Desktop\\photoreel-repo', safe: true },
  'node-version': { cmd: 'node --version', safe: true },
  'npm-version': { cmd: 'npm --version', safe: true },
  'disk-usage': { cmd: 'wmic logicaldisk get size,freespace,caption', safe: true },
};

function runCommand(cmd) {
  // Whitelist kontrolü — sadece izin verilen komutlar çalışır
  const allowed = ALLOWED_COMMANDS[cmd];
  if (!allowed) {
    const availableCommands = Object.keys(ALLOWED_COMMANDS).join(', ');
    return { success: false, output: `Güvenlik: Bu komut izin listesinde değil. İzin verilenler: ${availableCommands}` };
  }

  try {
    const opts = { encoding: 'utf8', timeout: 15000, windowsHide: true };
    if (allowed.cwd) opts.cwd = allowed.cwd;
    const result = execSync(allowed.cmd, opts);
    return { success: true, output: result.substring(0, 2000) };
  } catch(e) {
    return { success: false, output: e.message.substring(0, 500) };
  }
}

// === UYGULAMA KONTROL ===

// Uygulama adı sanitizasyon (sadece alfanumerik + tire + nokta)
function sanitizeAppName(name) {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, '');
}

function closeApp(appName) {
  const safe = sanitizeAppName(appName);
  if (!safe || safe.length > 50) return { success: false, message: 'Geçersiz uygulama adı' };
  try {
    execSync(`taskkill /IM "${safe}.exe" /F`, { timeout: 5000, windowsHide: true });
    return { success: true, message: `${safe} kapatıldı` };
  } catch(e) {
    return { success: false, message: e.message };
  }
}

// Uygulama açma — sadece whitelist'teki uygulamalar
const ALLOWED_APPS = ['notepad', 'calc', 'explorer', 'code', 'chrome', 'firefox', 'msedge'];

function openApp(appPath) {
  const name = appPath.split(/[/\\]/).pop().replace('.exe', '').toLowerCase();
  if (!ALLOWED_APPS.includes(name)) {
    return { success: false, message: `Güvenlik: ${name} izin listesinde değil. İzin: ${ALLOWED_APPS.join(', ')}` };
  }
  try {
    exec(`start "" "${sanitizeAppName(appPath)}"`);
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
        // Tehlikeli komut — onay isteniyor
        console.log('⚠️ SHUTDOWN komutu alındı — 30sn içinde CTRL+C ile iptal edilebilir');
        result = { type: 'shutdown', message: 'Bilgisayar 30sn içinde kapanacak...' };
        setTimeout(() => {
          exec('shutdown /s /t 5', { windowsHide: true }, (err) => {
            if (err) console.error('Shutdown hatası:', err.message);
          });
        }, 30000);
        break;
      case 'restart':
        console.log('⚠️ RESTART komutu alındı — 30sn içinde CTRL+C ile iptal edilebilir');
        result = { type: 'restart', message: 'Bilgisayar 30sn içinde yeniden başlayacak...' };
        setTimeout(() => {
          exec('shutdown /r /t 5', { windowsHide: true }, (err) => {
            if (err) console.error('Restart hatası:', err.message);
          });
        }, 30000);
        break;
      case 'lock':
        exec('rundll32.exe user32.dll,LockWorkStation', { windowsHide: true });
        result = { type: 'lock', message: 'Bilgisayar kilitlendi' };
        break;
      case 'message':
        // Mesajı göster (sanitize edilmiş — RCE koruması)
        const safeMsg = (cmd.data || '').replace(/[^a-zA-Z0-9\sğüşıöçĞÜŞİÖÇ.,!?:\-()]/g, '').substring(0, 200);
        // PowerShell ile güvenli mesaj gösterme (Base64 encode)
        const psScript = `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.MessageBox]::Show('${safeMsg.replace(/'/g, "''")}', 'Fenix AI')`;
        const encodedCmd = Buffer.from(psScript, 'utf16le').toString('base64');
        exec(`powershell -encodedCommand ${encodedCmd}`, { timeout: 10000, windowsHide: true }, (err) => {
          if (err) console.log('Mesaj gösterme hatası:', err.message);
        });
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
