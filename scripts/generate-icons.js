import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

function createPng(width, height, r, g, b) {
  // Signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // 8-bit depth
  ihdr.writeUInt8(6, 9); // RGBA
  ihdr.writeUInt8(0, 10); // deflate
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // no interlace

  const ihdrChunk = createChunk('IHDR', ihdr);

  // Raw image data with filter byte per row
  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(rowSize * height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData.writeUInt8(0, rowOffset); // Filter type 0 (None)
    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      // Make a rounded-rect or badge look:
      const dx = (x - width / 2) / (width / 2);
      const dy = (y - height / 2) / (height / 2);
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      let cr = r, cg = g, cb = b, ca = 255;
      if (dist > 0.95) {
        ca = 0; // transparent corners
      } else if (dist > 0.85) {
        // border antialias
        ca = Math.floor(255 * (0.95 - dist) / 0.1);
      } else {
        // inner gradient
        cr = Math.min(255, Math.floor(r + (1 - dy) * 30));
        cg = Math.min(255, Math.floor(g + (1 - dy) * 30));
        cb = Math.min(255, Math.floor(b + (1 - dy) * 30));
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

// Brand color: Indigo #4f46e5 -> (79, 70, 229)
fs.writeFileSync(path.join(iconsDir, 'icon-16.png'), createPng(16, 16, 79, 70, 229));
fs.writeFileSync(path.join(iconsDir, 'icon-48.png'), createPng(48, 48, 79, 70, 229));
fs.writeFileSync(path.join(iconsDir, 'icon-128.png'), createPng(128, 128, 79, 70, 229));

console.log('Icons generated successfully in public/icons/');
