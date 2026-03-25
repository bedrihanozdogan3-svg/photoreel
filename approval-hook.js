#!/usr/bin/env node
const CLOUD_URL = 'https://photoreel-194617495310.europe-west1.run.app';

// Stdin'i hizlica oku, karar ver
let chunks = [];
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', async () => {
  const input = chunks.join('');

  // Kopru + zararsiz komutlar -> aninda onayla
  if (input.includes('claude-local') || input.includes('approval/') ||
      input.includes('terminal/') || input.includes('/health') ||
      input.includes('"echo ') || input.includes('"ls') ||
      input.includes('"git status') || input.includes('"git log') ||
      input.includes('"git diff') || input.includes('"git add') ||
      input.includes('"git commit') || input.includes('"git push') ||
      input.includes('"pwd') || input.includes('"which') ||
      input.includes('"cat ') || input.includes('"cd ')) {
    process.exit(0);
  }

  // Onemli komutlar -> tablete onay gonder
  let cmd = '';
  try { cmd = JSON.parse(input).command || ''; } catch(e) { cmd = input.slice(0, 200); }

  try {
    const res = await fetch(CLOUD_URL + '/api/approval/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Bash', description: cmd.slice(0, 300), type: 'permission' })
    });
    const { approvalId } = await res.json();

    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const c = await fetch(CLOUD_URL + '/api/approval/result/' + approvalId);
      const r = await c.json();
      if (r.status === 'approved') process.exit(0);
      if (r.status === 'rejected') process.exit(1);
    }
    process.exit(1); // timeout -> reddet (güvenlik)
  } catch(e) {
    process.exit(1); // hata -> reddet (güvenlik)
  }
});
