#!/usr/bin/env node
const CLOUD_URL = 'https://photoreel-194617495310.europe-west1.run.app';
const LOCAL_URL = 'http://localhost:3000';

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
    // Hem lokal hem cloud'a gönder — tablet hangisinden açıksa oradan onaylar
    const body = JSON.stringify({ title: 'Bash Komutu', description: cmd.slice(0, 300), type: 'permission' });
    const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };

    let approvalId;
    try {
      const res = await fetch(LOCAL_URL + '/api/approval/request', opts);
      const data = await res.json();
      approvalId = data.approvalId;
    } catch(e) {
      // Lokal yoksa cloud'a gönder
      const res = await fetch(CLOUD_URL + '/api/approval/request', opts);
      const data = await res.json();
      approvalId = data.approvalId;
    }

    // Aynı anda cloud'a da gönder (tablet cloud'dan açıksa)
    try { await fetch(CLOUD_URL + '/api/approval/request', opts); } catch(e) {}

    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000));
      // Hem lokal hem cloud'dan kontrol et
      try {
        const c = await fetch(LOCAL_URL + '/api/approval/result/' + approvalId);
        const r = await c.json();
        if (r.status === 'approved') process.exit(0);
        if (r.status === 'rejected') process.exit(1);
      } catch(e) {}
      try {
        const c = await fetch(CLOUD_URL + '/api/approval/result/' + approvalId);
        const r = await c.json();
        if (r.status === 'approved') process.exit(0);
        if (r.status === 'rejected') process.exit(1);
      } catch(e) {}
    }
    process.exit(1); // timeout -> reddet (güvenlik)
  } catch(e) {
    process.exit(1); // hata -> reddet (güvenlik)
  }
});
