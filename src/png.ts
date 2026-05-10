/**
 * PNG decoder — reads raw RGB pixels from a PNG file.
 * Supports all color types (0,2,3,4,6), all filter types, sub-byte bit depths.
 * When maxDim is set, performs inline downscaling during decode to save memory.
 */
import { decompressSync, Decompress } from 'fflate';

export interface DecodedImage {
  width: number;
  height: number;
  pixels: Uint8Array; // RGB, 3 bytes per pixel
}

// Paeth predictor
const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * Decode PNG with optional inline downscaling.
 * When maxDim is set and image exceeds it, only keeps scaled rows/columns
 * during scanline processing, avoiding the full pixel buffer.
 */
export function decodePNG(buf: Uint8Array, maxDim = 0): DecodedImage {
  // Verify signature
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('Not a PNG');

  let off = 8;
  let w = 0, h = 0, bpc = 0, cType = 0;
  const idat: Uint8Array[] = [];
  let palette: [number, number, number][] = [];

  while (off < buf.length) {
    const len = (buf[off] << 24 | buf[off + 1] << 16 | buf[off + 2] << 8 | buf[off + 3]) >>> 0;
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    const data = buf.slice(off + 8, off + 8 + len);

    if (type === 'IHDR') {
      w = (data[0] << 24 | data[1] << 16 | data[2] << 8 | data[3]) >>> 0;
      h = (data[4] << 24 | data[5] << 16 | data[6] << 8 | data[7]) >>> 0;
      bpc = data[8];
      cType = data[9];
    } else if (type === 'PLTE') {
      for (let i = 0; i < data.length; i += 3) {
        palette.push([data[i], data[i + 1], data[i + 2]]);
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }

    off += 12 + len;
  }

  if (w === 0 || h === 0) throw new Error('Invalid PNG');

  // Determine if we need to downscale
  const needScale = maxDim > 0 && Math.max(w, h) > maxDim;
  const scale = needScale ? maxDim / Math.max(w, h) : 1;
  const outW = needScale ? Math.round(w * scale) : w;
  const outH = needScale ? Math.round(h * scale) : h;

  // Channel count per pixel
  const ch = cType === 2 ? 3 : cType === 6 ? 4 : cType === 4 ? 2 : 1;
  const bpp = Math.max(1, Math.ceil((bpc * ch) / 8));
  const stride = 1 + w * bpp;

  // Concatenate IDAT data
  let total = 0;
  for (const c of idat) total += c.length;
  const comp = new Uint8Array(total);
  let pos = 0;
  for (const c of idat) { comp.set(c, pos); pos += c.length; }

  // Decompress
  const raw = decompressSync(comp);

  // Allocate output — only if not scaling, or if scaling but output is small
  const pixels = new Uint8Array(outW * outH * 3);

  // Helper: extract RGB from unfiltered scanline at a given x position
  const extractRGB = (cur: Uint8Array, x: number): [number, number, number] => {
    if (cType === 3) {
      let idx: number;
      if (bpc === 8) idx = cur[x];
      else {
        const bitOff = x * bpc;
        const mask = (1 << bpc) - 1;
        idx = (cur[Math.floor(bitOff / 8)] >> (8 - bpc - (bitOff % 8))) & mask;
      }
      return palette[idx] || [0, 0, 0];
    } else if (bpc === 8) {
      const px = x * ch;
      return [cur[px], ch >= 2 ? cur[px + 1] : cur[px], ch >= 3 ? cur[px + 2] : cur[px]];
    } else if (bpc === 16) {
      const px = x * ch * 2;
      return [cur[px], ch >= 2 ? cur[px + 2] : cur[px], ch >= 3 ? cur[px + 4] : cur[px]];
    } else {
      const bitsPerPx = bpc * Math.min(ch, 3);
      const bitOff = x * bitsPerPx;
      const mask = (1 << bpc) - 1;
      const scale2 = 255 / mask;
      const read = (channelOffset: number): number => {
        const bo = bitOff + channelOffset * bpc;
        return Math.round(((cur[Math.floor(bo / 8)] >> (8 - bpc - (bo % 8))) & mask) * scale2);
      };
      return [read(0), ch >= 2 ? read(1) : read(0), ch >= 3 ? read(2) : read(0)];
    }
  };

  // Precompute target column indices (which source x maps to which output x)
  const targetCols: number[] = [];
  if (needScale) {
    // For each output column, compute the source column
    const seen = new Set<number>();
    for (let ox = 0; ox < outW; ox++) {
      const sx = Math.min(Math.round(ox / scale), w - 1);
      if (!seen.has(sx)) {
        targetCols.push(sx);
        seen.add(sx);
      }
    }
  }

  let prev = new Uint8Array(w * bpp);

  for (let y = 0; y < h; y++) {
    const scan = y * stride;
    const filt = raw[scan];
    const cur = raw.slice(scan + 1, scan + 1 + w * bpp);

    // Unfilter (always, needed for filter reconstruction)
    for (let x = 0; x < w * bpp; x++) {
      const rawVal = cur[x];
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;

      if (filt === 0) cur[x] = rawVal;
      else if (filt === 1) cur[x] = (rawVal + a) & 0xff;
      else if (filt === 2) cur[x] = (rawVal + b) & 0xff;
      else if (filt === 3) cur[x] = (rawVal + ((a + b) >> 1)) & 0xff;
      else if (filt === 4) cur[x] = (rawVal + paeth(a, b, c)) & 0xff;
    }

    // Check if this source row maps to an output row
    const outY = needScale ? Math.round(y * scale) : y;
    const isTargetRow = !needScale || (outY < outH && y === Math.round(outY / scale));

    if (isTargetRow) {
      if (needScale) {
        // Extract only target columns
        const seen = new Set<number>();
        let outX = 0;
        for (let ox = 0; ox < outW && outX < outW; ox++) {
          const sx = Math.min(Math.round(ox / scale), w - 1);
          if (!seen.has(sx + '_' + y)) {
            const [r, g, b] = extractRGB(cur, sx);
            const oi = (outY * outW + ox) * 3;
            pixels[oi] = r; pixels[oi + 1] = g; pixels[oi + 2] = b;
            seen.add(sx + '_' + y);
          }
        }
      } else {
        // No scaling — extract all columns
        for (let x = 0; x < w; x++) {
          const [r, g, b] = extractRGB(cur, x);
          const oi = (y * w + x) * 3;
          pixels[oi] = r; pixels[oi + 1] = g; pixels[oi + 2] = b;
        }
      }
    }

    prev = cur;
  }

  return { width: outW, height: outH, pixels };
}
