/**
 * Deflate decompressor (RFC 1951).
 * Supports stored, fixed-Huffman, and dynamic-Huffman blocks.
 * Enough for PNG IDAT decompression.
 */
export function inflate(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let p = 0;
  let bb = 0; // bit buffer
  let bc = 0; // bit count

  const readBits = (n: number): number => {
    while (bc < n) {
      if (p >= data.length) return -1;
      bb |= data[p++] << bc;
      bc += 8;
    }
    const v = bb & ((1 << n) - 1);
    bb >>>= n;
    bc -= n;
    return v;
  };

  const readByte = (): number => {
    if (bc >= 8) { const r = bc & 7; bb >>>= r; bc -= r; }
    return p < data.length ? data[p++] : -1;
  };

  // Canonical Huffman tree builder
  const buildTree = (lens: number[], maxBits: number) => {
    const cnt: number[] = Array.from({ length: maxBits + 1 }, () => 0);
    for (const l of lens) cnt[l]++;
    const next: number[] = Array.from({ length: maxBits + 1 }, () => 0);
    let code = 0;
    for (let b = 1; b <= maxBits; b++) {
      code = (code + cnt[b - 1]) << 1;
      next[b] = code;
    }
    const tree: Record<number, { bits: number; val: number }> = {};
    for (let i = 0; i < lens.length; i++) {
      if (lens[i] > 0) tree[next[lens[i]]] = { bits: lens[i], val: i };
    }
    return tree;
  };

  const decode = (tree: Record<number, { bits: number; val: number }>): number => {
    let code = 0;
    for (let b = 1; b <= 15; b++) {
      const bit = readBits(1);
      if (bit === -1) return -1;
      code = (code << 1) | bit;
      if (tree[code] && tree[code].bits === b) return tree[code].val;
    }
    return -1;
  };

  // Fixed Huffman tables
  const fixedLit: number[] = [];
  for (let i = 0; i <= 143; i++) fixedLit.push(8);
  for (let i = 144; i <= 255; i++) fixedLit.push(9);
  for (let i = 256; i <= 279; i++) fixedLit.push(7);
  for (let i = 280; i <= 287; i++) fixedLit.push(8);
  const fixedDist: number[] = Array.from({ length: 32 }, () => 5);
  const clenOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  // Length base/extra for lit codes 257..285
  const lenBase = [
    3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
    35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258
  ];
  const lenExtra = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
    3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0
  ];
  // Distance base/extra
  const distBase = [
    1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
    257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385
  ];
  const distExtra = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
    7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13
  ];

  // Skip zlib header (CMF + FLG)
  if (data.length < 2) throw new Error('Invalid zlib data');
  p = 2;

  let lastBlock = false;
  while (!lastBlock) {
    const bfinal = readBits(1);
    const btype = readBits(2);
    if (btype === -1) break;
    if (bfinal) lastBlock = true;

    if (btype === 0) {
      // Stored
      if (bc >= 8) { const r = bc & 7; bb >>>= r; bc -= r; }
      const len = readByte() | (readByte() << 8);
      const nlen = readByte() | (readByte() << 8);
      if (len !== (nlen ^ 0xffff)) throw new Error('Invalid stored block');
      for (let i = 0; i < len; i++) { const b = readByte(); if (b === -1) break; out.push(b); }
    } else {
      let litTree: Record<number, { bits: number; val: number }>;
      let distTree: Record<number, { bits: number; val: number }>;

      if (btype === 1) {
        litTree = buildTree(fixedLit, 9);
        distTree = buildTree(fixedDist, 5);
      } else {
        // Dynamic Huffman
        const hlit = readBits(5) + 257;
        const hdist = readBits(5) + 1;
        const hclen = readBits(4) + 4;
        const clLens: number[] = Array.from({ length: 19 }, () => 0);
        for (let i = 0; i < hclen; i++) clLens[clenOrder[i]] = readBits(3);
        const clTree = buildTree(clLens, 3);

        const allLens: number[] = [];
        const total = hlit + hdist;
        while (allLens.length < total) {
          const s = decode(clTree);
          if (s === -1) break;
          if (s < 16) { allLens.push(s); }
          else if (s === 16) { const r = readBits(2) + 3; const v = allLens[allLens.length - 1] || 0; for (let i = 0; i < r; i++) allLens.push(v); }
          else if (s === 17) { const r = readBits(3) + 3; for (let i = 0; i < r; i++) allLens.push(0); }
          else if (s === 18) { const r = readBits(7) + 11; for (let i = 0; i < r; i++) allLens.push(0); }
        }

        litTree = buildTree(allLens.slice(0, hlit), 15);
        distTree = buildTree(allLens.slice(hlit), 15);
      }

      // Decode literals and back-references
      while (true) {
        const lit = decode(litTree);
        if (lit === -1 || lit === 256) break;
        if (lit < 256) { out.push(lit); continue; }

        const li = lit - 257;
        const len = lenBase[li] + readBits(lenExtra[li]);

        const di = decode(distTree);
        if (di === -1) break;
        const dist = distBase[di] + readBits(distExtra[di]);

        for (let i = 0; i < len; i++) {
          const idx = out.length - dist;
          out.push(idx >= 0 ? out[idx] : 0);
        }
      }
    }
  }

  return new Uint8Array(out);
}
