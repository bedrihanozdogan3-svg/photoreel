/**
 * Fenix AI — PWA İkon Üreticisi
 * Dış paket yok — sadece Node.js built-in zlib + fs
 * Çıktı: public/fenix-icon-192.png ve public/fenix-icon-512.png
 */
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── PNG yazıcı ────────────────────────────────────────────────
function crc32(buf) {
  let c = 0xFFFFFFFF;
  const t = [];
  for (let n = 0; n < 256; n++) {
    let k = n;
    for (let i = 0; i < 8; i++) k = (k & 1) ? 0xEDB88320 ^ (k >>> 1) : k >>> 1;
    t[n] = k;
  }
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const tc  = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tc, data])));
  return Buffer.concat([len, tc, data, crc]);
}

function makePNG(w, h, pixels) {
  // pixels: Uint8Array [r,g,b,a, r,g,b,a, ...]  w*h*4
  const raw = [];
  for (let y = 0; y < h; y++) {
    raw.push(0); // filter byte
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      raw.push(pixels[i], pixels[i+1], pixels[i+2], pixels[i+3]);
    }
  }
  const compressed = zlib.deflateSync(Buffer.from(raw));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // bit depth 8, RGBA
  return Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]), // PNG signature
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ── İkon çizici ───────────────────────────────────────────────
function drawIcon(size) {
  const px = new Uint8Array(size * size * 4);

  function setPixel(x, y, r, g, b, a = 255) {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const i = (y * size + x) * 4;
    // alpha blending
    const aa = a / 255;
    px[i]   = Math.round(px[i]   * (1-aa) + r * aa);
    px[i+1] = Math.round(px[i+1] * (1-aa) + g * aa);
    px[i+2] = Math.round(px[i+2] * (1-aa) + b * aa);
    px[i+3] = Math.min(255, px[i+3] + a);
  }

  function fillCircle(cx, cy, r, R, G, B, A=255) {
    for (let y = cy-r; y <= cy+r; y++)
      for (let x = cx-r; x <= cx+r; x++)
        if ((x-cx)**2 + (y-cy)**2 <= r*r) setPixel(x, y, R, G, B, A);
  }

  function fillRect(x, y, w, h, R, G, B, A=255) {
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++)
        setPixel(x+dx, y+dy, R, G, B, A);
  }

  // Ölçek faktörü (192 baz alındı)
  const s = size / 192;
  const c = Math.round;

  // ── Arka plan: koyu void ──
  for (let i = 0; i < size * size * 4; i += 4) {
    px[i] = 8; px[i+1] = 5; px[i+2] = 7; px[i+3] = 255;
  }

  // ── Yuvarlatılmış köşe maskesi (ikon yuvarlak görünsün) ──
  const R = size * 0.22; // köşe yarıçapı
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let mask = true;
      // 4 köşe kontrolü
      if (x < R && y < R && (x-R)**2+(y-R)**2 > R*R) mask = false;
      if (x > size-R && y < R && (x-(size-R))**2+(y-R)**2 > R*R) mask = false;
      if (x < R && y > size-R && (x-R)**2+(y-(size-R))**2 > R*R) mask = false;
      if (x > size-R && y > size-R && (x-(size-R))**2+(y-(size-R))**2 > R*R) mask = false;
      if (!mask) { const i=(y*size+x)*4; px[i]=0;px[i+1]=0;px[i+2]=0;px[i+3]=0; }
    }
  }

  // ── Arka plan daire (ember glow) ──
  fillCircle(c(96*s), c(100*s), c(70*s), 30, 12, 8, 255);
  // iç amber glow
  fillCircle(c(96*s), c(100*s), c(50*s), 45, 18, 5, 180);

  // ── Gövde (kuş) ──
  // Göğüs
  fillCircle(c(96*s), c(105*s), c(28*s), 255, 107, 26, 255);  // ember turuncu
  // Kafa
  fillCircle(c(96*s), c(72*s), c(18*s), 255, 140, 40, 255);

  // ── Sol kanat ──
  for (let t = 0; t <= 1; t += 0.01) {
    const wx = c((96 - 55*t - 10*t*t)*s);
    const wy = c((90 - 20*t + 30*t*t)*s);
    fillCircle(wx, wy, c((12-8*t)*s), 255, 120, 26, 255);
  }
  // kanat ucu ateş sarısı
  for (let t = 0.7; t <= 1; t += 0.01) {
    const wx = c((96 - 55*t - 10*t*t)*s);
    const wy = c((90 - 20*t + 30*t*t)*s);
    fillCircle(wx, wy, c(5*s), 255, 200, 60, 230);
  }

  // ── Sağ kanat ──
  for (let t = 0; t <= 1; t += 0.01) {
    const wx = c((96 + 55*t + 10*t*t)*s);
    const wy = c((90 - 20*t + 30*t*t)*s);
    fillCircle(wx, wy, c((12-8*t)*s), 255, 120, 26, 255);
  }
  for (let t = 0.7; t <= 1; t += 0.01) {
    const wx = c((96 + 55*t + 10*t*t)*s);
    const wy = c((90 - 20*t + 30*t*t)*s);
    fillCircle(wx, wy, c(5*s), 255, 200, 60, 230);
  }

  // ── Kuyruk ateşi ──
  for (let t = 0; t <= 1; t += 0.008) {
    const tx = c((96 + (Math.sin(t*Math.PI*3))*15*t)*s);
    const ty = c((120 + 50*t)*s);
    fillCircle(tx, ty, c((9-7*t)*s), 255, 80+c(100*t), 0, c(255*(1-t*0.7)));
  }
  // kuyruk sol dal
  for (let t = 0; t <= 1; t += 0.008) {
    const tx = c((96 - 20*t)*s);
    const ty = c((125 + 45*t)*s);
    fillCircle(tx, ty, c((7-5*t)*s), 255, 60+c(80*t), 0, c(240*(1-t*0.8)));
  }

  // ── Tepe tüyü (krest) ──
  for (let t = 0; t <= 1; t += 0.01) {
    const kx = c((96 + Math.sin(t*Math.PI)*8)*s);
    const ky = c((72 - 22*t)*s);
    fillCircle(kx, ky, c((4-2*t)*s), 255, 180, 50, c(255*(1-t*0.3)));
  }

  // ── Göz ──
  fillCircle(c(89*s), c(68*s), c(4*s), 255, 220, 80, 255);
  fillCircle(c(89*s), c(68*s), c(2*s), 20,  8,   5,  255);

  // ── "F" harfi (gövde üstünde, altın rengi) ──
  // Daha küçük boyut için harfi kaldır, sadece büyük ikonlarda göster
  if (size >= 256) {
    const fx = c(82*s), fy = c(96*s), fw = c(28*s), fh = c(34*s), ft = c(5*s);
    fillRect(fx, fy, fw, ft, 212, 168, 83, 220);           // üst yatay
    fillRect(fx, fy, ft, fh, 212, 168, 83, 220);           // sol dikey
    fillRect(fx, c((fy+fh/2-ft/2)), c(fw*0.7), ft, 212, 168, 83, 200); // orta yatay
  }

  return px;
}

// ── Dosyaları oluştur ──────────────────────────────────────────
const outDir = path.join(__dirname, '..', 'public');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

[192, 512].forEach(size => {
  const pixels = drawIcon(size);
  const png    = makePNG(size, size, pixels);
  const out    = path.join(outDir, `fenix-icon-${size}.png`);
  fs.writeFileSync(out, png);
  console.log(`✓ ${out}  (${(png.length/1024).toFixed(1)} KB)`);
});

console.log('İkonlar hazır!');
