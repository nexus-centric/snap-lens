// Style extraction: perceptual mean/std, per-channel quantiles, palette.
import { SRGB8_TO_LINEAR, linearToOklab, linearToLab, oklabToLinear, linearToSrgb, hex } from './color.js';

export const QUANTILES = 129; // number of stored quantile points per channel

export interface ChannelStats { mean: number[]; std: number[] }

export interface StyleData {
  version: 1;
  name: string;
  createdAt: string;
  sources: number;          // number of reference images
  oklab: ChannelStats;
  lab: ChannelStats;
  // Quantiles (p = i/(QUANTILES-1)) of sRGB R,G,B in [0,1] and of Oklab L.
  rgbQ: number[][];
  lQ: number[];
  palette: { hex: string; weight: number }[];
}

/** RGBA bytes -> stats. Pixels with alpha < 8 are ignored. */
export function analyze(pixels: Uint8ClampedArray | Uint8Array, name = 'Style', sources = 1, k = 6): StyleData {
  const n = pixels.length >> 2;
  const ok = new Float32Array(n * 3);
  const lab = new Float32Array(n * 3);
  const hists = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const lHist = new Uint32Array(1024);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (pixels[p + 3] < 8) continue;
    const R = pixels[p], G = pixels[p + 1], B = pixels[p + 2];
    hists[0][R]++; hists[1][G]++; hists[2][B]++;
    const r = SRGB8_TO_LINEAR[R], g = SRGB8_TO_LINEAR[G], b = SRGB8_TO_LINEAR[B];
    linearToOklab(r, g, b, ok, count * 3);
    linearToLab(r, g, b, lab, count * 3);
    lHist[Math.min(1023, Math.max(0, Math.round(ok[count * 3] * 1023)))]++;
    count++;
  }
  if (count === 0) throw new Error('Image has no opaque pixels');
  const okv = ok.subarray(0, count * 3), labv = lab.subarray(0, count * 3);
  return {
    version: 1,
    name,
    createdAt: new Date().toISOString(),
    sources,
    oklab: meanStd(okv, count),
    lab: meanStd(labv, count),
    rgbQ: hists.map((h) => quantilesFromHist(h, count, 255)),
    lQ: quantilesFromHist(lHist, count, 1023),
    palette: kmeansPalette(okv, count, k),
  };
}

export function meanStd(v: Float32Array, count: number): ChannelStats {
  const mean = [0, 0, 0], sq = [0, 0, 0];
  for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++) mean[c] += v[i * 3 + c];
  for (let c = 0; c < 3; c++) mean[c] /= count;
  for (let i = 0; i < count; i++) for (let c = 0; c < 3; c++) { const d = v[i * 3 + c] - mean[c]; sq[c] += d * d; }
  return { mean, std: sq.map((s) => Math.sqrt(s / count)) };
}

/** Value at evenly spaced probabilities from a histogram, with linear interpolation inside bins. */
export function quantilesFromHist(h: Uint32Array, total: number, maxBin: number): number[] {
  const out: number[] = [];
  let bin = 0, cum = 0;
  for (let q = 0; q < QUANTILES; q++) {
    const target = (q / (QUANTILES - 1)) * total;
    while (bin < h.length - 1 && cum + h[bin] < target) { cum += h[bin]; bin++; }
    const frac = h[bin] > 0 ? Math.min(1, Math.max(0, (target - cum) / h[bin])) : 0.5;
    out.push(Math.min(1, Math.max(0, (bin - 0.5 + frac) / maxBin)));
  }
  out[0] = Math.max(0, out[0]);
  return out;
}

/** CDF of a channel evaluated at 256 (or N) bin centers, as fractions in [0,1]. */
export function cdfFromHist(h: Uint32Array, total: number): Float32Array {
  const cdf = new Float32Array(h.length);
  let cum = 0;
  for (let i = 0; i < h.length; i++) { cdf[i] = (cum + h[i] / 2) / total; cum += h[i]; }
  return cdf;
}

