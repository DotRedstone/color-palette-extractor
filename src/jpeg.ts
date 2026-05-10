/**
 * Baseline JPEG decoder (SOF0/0xC0 only).
 * Decodes to raw RGB pixels. No external dependencies.
 */
export function decodeJPEG(data: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  let pos = 0;

  // Segment metadata
  let sofW = 0, sofH = 0;
  const components: { id: number; h: number; v: number; tq: number }[] = [];
  const huffTables: Map<number, { counts: number[]; symbols: number[]; minCode: number[]; maxCode: number[]; vals: number[] }> = new Map();
  const quantTables: Map<number, Uint8Array> = new Map();
  let restartInterval = 0;

  const readU16 = () => (data[pos] << 8) | data[pos + 1];

  // ─── Pass 1: Parse markers ──────────────────────────────
  while (pos < data.length - 1) {
    if (data[pos] !== 0xFF) { pos++; continue; }
    const marker = data[pos + 1];
    pos += 2;

    if (marker === 0xD8 || marker === 0xD9) continue; // SOI / EOI
    if (marker >= 0xD0 && marker <= 0xD7) continue; // RSTn

    if (marker === 0x00 || marker === 0xFF) { pos--; continue; }

    const segLen = readU16();
    const segStart = pos;

    if (marker === 0xC0) {
      // SOF0 — baseline
      pos++; // precision
      sofH = readU16(); pos += 2;
      sofW = readU16(); pos += 2;
      const nf = data[pos]; pos++;
      for (let i = 0; i < nf; i++) {
        const id = data[pos]; const hv = data[pos + 1]; const tq = data[pos + 2];
        components.push({ id, h: (hv >> 4) & 0xf, v: hv & 0xf, tq });
        pos += 3;
      }
    } else if (marker === 0xC4) {
      // DHT
      const info = data[pos]; pos++;
      const isAc = (info >> 4) === 1;
      const tableId = info & 0xf;
      const key = tableId | (isAc ? 0x100 : 0);
      const counts = Array.from(data.slice(pos, pos + 16));
      pos += 16;
      const total = counts.reduce((a, b) => a + b, 0);
      const symbols = Array.from(data.slice(pos, pos + total));
      pos += total;

      // Build min/max code arrays for fast decoding
      const minCode: number[] = Array.from({ length: 17 }, () => 0);
      const maxCode: number[] = Array.from({ length: 17 }, () => 0);
      let code = 0;
      for (let bits = 1; bits <= 16; bits++) {
        code = (code + counts[bits - 1]) << 1;
        minCode[bits] = code;
        maxCode[bits] = code + counts[bits] - 1;
      }
      huffTables.set(key, { counts, symbols, minCode, maxCode, vals: symbols });
    } else if (marker === 0xDB) {
      // DQT
      const info = data[pos]; pos++;
      const tid = info & 0xf;
      const is16 = (info >> 4) === 1;
      const tbl = data.slice(pos, pos + (is16 ? 128 : 64));
      pos += (is16 ? 128 : 64);
      quantTables.set(tid, tbl);
    } else if (marker === 0xDD) {
      // DRI
      restartInterval = readU16(); pos += 2;
    } else if (marker === 0xDA) {
      // SOS — stop parsing, scan data follows
      pos = segStart + segLen;
      break;
    }

    pos = segStart + segLen;
  }

  // ─── Pass 2: Entropy decode scan data ──────────────────
  // Bit reader
  let bitBuf = 0;
  let bitCnt = 0;

  const fillBits = () => {
    while (bitCnt <= 24 && pos < data.length) {
      let b = data[pos++];
      if (b === 0xFF) {
        const next = pos < data.length ? data[pos] : 0;
        if (next !== 0) {
          // Marker found in scan — rewind
          pos--;
          break;
        }
        pos++; // skip stuffed zero
      }
      bitBuf = (bitBuf << 8) | b;
      bitCnt += 8;
    }
  };

  const readBit = (): number => {
    if (bitCnt < 1) fillBits();
    if (bitCnt < 1) return -1;
    bitCnt--;
    return (bitBuf >> bitCnt) & 1;
  };

  const readBits = (n: number): number => {
    while (bitCnt < n) fillBits();
    if (bitCnt < n) return -1;
    bitCnt -= n;
    return (bitBuf >> bitCnt) & ((1 << n) - 1);
  };

  const huffDecode = (key: number): number => {
    const tbl = huffTables.get(key);
    if (!tbl) return -1;

    // Try reading 1..16 bits
    let code = 0;
    for (let bits = 1; bits <= 16; bits++) {
      const bit = readBit();
      if (bit === -1) return -1;
      code = (code << 1) | bit;
      if (tbl.counts[bits] > 0 && code >= tbl.minCode[bits] && code <= tbl.maxCode[bits]) {
        // Found — compute symbol index
        let idx = 0;
        for (let b = 1; b < bits; b++) idx += tbl.counts[b];
        idx += code - tbl.minCode[bits];
        return tbl.vals[idx];
      }
    }
    return -1;
  };

  // Build IDCT lookup tables
  const idctScale: number[] = Array.from({ length: 8 }, (_, i) => {
    const c = i === 0 ? 1 / Math.sqrt(2) : 1;
    return c;
  });

  // Zigzag order
  const zzOrder = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
    28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37,
    44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
    55, 62, 63
  ];

  // Determine MCU dimensions
  let maxH = 0, maxV = 0;
  for (const c of components) { if (c.h > maxH) maxH = c.h; if (c.v > maxV) maxV = c.v; }

  const mcuW = maxH * 8;
  const mcuV = maxV * 8;
  const mcusX = Math.ceil(sofW / mcuW);
  const mcusY = Math.ceil(sofH / mcuV);
  const totalMCU = mcusX * mcusY;

  // Component sample buffers
  const compBufs: Int16Array[] = components.map((c, ci) => {
    return new Int16Array(mcusX * c.h * mcusY * c.v * 64);
  });

  // DC predictors
  const dcPred: number[] = components.map(() => 0);

  // Entropy decode all MCUs
  let mcuIdx = 0;
  let rstCount = 0;

  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      if (restartInterval > 0 && rstCount >= restartInterval) {
        // Align to byte boundary
        bitCnt = 0; bitBuf = 0;
        fillBits();
        // Skip any remaining bits in current byte
        if (bitCnt > 0) { pos++; bitCnt = 0; bitBuf = 0; }
        dcPred.fill(0);
        rstCount = 0;
      }

      for (let ci = 0; ci < components.length; ci++) {
        const comp = components[ci];
        const dcKey = ci | 0x000;
        const acKey = ci | 0x100;
        const buf = compBufs[ci];

        for (let sy = 0; sy < comp.v; sy++) {
          for (let sx = 0; sx < comp.h; sx++) {
            // Decode one 8x8 block
            const block = new Int16Array(64);

            // DC coefficient
            const dcDiff = huffDecode(dcKey);
            if (dcDiff === -1) continue;
            let dcVal = 0;
            if (dcDiff > 0) dcVal = readBits(dcDiff);
            if (dcVal === -1) continue;
            if (dcDiff > 0 && dcVal < (1 << (dcDiff - 1))) dcVal -= (1 << dcDiff) - 1;
            dcPred[ci] += dcVal;
            block[0] = dcPred[ci];

            // AC coefficients
            let k = 1;
            while (k < 64) {
              const rs = huffDecode(acKey);
              if (rs === -1) break;
              if (rs === 0x00) {
                // EOB — rest of block is zero
                break;
              }
              const rrr = (rs >> 4) & 0xf;
              const ssss = rs & 0xf;
              if (rrr === 0xf) {
                // ZRL — 16 zeros
                k += 16;
                continue;
              }
              k += rrr;
              if (k >= 64) break;
              let val = readBits(ssss);
              if (val === -1) break;
              if (val < (1 << (ssss - 1))) val -= (1 << ssss) - 1;
              block[zzOrder[k]] = val;
              k++;
            }

            // Dequantize
            const qt = quantTables.get(comp.tq);
            if (qt) {
              for (let i = 0; i < 64; i++) block[i] *= qt[i];
            }

            // IDCT
            const temp = new Float64Array(64);
            // Row-wise IDCT
            for (let row = 0; row < 8; row++) {
              for (let x = 0; x < 8; x++) {
                let sum = 0;
                for (let u = 0; u < 8; u++) {
                  const c2 = idctScale[u];
                  sum += c2 * block[row * 8 + u] * Math.cos((2 * x + 1) * u * Math.PI / 16);
                }
                temp[row * 8 + x] = sum / 2;
              }
            }
            // Column-wise IDCT
            const result = new Int16Array(64);
            for (let col = 0; col < 8; col++) {
              for (let y = 0; y < 8; y++) {
                let sum = 0;
                for (let v = 0; v < 8; v++) {
                  const c2 = idctScale[v];
                  sum += c2 * temp[v * 8 + col] * Math.cos((2 * y + 1) * v * Math.PI / 16);
                }
                result[y * 8 + col] = Math.round(sum / 2) + 128;
              }
            }

            // Store in component buffer
            const bx = (mx * comp.h + sx) * 8;
            const by = (my * comp.v + sy) * 8;
            const bw = mcusX * comp.h * 8;
            for (let y = 0; y < 8; y++) {
              for (let x = 0; x < 8; x++) {
                buf[(by + y) * bw + (bx + x)] = result[y * 8 + x];
              }
            }
          }
        }
      }
      rstCount++;
    }
  }

  // ─── Pass 3: Upsample & YCbCr → RGB ──────────────────
  const pixels = new Uint8Array(sofW * sofH * 3);

  for (let y = 0; y < sofH; y++) {
    for (let x = 0; x < sofW; x++) {
      const pixelVals: number[] = [];

      for (let ci = 0; ci < components.length; ci++) {
        const comp = components[ci];
        const scaleH = maxH / comp.h;
        const scaleV = maxV / comp.v;
        const sx = Math.floor(x / scaleH);
        const sy = Math.floor(y / scaleV);
        const bw = mcusX * comp.h * 8;

        // Bilinear interpolation would be better, but nearest is fine
        const bx = Math.min(sx, mcusX * comp.h * 8 - 1);
        const by = Math.min(sy, mcusY * comp.v * 8 - 1);
        pixelVals.push(compBufs[ci][by * bw + bx]);
      }

      let y_val: number, cb: number, cr: number;
      if (components.length >= 3) {
        y_val = pixelVals[0]; cb = pixelVals[1]; cr = pixelVals[2];
      } else {
        y_val = cb = cr = pixelVals[0];
      }

      // YCbCr → RGB
      const r = clamp(y_val + 1.402 * (cr - 128));
      const g = clamp(y_val - 0.34414 * (cb - 128) - 0.71414 * (cr - 128));
      const b = clamp(y_val + 1.772 * (cb - 128));

      const oi = (y * sofW + x) * 3;
      pixels[oi] = r; pixels[oi + 1] = g; pixels[oi + 2] = b;
    }
  }

  return { width: sofW, height: sofH, pixels };
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
