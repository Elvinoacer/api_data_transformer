import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

/**
 * Generates crisp Obsidian-Forest + Electric-Lime rounded-squircle extension icons (16, 48, 128px).
 */
function createLimeBrandPng(width, height) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // 8-bit depth
  ihdr.writeUInt8(6, 9); // RGBA
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  const ihdrChunk = createChunk('IHDR', ihdr);
  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(rowSize * height);

  // Obsidian base (#111c14 -> 17, 28, 20) + Electric Lime accent (#9be44d -> 155, 228, 77)
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData.writeUInt8(0, rowOffset);
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      const nx = (x + 0.5) / width * 2 - 1;
      const ny = (y + 0.5) / height * 2 - 1;
      // Superellipse squircle boundary: |x|^4 + |y|^4
      const squircle = Math.pow(Math.abs(nx), 4.2) + Math.pow(Math.abs(ny), 4.2);

      let cr = 17, cg = 28, cb = 20, ca = 255;

      if (squircle > 1.0) {
        ca = 0;
      } else if (squircle > 0.86) {
        ca = Math.max(0, Math.min(255, Math.floor((255 * (1.0 - squircle)) / 0.14)));
      } else {
        // Subtle inner lime border ring or center pulse node
        const rad = Math.sqrt(nx * nx + ny * ny);
        if (rad < 0.34) {
          // Crisp bright lime center pulse dot
          cr = 155;
          cg = 228;
          cb = 77;
        } else if (rad > 0.52 && rad < 0.66) {
          // Outer radar arc in lime
          cr = 126;
          cg = 200;
          cb = 42;
        } else {
          // Deep obsidian gradient
          cr = Math.min(255, Math.floor(17 + (1 - ny) * 10));
          cg = Math.min(255, Math.floor(28 + (1 - ny) * 14));
          cb = Math.min(255, Math.floor(20 + (1 - ny) * 10));
        }
      }

      rawData.writeUInt8(cr, pxOffset);
      rawData.writeUInt8(cg, pxOffset + 1);
      rawData.writeUInt8(cb, pxOffset + 2);
      rawData.writeUInt8(ca, pxOffset + 3);
    }
  }

  const compressedData = zlib.deflateSync(rawData);
  const idatChunk = createChunk('IDAT', compressedData);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const len = data.length;
  const buffer = Buffer.alloc(8 + len + 4);
  buffer.writeUInt32BE(len, 0);
  buffer.write(type, 4, 4, 'ascii');
  data.copy(buffer, 8);

  const crcTable = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 4; i < 8 + len; i++) {
    crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  buffer.writeUInt32BE(crc, 8 + len);

  return buffer;
}

let crcTable = null;
function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      if (c & 1) c = 0xedb88320 ^ (c >>> 1);
      else c = c >>> 1;
    }
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

const iconsDir = path.resolve('public', 'icons');
fs.mkdirSync(iconsDir, { recursive: true });

fs.writeFileSync(path.join(iconsDir, 'icon-16.png'), createLimeBrandPng(16, 16));
fs.writeFileSync(path.join(iconsDir, 'icon-48.png'), createLimeBrandPng(48, 48));
fs.writeFileSync(path.join(iconsDir, 'icon-128.png'), createLimeBrandPng(128, 128));

console.log('Obsidian + Lime extension icons generated successfully in public/icons/');
