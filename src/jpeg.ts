/**
 * Baseline JPEG decoder (SOF0 only).
 * On-the-fly YCbCr→RGB — no component buffer arrays, minimal memory.
 * Supports optional inline downscaling via maxDim.
 */
export function decodeJPEG(data: Uint8Array, maxDim = 0): { width: number; height: number; pixels: Uint8Array } {
  // ─── Parse markers ─────────────────────────────────────
  let sofW = 0, sofH = 0;
  const components: { id: number; h: number; v: number; tq: number }[] = [];
  const huffTables: Map<number, { symbols: number[]; minCode: number[]; maxCode: number[]; vals: number[] }> = new Map();
  const quantTables: Map<number, Uint8Array> = new Map();
  let restartInterval = 0;
  let scanDataOffset = 0;

  let pos = 0;
  while (pos < data.length - 1) {
    if (data[pos] !== 0xFF) { pos++; continue; }
    const marker = data[pos + 1];
    pos += 2;
    if (marker === 0xD8 || marker === 0xD9) continue;
    if (marker >= 0xD0 && marker <= 0xD7) continue;
    if (marker === 0x00 || marker === 0xFF) { pos--; continue; }

    const segLen = (data[pos] << 8 | data[pos + 1]) >>> 0;
    const segStart = pos + 2;

    if (marker === 0xC0) {
      sofH = (data[segStart + 1] << 8 | data[segStart + 2]) >>> 0;
      sofW = (data[segStart + 3] << 8 | data[segStart + 4]) >>> 0;
      const nf = data[segStart + 5];
      for (let i = 0; i < nf; i++) {
        const off = segStart + 6 + i * 3;
        components.push({ id: data[off], h: (data[off + 1] >> 4) & 0xf, v: data[off + 1] & 0xf, tq: data[off + 2] });
      }
    } else if (marker === 0xC4) {
      const info = data[segStart];
      const isAc = (info >> 4) === 1;
      const key = (info & 0xf) | (isAc ? 0x100 : 0);
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
      const info = data[segStart];
      quantTables.set(info & 0xf, data.slice(segStart + 1, segStart + 1 + ((info >> 4) === 1 ? 128 : 64)));
    } else if (marker === 0xDD) {
      restartInterval = (data[segStart] << 8 | data[segStart + 1]) >>> 0;
    } else if (marker === 0xDA) {
      scanDataOffset = segStart + segLen - 2;
      break;
    }
    pos = segStart + segLen - 2;
  }

  if (sofW === 0 || sofH === 0 || scanDataOffset === 0) throw new Error('Invalid JPEG');

  // ─── Output dimensions ─────────────────────────────────
  const needScale = maxDim > 0 && Math.max(sofW, sofH) > maxDim;
  const outW = needScale ? Math.round(sofW * maxDim / Math.max(sofW, sofH)) : sofW;
  const outH = needScale ? Math.round(sofH * maxDim / Math.max(sofW, sofH)) : sofH;
  const pixels = new Uint8Array(outW * outH * 3);

  // ─── Bit reader ────────────────────────────────────────
  const scanData = data.slice(scanDataOffset);
  let sPos = 0, bitBuf = 0, bitCnt = 0;

  const fillBits = () => {
    while (bitCnt <= 24 && sPos < scanData.length) {
      let b = scanData[sPos++];
      if (b === 0xFF) {
        const next = sPos < scanData.length ? scanData[sPos] : 0;
        if (next !== 0) { sPos--; break; }
        sPos++;
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

  const huffDecode2 = (key: number): number => {
    const tbl = huffTables.get(key);
    if (!tbl) return -1;
    let code = 0;
    for (let bits = 1; bits <= 16; bits++) {
      const bit = readBit();
      if (bit === -1) return -1;
      code = (code << 1) | bit;
      if (code >= tbl.minCode[bits] && code <= tbl.maxCode[bits]) {
        let idx = 0;
        for (let b = 1; b < bits; b++)
          if (tbl.minCode[b] <= tbl.maxCode[b]) idx += tbl.maxCode[b] - tbl.minCode[b] + 1;
        idx += code - tbl.minCode[bits];
        return tbl.vals[idx];
      }
    }
    return -1;
  };

  const zz = [0,1,8,16,9,2,3,10,17,24,32,25,18,11,4,5,12,19,26,33,40,48,41,34,27,20,13,6,7,14,21,28,35,42,49,56,57,50,43,36,29,22,15,23,30,37,44,51,58,59,52,45,38,31,39,46,53,60,61,54,47,55,62,63];

  let maxH = 0, maxV = 0;
  for (const c of components) { if (c.h > maxH) maxH = c.h; if (c.v > maxV) maxV = c.v; }
  const mcusX = Math.ceil(sofW / (maxH * 8));
  const mcusY = Math.ceil(sofH / (maxV * 8));

  const cosTable = new Float64Array(64);
  for (let u = 0; u < 8; u++)
    for (let x = 0; x < 8; x++)
      cosTable[u * 8 + x] = Math.cos((2 * x + 1) * u * Math.PI / 16);
  const cScale = (u: number) => u === 0 ? 1 / Math.sqrt(2) : 1;

  const dcPred: number[] = components.map(() => 0);
  let rstCount = 0;

  // ─── Decode MCUs and convert on-the-fly ────────────────
  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      if (restartInterval > 0 && rstCount >= restartInterval) {
        bitCnt = 0; bitBuf = 0; fillBits();
        if (bitCnt > 0) { sPos++; bitCnt = 0; bitBuf = 0; }
        dcPred.fill(0);
        rstCount = 0;
      }

      // Decode all component blocks for this MCU
      // Store as: compBlocks[ci] = array of {sy, sx, values[64]}
      const mcuBlocks: Map<number, { sx: number; sy: number; vals: Int16Array }> = new Map();

      for (let ci = 0; ci < components.length; ci++) {
        const comp = components[ci];
        for (let sy = 0; sy < comp.v; sy++) {
          for (let sx = 0; sx < comp.h; sx++) {
            const block = new Int16Array(64);

            // DC
            const dcSym = huffDecode2(ci | 0x000);
            if (dcSym !== -1 && dcSym <= 11) {
              let dcVal = 0;
              if (dcSym > 0) {
                let v = 0;
                for (let i = 0; i < dcSym; i++) { const b = readBit(); if (b === -1) break; v = (v << 1) | b; }
                if (v < (1 << (dcSym - 1))) v -= (1 << dcSym) - 1;
                dcVal = v;
              }
              dcPred[ci] += dcVal;
              block[0] = dcPred[ci];
            }

            // AC
            let k = 1;
            while (k < 64) {
              const rs = huffDecode2(ci | 0x100);
              if (rs === -1 || rs === 0) break;
              const rrr = (rs >> 4) & 0xf, ssss = rs & 0xf;
              if (rrr === 0xf) { k += 16; continue; }
              k += rrr;
              if (k >= 64) break;
              let val = 0;
              for (let i = 0; i < ssss; i++) { const b = readBit(); if (b === -1) break; val = (val << 1) | b; }
              if (ssss > 0 && val < (1 << (ssss - 1))) val -= (1 << ssss) - 1;
              block[zz[k]] = val;
              k++;
            }

            // Dequantize + IDCT
            const qt = quantTables.get(comp.tq);
            const deq = new Float64Array(64);
            for (let i = 0; i < 64; i++) deq[i] = qt ? block[i] * qt[i] : block[i];

            const temp = new Float64Array(64);
            for (let row = 0; row < 8; row++)
              for (let x = 0; x < 8; x++) {
                let sum = 0;
                for (let u = 0; u < 8; u++) sum += cScale(u) * deq[row * 8 + u] * cosTable[u * 8 + x];
                temp[row * 8 + x] = sum / 2;
              }

            const idct = new Int16Array(64);
            for (let col = 0; col < 8; col++)
              for (let y = 0; y < 8; y++) {
                let sum = 0;
                for (let v = 0; v < 8; v++) sum += cScale(v) * temp[v * 8 + col] * cosTable[v * 8 + y];
                idct[y * 8 + col] = Math.round(sum / 2) + 128;
              }

            mcuBlocks.set(ci * 100 + sy * 10 + sx, { sx, sy, vals: idct });
          }
        }
      }

      // YCbCr→RGB for output pixels covered by this MCU
      const mcuPixX = mx * maxH * 8;
      const mcuPixY = my * maxV * 8;

      for (let py = 0; py < maxV * 8; py++) {
        const srcY = mcuPixY + py;
        if (srcY >= sofH) continue;

        const outY = needScale ? Math.round(srcY * (outH - 1) / (sofH - 1)) : srcY;
        if (outY >= outH) continue;

        for (let px = 0; px < maxH * 8; px++) {
          const srcX = mcuPixX + px;
          if (srcX >= sofW) continue;

          const outX = needScale ? Math.round(srcX * (outW - 1) / (sofW - 1)) : srcX;
          if (outX >= outW) continue;

          // Sample Y, Cb, Cr from component blocks
          const vals: number[] = [];
          for (let ci = 0; ci < components.length; ci++) {
            const comp = components[ci];
            const scaleH = maxH / comp.h;
            const scaleV = maxV / comp.v;
            const bx = Math.floor(px / scaleH / 8);
            const by = Math.floor(py / scaleV / 8);
            const lx = Math.floor(px / scaleH) % 8;
            const ly = Math.floor(py / scaleV) % 8;

            const key = ci * 100 + by * 10 + bx;
            const blk = mcuBlocks.get(key);
            vals.push(blk ? blk.vals[ly * 8 + lx] : 128);
          }

          const yv = vals[0], cb = vals[1] || 128, cr = vals[2] || 128;
          const r = clamp(yv + 1.402 * (cr - 128));
          const g = clamp(yv - 0.34414 * (cb - 128) - 0.71414 * (cr - 128));
          const b = clamp(yv + 1.772 * (cb - 128));

          const oi = (outY * outW + outX) * 3;
          pixels[oi] = r; pixels[oi + 1] = g; pixels[oi + 2] = b;
        }
      }

      rstCount++;
    }
  }

  return { width: outW, height: outH, pixels };
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
