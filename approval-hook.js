#!/usr/bin/env node
/**
 * Claude Code Approval Hook
 * Her izin isteğini tablete gönderir, onay bekler
 */

const CLOUD_URL = 'https://photoreel-194617495310.europe-west1.run.app';

async function main() {
  // Stdin'den tool bilgisini oku
  let stdinData = '';
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    stdinData = Buffer.concat(chunks).toString();
  } catch(e) {}

  let toolInfo = '';
  try {
    const parsed = JSON.parse(stdinData);
    toolInfo = parsed.tool_input?.command || parsed.tool_input?.file_path || stdinData.slice(0, 200);
  } catch(e) {
    toolInfo = stdinData.slice(0, 200);
  }

  const tool = process.env.CLAUDE_TOOL || 'unknown';
  const description = toolInfo || process.argv.slice(2).join(' ') || process.env.CLAUDE_TOOL_DESCRIPTION || 'Bilinmeyen işlem';

  console.error(`[Hook] Onay isteniyor: ${tool} - ${description}`);

  try {
    const res = await fetch(CLOUD_URL + '/api/approval/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: tool,
        description: description.slice(0, 300),
        type: 'permission'
      })
    });
    const data = await res.json();
    const approvalId = data.approvalId;

    console.error(`[Hook] Onay isteği gönderildi: ${approvalId}`);

    // Onay bekle (max 60 saniye)
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));

      const check = await fetch(CLOUD_URL + '/api/approval/result/' + approvalId);
      const result = await check.json();

      if (result.status === 'approved') {
        console.error('[Hook] Onaylandı!');
        process.exit(0);
      } else if (result.status === 'rejected') {
        console.error('[Hook] Reddedildi!');
        process.exit(1);
      }
    }

    // Timeout — otomatik onayla
    console.error('[Hook] Zaman aşımı - otomatik onay');
    process.exit(0);
  } catch(e) {
    console.error('[Hook] Hata:', e.message, '- otomatik onay');
    process.exit(0);
  }
}

main();
