/**
 * Generate PNG icons for the Relay Chrome Extension.
 * 
 * Creates solid purple (#7c3aed) icons with a simple baton/relay design
 * using raw PNG generation (no external dependencies needed).
 * 
 * The design: two circles connected by a diagonal line (baton passing),
 * rendered as white on purple background.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// PNG file structure helpers
function createPNG(width, height, pixels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = createChunk('IHDR', ihdr);

  // IDAT chunk - raw pixel data with filter bytes
  const rawData = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    rawData[y * (width * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 3;
      const dstIdx = y * (width * 3 + 1) + 1 + x * 3;
      rawData[dstIdx] = pixels[srcIdx];
      rawData[dstIdx + 1] = pixels[srcIdx + 1];
      rawData[dstIdx + 2] = pixels[srcIdx + 2];
    }
  }
  const compressed = zlib.deflateSync(rawData);
  const idatChunk = createChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeBuffer, data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

// CRC32 implementation for PNG
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xEDB88320;
      } else {
        crc = crc >>> 1;
      }
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Draw the relay/baton icon:
 * - Purple background with rounded corners
 * - Two white circles (representing two AI platforms)
 * - A diagonal white line/arrow connecting them (the baton/handoff)
 */
function generateIcon(size) {
  const pixels = Buffer.alloc(size * size * 3);

  // Colors
  const purple = { r: 124, g: 58, b: 237 };  // #7c3aed
  const white = { r: 255, g: 255, b: 255 };
  const darkPurple = { r: 91, g: 33, b: 182 }; // slightly darker for depth

  const centerX = size / 2;
  const centerY = size / 2;
  const cornerRadius = size * 0.15;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 3;

      // Rounded rectangle check
      if (!isInsideRoundedRect(x, y, size, size, cornerRadius)) {
        // Outside rounded rect - transparent (white background for PNG without alpha)
        pixels[idx] = 255;
        pixels[idx + 1] = 255;
        pixels[idx + 2] = 255;
        continue;
      }

      // Default: purple background
      let color = purple;

      // Draw the relay design
      // Circle 1 (top-left area) - represents source AI
      const c1x = size * 0.3;
      const c1y = size * 0.35;
      const c1r = size * 0.15;

      // Circle 2 (bottom-right area) - represents target AI
      const c2x = size * 0.7;
      const c2y = size * 0.65;
      const c2r = size * 0.15;

      // Distance from each circle center
      const dist1 = Math.sqrt((x - c1x) ** 2 + (y - c1y) ** 2);
      const dist2 = Math.sqrt((x - c2x) ** 2 + (y - c2y) ** 2);

      // Draw circles
      if (dist1 <= c1r || dist2 <= c2r) {
        color = white;
      }

      // Draw connecting line (baton) between circles
      // Line from c1 to c2 with some thickness
      const lineThickness = size * 0.06;
      const distToLine = distanceToSegment(x, y, c1x, c1y, c2x, c2y);
      if (distToLine <= lineThickness) {
        color = white;
      }

      // Draw arrow head at the end (pointing toward c2)
      const arrowSize = size * 0.12;
      const angle = Math.atan2(c2y - c1y, c2x - c1x);
      const arrowTipX = c2x - Math.cos(angle) * c2r;
      const arrowTipY = c2y - Math.sin(angle) * c2r;

      // Arrow head triangle check
      if (isInsideArrow(x, y, arrowTipX, arrowTipY, angle, arrowSize)) {
        color = white;
      }

      pixels[idx] = color.r;
      pixels[idx + 1] = color.g;
      pixels[idx + 2] = color.b;
    }
  }

  return createPNG(size, size, pixels);
}

function isInsideRoundedRect(x, y, w, h, r) {
  // Check if point is inside a rounded rectangle
  if (x < r && y < r) {
    return Math.sqrt((x - r) ** 2 + (y - r) ** 2) <= r;
  }
  if (x > w - r - 1 && y < r) {
    return Math.sqrt((x - (w - r - 1)) ** 2 + (y - r) ** 2) <= r;
  }
  if (x < r && y > h - r - 1) {
    return Math.sqrt((x - r) ** 2 + (y - (h - r - 1)) ** 2) <= r;
  }
  if (x > w - r - 1 && y > h - r - 1) {
    return Math.sqrt((x - (w - r - 1)) ** 2 + (y - (h - r - 1)) ** 2) <= r;
  }
  return x >= 0 && x < w && y >= 0 && y < h;
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);

  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));

  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
}

function isInsideArrow(px, py, tipX, tipY, angle, size) {
  // Check if point is inside an arrow/triangle pointing in the given direction
  const backAngle1 = angle + Math.PI * 0.75;
  const backAngle2 = angle - Math.PI * 0.75;

  const p1x = tipX;
  const p1y = tipY;
  const p2x = tipX + Math.cos(backAngle1) * size;
  const p2y = tipY + Math.sin(backAngle1) * size;
  const p3x = tipX + Math.cos(backAngle2) * size;
  const p3y = tipY + Math.sin(backAngle2) * size;

  return isInsideTriangle(px, py, p1x, p1y, p2x, p2y, p3x, p3y);
}

function isInsideTriangle(px, py, x1, y1, x2, y2, x3, y3) {
  const d1 = sign(px, py, x1, y1, x2, y2);
  const d2 = sign(px, py, x2, y2, x3, y3);
  const d3 = sign(px, py, x3, y3, x1, y1);

  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);

  return !(hasNeg && hasPos);
}

function sign(px, py, x1, y1, x2, y2) {
  return (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
}

// Main execution
const iconsDir = path.join(__dirname, '..', 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

const sizes = [16, 48, 128];

for (const size of sizes) {
  const png = generateIcon(size);
  const filePath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(filePath, png);
  console.log(`Generated ${filePath} (${size}x${size}, ${png.length} bytes)`);
}

console.log('\nAll icons generated successfully!');
