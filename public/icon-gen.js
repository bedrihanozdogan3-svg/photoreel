// Fenix ikonunu Canvas ile oluşturup kaydet
// node icon-gen.js → fenix-icon-192.png ve fenix-icon-512.png üretir
const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

function makeIcon(size) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');

  // Arka plan
  ctx.fillStyle = '#050508';
  ctx.fillRect(0, 0, size, size);

  // Ateş halkası
  const grd = ctx.createRadialGradient(size/2, size*0.65, 0, size/2, size*0.65, size*0.4);
  grd.addColorStop(0, 'rgba(255,150,0,0.6)');
  grd.addColorStop(0.5, 'rgba(255,69,0,0.3)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);

  // Fenix F harfi
  const fs2 = size * 0.52;
  ctx.font = `900 ${fs2}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Glow efekti
  ctx.shadowColor = 'rgba(255,106,0,0.9)';
  ctx.shadowBlur = size * 0.1;
  ctx.fillStyle = '#C4A882';
  ctx.fillText('✦', size / 2, size / 2);

  return c.toBuffer('image/png');
}

try {
  const outDir = path.join(__dirname, 'public');
  fs.writeFileSync(path.join(outDir, 'fenix-icon-192.png'), makeIcon(192));
  fs.writeFileSync(path.join(outDir, 'fenix-icon-512.png'), makeIcon(512));
  console.log('✅ İkonlar oluşturuldu');
} catch(e) {
  console.log('canvas modülü yok, ikonlar SVG fallback ile devam edecek');
}
