// Generates build/icon.png (256x256 arc-reactor style icon) without any native dependency.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const SIZE = 256;
const px = new Uint8Array(SIZE * SIZE * 4);

function put(x, y, r, g, b, a) {
  const i = (y * SIZE + x) * 4;
  const src = a / 255;
  const dst = px[i + 3] / 255;
  const out = src + dst * (1 - src);
  if (out === 0) return;
  px[i] = Math.round((r * src + px[i] * dst * (1 - src)) / out);
  px[i + 1] = Math.round((g * src + px[i + 1] * dst * (1 - src)) / out);
  px[i + 2] = Math.round((b * src + px[i + 2] * dst * (1 - src)) / out);
  px[i + 3] = Math.round(out * 255);
}

const cx = SIZE / 2;
const cy = SIZE / 2;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const d = Math.hypot(x - cx + 0.5, y - cy + 0.5);
    const ang = Math.atan2(y - cy, x - cx);
    // dark disc background
    if (d < 122) put(x, y, 4, 12, 22, 235);
    // outer ring
    if (d > 104 && d < 114) put(x, y, 52, 228, 255, 255);
    // segmented ring with ten gaps
    const seg = ((ang + Math.PI) / (Math.PI * 2)) * 10;
    if (d > 84 && d < 96 && seg % 1 > 0.18) put(x, y, 52, 228, 255, 200);
    // inner glow
    if (d < 62) {
      const t = 1 - d / 62;
      put(x, y, 120 + 100 * t, 240, 255, Math.round(90 + 165 * t));
    }
    if (d < 26) put(x, y, 235, 252, 255, 255);
  }
}

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0))
]);
mkdirSync('build', { recursive: true });
writeFileSync('build/icon.png', png);
console.log(`build/icon.png written (${png.length} bytes)`);
