/**
 * Color palette extraction from raw RGB pixel data.
 * Uses k-means++ clustering, HSL analysis, role assignment.
 */

export interface PaletteColor {
  hex: string;
  r: number;
  g: number;
  b: number;
}

export interface PaletteEntry {
  color: PaletteColor;
  role: string;
  percentage: number;
  population: number;
}

export interface PaletteResult {
  image: { width: number; height: number };
  palette: PaletteEntry[];
  processingTimeMs: number;
  timestamp: string;
}

// ─── Color space conversions ──────────────────────────────

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

function colorDist(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

// ─── K-means++ clustering ────────────────────────────────

function kmeans(pixels: [number, number, number][], k: number): { center: [number, number, number]; count: number }[] {
  if (pixels.length === 0) return [];
  if (pixels.length <= k) {
    return pixels.map(p => ({ center: p, count: 1 }));
  }

  // Init with k-means++
  const centers: [number, number, number][] = [];
  centers.push([...pixels[Math.floor(Math.random() * pixels.length)]]);

  for (let i = 1; i < k; i++) {
    let maxDist = -1;
    let best = pixels[0];
    // Sample subset for efficiency
    const sample = pixels.filter(() => Math.random() < 0.15 || pixels.length <= 200);
    for (const px of sample) {
      let minD = Infinity;
      for (const c of centers) {
        const d = colorDist(px, c);
        if (d < minD) minD = d;
      }
      if (minD > maxDist) { maxDist = minD; best = px; }
    }
    centers.push([...best]);
  }

  // Iterate
  let assignments = new Int16Array(pixels.length);
  for (let iter = 0; iter < 20; iter++) {
    let changed = false;
    for (let i = 0; i < pixels.length; i++) {
      let minD = Infinity, bestC = 0;
      for (let c = 0; c < centers.length; c++) {
        const d = colorDist(pixels[i], centers[c]);
        if (d < minD) { minD = d; bestC = c; }
      }
      if (assignments[i] !== bestC) { changed = true; assignments[i] = bestC; }
    }
    if (!changed) break;

    const sums: [number, number, number][] = centers.map(() => [0, 0, 0]);
    const counts: number[] = Array.from({ length: k }, () => 0);
    for (let i = 0; i < pixels.length; i++) {
      const c = assignments[i];
      sums[c][0] += pixels[i][0]; sums[c][1] += pixels[i][1]; sums[c][2] += pixels[i][2];
      counts[c]++;
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      centers[c] = [
        Math.round(sums[c][0] / counts[c]),
        Math.round(sums[c][1] / counts[c]),
        Math.round(sums[c][2] / counts[c]),
      ];
    }
  }

  const counts: number[] = Array.from({ length: k }, () => 0);
  for (let i = 0; i < pixels.length; i++) counts[assignments[i]]++;

  return centers.map((c, i) => ({ center: c, count: counts[i] })).filter(c => c.count > 0);
}

// ─── Role assignment ─────────────────────────────────────

function assignRole(h: number, s: number, l: number, pop: number, totalPx: number, avgSat: number): string {
  const isGray = avgSat < 0.05;
  const pct = pop / totalPx;

  if (isGray || s < 0.08) {
    if (l > 0.85) return 'background';
    if (l < 0.15) return 'text';
    return 'neutral';
  }
  if (l > 0.9 || (pct > 0.35 && l > 0.75)) return 'background';
  if (pct < 0.03) return 'accent';
  if (l < 0.2) return 'text';
  if (s > 0.6) return 'primary';
  return 'secondary';
}

// ─── Main extraction ─────────────────────────────────────

export function extractPalette(
  pixels: Uint8Array,
  width: number,
  height: number,
  numColors = 8
): PaletteResult {
  const totalPx = width * height;

  // Sample pixels for speed
  let sampled: [number, number, number][] = [];
  if (totalPx <= 10000) {
    for (let i = 0; i < totalPx; i++) {
      sampled.push([pixels[i * 3], pixels[i * 3 + 1], pixels[i * 3 + 2]]);
    }
  } else {
    const step = totalPx / 10000;
    for (let i = 0; i < totalPx; i += step) {
      const idx = Math.floor(i) * 3;
      sampled.push([pixels[idx], pixels[idx + 1], pixels[idx + 2]]);
    }
  }

  // Average saturation for grayscale detection
  let totalSat = 0;
  for (const px of sampled) {
    const [, s] = rgbToHsl(px[0], px[1], px[2]);
    totalSat += s;
  }
  const avgSat = totalSat / sampled.length;

  // Cluster
  const k = Math.min(numColors, sampled.length);
  const clusters = kmeans(sampled, k);

  // Sort by population desc, filter tiny clusters (< 0.5% of sampled pixels)
  clusters.sort((a, b) => b.count - a.count);
  const minPop = sampled.length * 0.005;
  const filtered = clusters.filter(c => c.count >= minPop);

  // Build palette
  const palette: PaletteEntry[] = filtered.map(c => {
    const [r, g, b] = c.center;
    const [h, s, l] = rgbToHsl(r, g, b);
    const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    return {
      color: { hex, r, g, b },
      role: assignRole(h, s, l, c.count, totalPx, avgSat),
      percentage: Math.round((c.count / sampled.length) * 1000) / 10,
      population: c.count,
    };
  });

  return {
    image: { width, height },
    palette,
    processingTimeMs: 0, // caller fills this
    timestamp: new Date().toISOString(),
  };
}
