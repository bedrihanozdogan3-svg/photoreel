/**
 * Fenix AI — Kod Asistanı Servisi
 * Gemini'ye dosya okuma, listeleme, arama ve düzenleme yetenekleri kazandırır.
 * Güvenlik: path traversal koruması, hassas dosya engeli, boyut limiti.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const logger = require('../utils/logger');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DESKTOP_ROOT = path.resolve('C:/Users/ASUS/Desktop');
const ALLOWED_ROOTS = [PROJECT_ROOT, DESKTOP_ROOT];
const MAX_FILE_SIZE = 500 * 1024; // 500KB
const MAX_SEARCH_RESULTS = 50;

// Engelli dosya/klasörler
const BLOCKED_PATTERNS = [
  'node_modules', '.git', '.env', '*.key', '*.pem', '*.p12',
  'package-lock.json', '*.log', 'backups/'
];

function isBlocked(filePath) {
  const rel = path.relative(PROJECT_ROOT, filePath).replace(/\\/g, '/');
  return BLOCKED_PATTERNS.some(p => {
    if (p.startsWith('*')) return rel.endsWith(p.slice(1));
    return rel.includes(p);
  });
}

function safePath(inputPath) {
  // desktop: veya photoreel: prefix kontrolü
  let resolved;
  if (inputPath.startsWith('desktop:')) {
    resolved = path.resolve(DESKTOP_ROOT, inputPath.replace('desktop:', ''));
  } else {
    resolved = path.resolve(PROJECT_ROOT, inputPath);
  }
  // İzin verilen köklerden birinde mi?
  const allowed = ALLOWED_ROOTS.some(root => resolved.startsWith(root));
  if (!allowed) {
    throw new Error('Erişim engellendi — sadece proje ve desktop klasörlerine izin var');
  }
  if (isBlocked(resolved)) {
    throw new Error('Bu dosya/klasör erişime kapalı: ' + path.basename(resolved));
  }
  return resolved;
}

// ═══ DOSYA OKUMA ═══
async function readFile(filePath) {
  const full = safePath(filePath);
  const stat = fs.statSync(full);
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`Dosya çok büyük: ${(stat.size / 1024).toFixed(0)}KB (max ${MAX_FILE_SIZE / 1024}KB)`);
  }
  const content = fs.readFileSync(full, 'utf-8');
  const lines = content.split('\n');
  return {
    path: path.relative(PROJECT_ROOT, full).replace(/\\/g, '/'),
    content,
    lines: lines.length,
    size: stat.size,
    modified: stat.mtime.toISOString()
  };
}

// ═══ DOSYA LİSTELEME ═══
async function listFiles(directory, pattern) {
  const dir = safePath(directory || '.');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error('Klasör bulunamadı: ' + directory);
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = entries
    .filter(e => {
      const full = path.join(dir, e.name);
      if (isBlocked(full)) return false;
      if (pattern) {
        const ext = pattern.replace('*', '');
        if (ext && !e.name.endsWith(ext)) return false;
      }
      return true;
    })
    .map(e => {
      const fullPath = path.join(dir, e.name);
      // Desktop dosyaları için desktop: prefix ekle
      const isDesktop = fullPath.startsWith(DESKTOP_ROOT) && !fullPath.startsWith(PROJECT_ROOT);
      const relPath = isDesktop
        ? 'desktop:' + path.relative(DESKTOP_ROOT, fullPath).replace(/\\/g, '/')
        : path.relative(PROJECT_ROOT, fullPath).replace(/\\/g, '/');
      return {
        name: e.name,
        path: relPath,
        isDir: e.isDirectory(),
        size: e.isDirectory() ? null : fs.statSync(fullPath).size
      };
    })
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const isDesktopDir = dir.startsWith(DESKTOP_ROOT) && !dir.startsWith(PROJECT_ROOT);
  return { directory: isDesktopDir ? 'desktop:' : (path.relative(PROJECT_ROOT, dir).replace(/\\/g, '/') || '.'), files };
}

// ═══ KOD ARAMA ═══
async function searchCode(pattern, filePattern) {
  return new Promise((resolve, reject) => {
    const args = ['-rn', '--include=' + (filePattern || '*.js'), pattern, '.'];
    execFile('grep', args, { cwd: PROJECT_ROOT, timeout: 10000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err && err.code !== 1) {
        // grep code 1 = no match, code 2 = error
        // Windows'ta grep yoksa findstr dene
        execFile('findstr', ['/s', '/n', '/i', pattern, filePattern || '*.js'], { cwd: PROJECT_ROOT, timeout: 10000 }, (err2, stdout2) => {
          if (err2) return resolve({ pattern, matches: [], error: 'Arama motoru bulunamadı' });
          resolve(parseSearchResults(stdout2, pattern));
        });
        return;
      }

      const matches = [];
      if (stdout) {
        const lines = stdout.split('\n').filter(Boolean).slice(0, MAX_SEARCH_RESULTS);
        lines.forEach(line => {
          const m = line.match(/^\.\/(.+?):(\d+):(.*)$/);
          if (m && !isBlocked(path.join(PROJECT_ROOT, m[1]))) {
            matches.push({
              file: m[1].replace(/\\/g, '/'),
              line: parseInt(m[2]),
              text: m[3].trim().substring(0, 200)
            });
          }
        });
      }
      resolve({ pattern, matches, total: matches.length });
    });
  });
}

function parseSearchResults(stdout, pattern) {
  const matches = [];
  if (stdout) {
    stdout.split('\n').filter(Boolean).slice(0, MAX_SEARCH_RESULTS).forEach(line => {
      const m = line.match(/^(.+?):(\d+):(.*)$/);
      if (m && !isBlocked(path.join(PROJECT_ROOT, m[1]))) {
        matches.push({ file: m[1].replace(/\\/g, '/'), line: parseInt(m[2]), text: m[3].trim().substring(0, 200) });
      }
    });
  }
  return { pattern, matches, total: matches.length };
}

// ═══ PROJE YAPISI ═══
async function getProjectStructure(dir, depth) {
  dir = dir || PROJECT_ROOT;
  depth = depth || 0;
  if (depth > 3) return []; // Max 3 seviye derinlik

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const tree = [];

  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (isBlocked(full)) continue;

    const node = {
      name: e.name,
      path: path.relative(PROJECT_ROOT, full).replace(/\\/g, '/'),
      isDir: e.isDirectory()
    };

    if (e.isDirectory()) {
      node.children = await getProjectStructure(full, depth + 1);
    } else {
      node.size = fs.statSync(full).size;
    }
    tree.push(node);
  }

  return tree.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ═══ DOSYA DÜZENLEME (Faz 2) ═══
async function editFile(filePath, edits) {
  const full = safePath(filePath);
  if (!fs.existsSync(full)) throw new Error('Dosya bulunamadı: ' + filePath);

  const original = fs.readFileSync(full, 'utf-8');
  const lines = original.split('\n');

  // Backup oluştur
  const backupDir = path.join(PROJECT_ROOT, 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const backupName = `${Date.now()}_${path.basename(filePath)}`;
  fs.writeFileSync(path.join(backupDir, backupName), original);

  // Düzenlemeleri uygula (sondan başa — satır numaraları kaymasın)
  const sortedEdits = [...edits].sort((a, b) => (b.startLine || b.afterLine || 0) - (a.startLine || a.afterLine || 0));

  for (const edit of sortedEdits) {
    if (edit.type === 'replace') {
      lines.splice(edit.startLine - 1, (edit.endLine - edit.startLine + 1), ...edit.content.split('\n'));
    } else if (edit.type === 'insert') {
      lines.splice(edit.afterLine, 0, ...edit.content.split('\n'));
    } else if (edit.type === 'delete') {
      lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1);
    }
  }

  const newContent = lines.join('\n');
  fs.writeFileSync(full, newContent, 'utf-8');

  return {
    path: path.relative(PROJECT_ROOT, full).replace(/\\/g, '/'),
    backup: backupName,
    originalLines: original.split('\n').length,
    newLines: lines.length,
    editsApplied: edits.length
  };
}

// ═══ DOSYA OLUŞTURMA (Faz 2) ═══
async function createFile(filePath, content) {
  const full = safePath(filePath);
  if (fs.existsSync(full)) throw new Error('Dosya zaten var: ' + filePath);

  const dir = path.dirname(full);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');

  return {
    path: path.relative(PROJECT_ROOT, full).replace(/\\/g, '/'),
    size: Buffer.byteLength(content),
    lines: content.split('\n').length
  };
}

// ═══ KOMUT ÇALIŞTIRMA (Faz 3) ═══
const ALLOWED_COMMANDS = ['npm', 'node', 'git', 'ls', 'dir', 'cat', 'head', 'tail', 'find', 'grep', 'findstr', 'type'];
const BLOCKED_COMMANDS = ['rm -rf', 'sudo', 'shutdown', 'reboot', 'format', 'del /s', 'curl | sh', 'wget | sh'];

async function executeCommand(command, cwd) {
  // Komut güvenlik kontrolü
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  if (!ALLOWED_COMMANDS.includes(cmd)) {
    throw new Error(`Komut engellendi: "${cmd}" — izin verilen: ${ALLOWED_COMMANDS.join(', ')}`);
  }
  for (const blocked of BLOCKED_COMMANDS) {
    if (command.toLowerCase().includes(blocked)) {
      throw new Error(`Tehlikeli komut engellendi: ${blocked}`);
    }
  }
  // Shell metacharacter injection engeli — ;, &&, ||, |, `, $( kullanılamaz
  if (/[;|&`$]/.test(command)) {
    throw new Error('Komutta shell metacharacter kullanılamaz: ; | & ` $');
  }

  const execCwd = cwd ? safePath(cwd) : PROJECT_ROOT;

  return new Promise((resolve, reject) => {
    execFile(parts[0], parts.slice(1), {
      cwd: execCwd,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      shell: false, // GÜVENLİK: shell KAPALI — metacharacter injection engeli
      windowsHide: true
    }, (err, stdout, stderr) => {
      resolve({
        command,
        stdout: stdout?.substring(0, 50000) || '',
        stderr: stderr?.substring(0, 10000) || '',
        exitCode: err ? err.code || 1 : 0,
        error: err ? err.message : null
      });
    });
  });
}

module.exports = {
  readFile,
  listFiles,
  searchCode,
  getProjectStructure,
  editFile,
  createFile,
  executeCommand,
  PROJECT_ROOT
};
