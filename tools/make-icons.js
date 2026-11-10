// Generates icons/icon-192.png and icons/icon-512.png: a simple bike-wheel glyph.
// No dependencies: rasterizes with 4x4 supersampling and writes PNG via zlib.
// Usage: node tools/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [0x0b, 0x53, 0x94];
const FG = [0xff, 0xff, 0xff];
const ACCENT = [0x4a, 0xde, 0x80];

// Shapes in unit coordinates (0..1), centered at 0.5. Everything stays inside the
// maskable safe zone (radius 0.4).
const C = 0.5;
const TIRE_OUT = 0.34, TIRE_IN = 0.285, RIM = 0.265, RIM_IN = 0.25;
const HUB = 0.05, SPOKE_W = 0.014, SPOKES = 12;

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function colorAt(x, y) {
  const dx = x - C, dy = y - C, r = Math.hypot(dx, dy);
  if (r <= TIRE_OUT && r >= TIRE_IN) return FG;
  if (r <= RIM && r >= RIM_IN) return ACCENT;
  if (r <= HUB) return FG;
  if (r < RIM_IN) {
    for (let i = 0; i < SPOKES; i++) {
      const a = (i / SPOKES) * Math.PI * 2;
      if (segDist(x, y, C, C, C + Math.cos(a) * RIM_IN, C + Math.sin(a) * RIM_IN) <= SPOKE_W / 2) return FG;
    }
  }
  return BG;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const SS = 4;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 3 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = colorAt((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
        r += c[0]; g += c[1]; b += c[2];
      }
      const o = py * (size * 3 + 1) + 1 + px * 3;
      raw[o] = Math.round(r / (SS * SS)); raw[o + 1] = Math.round(g / (SS * SS)); raw[o + 2] = Math.round(b / (SS * SS));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const s of [192, 512]) {
  fs.writeFileSync(path.join(outDir, `icon-${s}.png`), png(s));
  console.log(`wrote icons/icon-${s}.png`);
}