// Deterministic PRNG so palettes are stable across runs.
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** k-means (k-means++ init) on Oklab samples; returns swatches sorted by weight. */
export function kmeansPalette(ok: Float32Array, count: number, k: number): { hex: string; weight: number }[] {
  const rand = mulberry32(1234);
  const maxS = 6000;
  const step = Math.max(1, Math.floor(count / maxS));
  const s: number[] = [];
  for (let i = 0; i < count; i += step) s.push(ok[i * 3], ok[i * 3 + 1] * 2, ok[i * 3 + 2] * 2); // weight chroma a bit
  const m = s.length / 3;
  k = Math.min(k, m);
  const cent: number[] = [];
  const d2 = new Float64Array(m).fill(Infinity);
  let first = Math.floor(rand() * m);
  cent.push(s[first * 3], s[first * 3 + 1], s[first * 3 + 2]);
  for (let c = 1; c < k; c++) {
    let sum = 0;
    const ci = (c - 1) * 3;
    for (let i = 0; i < m; i++) {
      const dx = s[i * 3] - cent[ci], dy = s[i * 3 + 1] - cent[ci + 1], dz = s[i * 3 + 2] - cent[ci + 2];
      d2[i] = Math.min(d2[i], dx * dx + dy * dy + dz * dz);
      sum += d2[i];
    }
    let r = rand() * sum, pick = 0;
    for (let i = 0; i < m; i++) { r -= d2[i]; if (r <= 0) { pick = i; break; } }
    cent.push(s[pick * 3], s[pick * 3 + 1], s[pick * 3 + 2]);
  }
  const assign = new Int32Array(m);
  const sizes = new Array(k).fill(0);
  for (let iter = 0; iter < 20; iter++) {
    const acc = new Array(k * 3).fill(0);
    sizes.fill(0);
    for (let i = 0; i < m; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const dx = s[i * 3] - cent[c * 3], dy = s[i * 3 + 1] - cent[c * 3 + 1], dz = s[i * 3 + 2] - cent[c * 3 + 2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bd) { bd = d; best = c; }
      }
      assign[i] = best; sizes[best]++;
      acc[best * 3] += s[i * 3]; acc[best * 3 + 1] += s[i * 3 + 1]; acc[best * 3 + 2] += s[i * 3 + 2];
    }
    for (let c = 0; c < k; c++) if (sizes[c] > 0) for (let j = 0; j < 3; j++) cent[c * 3 + j] = acc[c * 3 + j] / sizes[c];
  }
  const rgb = [0, 0, 0];
  const out = [];
  for (let c = 0; c < k; c++) {
    if (!sizes[c]) continue;
    oklabToLinear(cent[c * 3], cent[c * 3 + 1] / 2, cent[c * 3 + 2] / 2, rgb);
    out.push({ hex: hex(linearToSrgb(rgb[0]), linearToSrgb(rgb[1]), linearToSrgb(rgb[2])), weight: sizes[c] / m });
  }
  return out.sort((a, b) => b.weight - a.weight);
}

/** Per-image data needed to map a target: its stats plus its own CDFs. */
export interface TargetData {
  style: StyleData;
  rgbCdf: Float32Array[]; // 256 entries each
  lCdf: Float32Array;     // 1024 entries
}

export function analyzeTarget(pixels: Uint8ClampedArray | Uint8Array): TargetData {
  const style = analyze(pixels, 'target', 1, 1);
  const n = pixels.length >> 2;
  const hists = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const lHist = new Uint32Array(1024);
  const tmp = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    if (pixels[p + 3] < 8) continue;
    hists[0][pixels[p]]++; hists[1][pixels[p + 1]]++; hists[2][pixels[p + 2]]++;
    linearToOklab(SRGB8_TO_LINEAR[pixels[p]], SRGB8_TO_LINEAR[pixels[p + 1]], SRGB8_TO_LINEAR[pixels[p + 2]], tmp);
    lHist[Math.min(1023, Math.max(0, Math.round(tmp[0] * 1023)))]++;
    count++;
  }
  return { style, rgbCdf: hists.map((h) => cdfFromHist(h, count)), lCdf: cdfFromHist(lHist, count) };
}
