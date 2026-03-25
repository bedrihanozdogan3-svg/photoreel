#!/usr/bin/env node
/**
 * Claude Code Approval Hook
 * Her izin isteğini tablete gönderir, onay bekler
 * Tablet köprü komutları otomatik onaylanır
 */

const CLOUD_URL = 'https://photoreel-194617495310.europe-west1.run.app';

async function main() {
  // Stdin'den tool input oku
  let stdinData = '';
  try {
    const chunks = [];
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    stdinData = chunks.join('');
  } catch(e) {}

  const tool = process.env.CLAUDE_TOOL || 'unknown';

  // Tablet köprü komutları — otomatik onayla (onay isteme)
  if (stdinData.includes('claude-local/inbox') ||
      stdinData.includes('claude-local/reply') ||
      stdinData.includes('claude-local/replies') ||
      stdinData.includes('approval/pending') ||
      stdinData.includes('approval/respond') ||
      stdinData.includes('approval/result') ||
      stdinData.includes('terminal/output') ||
      stdinData.includes('terminal/lines') ||
      stdinData.includes('/health')) {
    console.error('[Hook] Kopru komutu - otomatik onay');
    process.exit(0);
  }

  // Zararsız komutlar — otomatik onayla
  let cmd = '';
  try {
    const parsed = JSON.parse(stdinData);
    cmd = parsed.command || '';
  } catch(e) {}

  if (cmd.startsWith('echo ') || cmd.startsWith('ls') || cmd.startsWith('cat ') ||
      cmd.startsWith('git status') || cmd.startsWith('git log') || cmd.startsWith('git diff') ||
      cmd.startsWith('pwd') || cmd.startsWith('which') || cmd.startsWith('where')) {
    console.error('[Hook] Zararsiz komut - otomatik onay');
    process.exit(0);
  }

  const desc = cmd || process.env.CLAUDE_TOOL_DESCRIPTION || 'Bilinmeyen islem';
  console.error(`[Hook] Onay isteniyor: ${tool} - ${desc.slice(0, 100)}`);

  try {
    const res = await fetch(CLOUD_URL + '/api/approval/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: tool,
        description: desc.slice(0, 300),
        type: 'permission'
      })
    });
    const data = await res.json();
    const approvalId = data.approvalId;

    console.error(`[Hook] Onay gonderildi: ${approvalId}`);

    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const check = await fetch(CLOUD_URL + '/api/approval/result/' + approvalId);
      const result = await check.json();
      if (result.status === 'approved') { console.error('[Hook] Onaylandi!'); process.exit(0); }
      if (result.status === 'rejected') { console.error('[Hook] Reddedildi!'); process.exit(1); }
    }

    console.error('[Hook] Zaman asimi - otomatik onay');
    process.exit(0);
  } catch(e) {
    console.error('[Hook] Hata:', e.message, '- otomatik onay');
    process.exit(0);
  }
}

main();
