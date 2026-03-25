#!/usr/bin/env node
/**
 * Claude Code Approval Hook
 * Her izin isteğini tablete gönderir, onay bekler
 */

const CLOUD_URL = 'https://photoreel-194617495310.europe-west1.run.app';

async function main() {
  const tool = process.env.CLAUDE_TOOL || 'unknown';
  const desc = process.env.CLAUDE_TOOL_DESCRIPTION || process.argv.slice(2).join(' ') || 'Bilinmeyen islem';

  console.error(`[Hook] Onay isteniyor: ${tool} - ${desc}`);

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

    // Onay bekle (max 60 saniye)
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));

      const check = await fetch(CLOUD_URL + '/api/approval/result/' + approvalId);
      const result = await check.json();

      if (result.status === 'approved') {
        console.error('[Hook] Onaylandi!');
        process.exit(0);
      } else if (result.status === 'rejected') {
        console.error('[Hook] Reddedildi!');
        process.exit(1);
      }
    }

    console.error('[Hook] Zaman asimi - otomatik onay');
    process.exit(0);
  } catch(e) {
    console.error('[Hook] Hata:', e.message, '- otomatik onay');
    process.exit(0);
  }
}

main();
