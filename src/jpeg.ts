/**
 * Baseline JPEG decoder (SOF0 only).
 * Decodes to raw RGB pixels.
 */
export function decodeJPEG(data: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  // ─── Parse markers ─────────────────────────────────────
  let sofW = 0, sofH = 0;
  const components: { id: number; h: number; v: number; tq: number }[] = [];
  const huffTables: Map<number, { symbols: number[]; minCode: number[]; maxCode: number[]; vals: number[] }> = new Map();
  const quantTables: Map<number, Uint8Array> = new Map();
  let restartInterval = 0;
  let scanDataOffset = 0; // offset in data where entropy scan starts

  let pos = 0;
  while (pos < data.length - 1) {
    if (data[pos] !== 0xFF) { pos++; continue; }
    const marker = data[pos + 1];
    pos += 2;
    if (marker === 0xD8 || marker === 0xD9) continue;
    if (marker >= 0xD0 && marker <= 0xD7) continue;
    if (marker === 0x00 || marker === 0xFF) { pos--; continue; }

    const segLen = (data[pos] << 8 | data[pos + 1]) >>> 0;
    const segStart = pos + 2; // start of segment data (after length field)

    if (marker === 0xC0) {
      // SOF0
      const prec = data[segStart];
      sofH = (data[segStart + 1] << 8 | data[segStart + 2]) >>> 0;
      sofW = (data[segStart + 3] << 8 | data[segStart + 4]) >>> 0;
      const nf = data[segStart + 5];
      for (let i = 0; i < nf; i++) {
        const off = segStart + 6 + i * 3;
        components.push({ id: data[off], h: (data[off + 1] >> 4) & 0xf, v: data[off + 1] & 0xf, tq: data[off + 2] });
      }
    } else if (marker === 0xC4) {
      // DHT
      const info = data[segStart];
      const isAc = (info >> 4) === 1;
      const tableId = info & 0xf;
      const key = tableId | (isAc ? 0x100 : 0);
      const counts = Array.from(data.slice(segStart + 1, segStart + 17));
      const total = counts.reduce((a, b) => a + b, 0);
      const symbols = Array.from(data.slice(segStart + 18, segStart + 18 + total));

      const minCode: number[] = Array.from({ length: 17 }, () => 0);
      const maxCode: number[] = Array.from({ length: 17 }, () => 0);
      let code = 0;
      for (let bits = 1; bits <= 16; bits++) {
        code = (code + counts[bits - 1]) << 1;
        minCode[bits] = code;
        maxCode[bits] = code + counts[bits] - 1;
      }
      huffTables.set(key, { symbols, minCode, maxCode, vals: symbols });
    } else if (marker === 0xDB) {
      // DQT
      const info = data[segStart];
      const tid = info & 0xf;
      const is16 = (info >> 4) === 1;
      const tbl = data.slice(segStart + 1, segStart + 1 + (is16 ? 128 : 64));
      quantTables.set(tid, tbl);
    } else if (marker === 0xDD) {
      restartInterval = (data[segStart] << 8 | data[segStart + 1]) >>> 0;
    } else if (marker === 0xDA) {
      // SOS — scan data starts right after this segment
      scanDataOffset = segStart + segLen - 2; // -2 because segLen includes the 2 length bytes
      break;
    }

    pos = segStart + segLen - 2; // -2 because we already advanced past the marker
  }

  if (sofW === 0 || sofH === 0 || scanDataOffset === 0) {
    throw new Error('Invalid JPEG: no SOF or SOS found');
  }

  // ─── Entropy decode ────────────────────────────────────
  const scanData = data.slice(scanDataOffset);
  let sPos = 0;
  let bitBuf = 0;
  let bitCnt = 0;

  const fillBits = () => {
    while (bitCnt <= 24 && sPos < scanData.length) {
      let b = scanData[sPos++];
      if (b === 0xFF) {
        const next = sPos < scanData.length ? scanData[sPos] : 0;
        if (next !== 0) { sPos--; break; } // marker found
        sPos++; // skip stuffed zero
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

  const huffDecode = (key: number): number => {
    const tbl = huffTables.get(key);
    if (!tbl) return -1;
    let code = 0;
    for (let bits = 1; bits <= 16; bits++) {
      const bit = readBit();
      if (bit === -1) return -1;
      code = (code << 1) | bit;
      if (tbl.counts && tbl.counts[bits] > 0 && code >= tbl.minCode[bits] && code <= tbl.maxCode[bits]) {
        let idx = 0;
        for (let b = 1; b < bits; b++) idx += tbl.counts![b];
        idx += code - tbl.minCode[bits];
        return tbl.vals[idx];
      }
    }
    return -1;
  };

  // Simplified huffDecode without counts check — just use minCode/maxCode
  const huffDecode2 = (key: number): number => {
    const tbl = huffTables.get(key);
    if (!tbl) return -1;
    let code = 0;
    for (let bits = 1; bits <= 16; bits++) {
      const bit = readBit();
      if (bit === -1) return -1;
      code = (code << 1) | bit;
      if (code >= tbl.minCode[bits] && code <= tbl.maxCode[bits]) {
        // Count symbols before this code at this bit length
        let idx = 0;
        for (let b = 1; b < bits; b++) {
          if (tbl.minCode[b] <= tbl.maxCode[b]) idx += tbl.maxCode[b] - tbl.minCode[b] + 1;
        }
        idx += code - tbl.minCode[bits];
        return tbl.vals[idx];
      }
    }
    return -1;
  };

  // Zigzag order
  const zz = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21,
    28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37,
    44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
    55, 62, 63
  ];

  // MCU dimensions
  let maxH = 0, maxV = 0;
  for (const c of components) { if (c.h > maxH) maxH = c.h; if (c.v > maxV) maxV = c.v; }
  const mcusX = Math.ceil(sofW / (maxH * 8));
  const mcusY = Math.ceil(sofH / (maxV * 8));

  // Component sample buffers
  const compBufs: Int16Array[] = components.map(c => {
    return new Int16Array(mcusX * c.h * mcusY * c.v * 64);
  });

  const dcPred: number[] = components.map(() => 0);
  let rstCount = 0;

  // Precompute IDCT cos values
  const cosTable = new Float64Array(64);
  for (let u = 0; u < 8; u++) {
    for (let x = 0; x < 8; x++) {
      cosTable[u * 8 + x] = Math.cos((2 * x + 1) * u * Math.PI / 16);
    }
  }
  const cScale = (u: number) => u === 0 ? 1 / Math.sqrt(2) : 1;

  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      if (restartInterval > 0 && rstCount >= restartInterval) {
        bitCnt = 0; bitBuf = 0;
        fillBits();
        if (bitCnt > 0) { sPos++; bitCnt = 0; bitBuf = 0; }
        dcPred.fill(0);
        rstCount = 0;
      }

      for (let ci = 0; ci < components.length; ci++) {
        const comp = components[ci];
        const buf = compBufs[ci];

        for (let sy = 0; sy < comp.v; sy++) {
          for (let sx = 0; sx < comp.h; sx++) {
            const block = new Int16Array(64);

            // DC
            const dcSym = huffDecode2(ci | 0x000);
            if (dcSym === -1 || dcSym > 11) continue;
            let dcVal = 0;
            if (dcSym > 0) {
              const bits = readBit() === -1 ? 0 : readBit() === -1 ? 0 : 0; // placeholder
            }
            // Redo: read dcSym bits
            if (dcSym > 0) {
              let v = 0;
              for (let i = 0; i < dcSym; i++) {
                const b = readBit();
                if (b === -1) break;
                v = (v << 1) | b;
              }
              if (v < (1 << (dcSym - 1))) v -= (1 << dcSym) - 1;
              dcVal = v;
            }
            dcPred[ci] += dcVal;
            block[0] = dcPred[ci];

            // AC
            let k = 1;
            while (k < 64) {
              const rs = huffDecode2(ci | 0x100);
              if (rs === -1 || rs === 0) break;
              const rrr = (rs >> 4) & 0xf;
              const ssss = rs & 0xf;
              if (rrr === 0xf) { k += 16; continue; }
              k += rrr;
              if (k >= 64) break;
              let val = 0;
              for (let i = 0; i < ssss; i++) {
                const b = readBit();
                if (b === -1) break;
                val = (val << 1) | b;
              }
              if (ssss > 0 && val < (1 << (ssss - 1))) val -= (1 << ssss) - 1;
              block[zz[k]] = val;
              k++;
            }
            // EOB
            if (k < 64 && huffDecode2(ci | 0x100) === -1) { /* already consumed */ }

            // Dequantize
            const qt = quantTables.get(comp.tq);
            if (qt) {
              for (let i = 0; i < 64; i++) block[i] *= qt[i];
            }

            // Fast IDCT using precomputed cos table
            const temp = new Float64Array(64);
            for (let row = 0; row < 8; row++) {
              for (let x = 0; x < 8; x++) {
                let sum = 0;
                for (let u = 0; u < 8; u++) {
                  sum += cScale(u) * block[row * 8 + u] * cosTable[u * 8 + x];
                }
                temp[row * 8 + x] = sum / 2;
              }
            }
            const result = new Int16Array(64);
            for (let col = 0; col < 8; col++) {
              for (let y = 0; y < 8; y++) {
                let sum = 0;
                for (let v = 0; v < 8; v++) {
                  sum += cScale(v) * temp[v * 8 + col] * cosTable[v * 8 + y];
                }
                result[y * 8 + col] = Math.round(sum / 2) + 128;
              }
            }

            // Store
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

  // ─── YCbCr → RGB ──────────────────────────────────────
  const pixels = new Uint8Array(sofW * sofH * 3);

  for (let y = 0; y < sofH; y++) {
    for (let x = 0; x < sofW; x++) {
      const vals: number[] = [];
      for (let ci = 0; ci < components.length; ci++) {
        const comp = components[ci];
        const scaleH = maxH / comp.h;
        const scaleV = maxV / comp.v;
        const sx = Math.min(Math.floor(x / scaleH), mcusX * comp.h * 8 - 1);
        const sy = Math.min(Math.floor(y / scaleV), mcusY * comp.v * 8 - 1);
        const bw = mcusX * comp.h * 8;
        vals.push(compBufs[ci][sy * bw + sx]);
      }

      const yv = vals[0], cb = vals[1] || 128, cr = vals[2] || 128;
      const r = clamp(yv + 1.402 * (cr - 128));
      const g = clamp(yv - 0.34414 * (cb - 128) - 0.71414 * (cr - 128));
      const b = clamp(yv + 1.772 * (cb - 128));

      const oi = (y * sofW + x) * 3;
      pixels[oi] = r; pixels[oi + 1] = g; pixels[oi + 2] = b;
    }
  }

  return { width: sofW, height: sofH, pixels };
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
