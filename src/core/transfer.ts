// Color transfer: builds a 3D LUT from (target stats, style, params), then applies it.
import { Space, srgbToLinear, linearToSrgb, toPerceptual, fromPerceptual, linearToOklab, oklabToLinear } from './color.js';
import { StyleData, TargetData } from './stats.js';

export type Method = 'reinhard' | 'histogram' | 'tone';

export interface Params {
  method: Method;
  space: Space;
  strength: number;      // 0..1 overall
  lumStrength: number;   // 0..1
  colorStrength: number; // 0..1
  preserveLuminance: boolean;
  saturation: number;    // 1 = unchanged
  contrast: number;      // 1 = unchanged
}

export const DEFAULT_PARAMS: Params = {
  method: 'reinhard', space: 'oklab', strength: 1, lumStrength: 1, colorStrength: 1,
  preserveLuminance: false, saturation: 1, contrast: 1,
};

/** Linear interpolation into an evenly sampled table over [0,1]. */
export function sampleTable(t: ArrayLike<number>, x: number): number {
  const f = Math.min(1, Math.max(0, x)) * (t.length - 1);
  const i = Math.floor(f);
  if (i >= t.length - 1) return t[t.length - 1];
  const w = f - i;
  return t[i] * (1 - w) + t[i + 1] * w;
}

/** CDF stored at bin centers i/(n-1); evaluate at continuous x in [0,1]. */
function evalCdf(cdf: Float32Array, x: number): number {
  return sampleTable(cdf, x);
}

const clampRatio = (r: number) => Math.min(5, Math.max(0.2, r));

/** Builds a function mapping one sRGB color (0..1) to the transferred sRGB color. */
export function makeMapper(target: TargetData, style: StyleData, p: Params) {
  const space = p.method === 'tone' ? 'oklab' : p.space;
  const fwd = toPerceptual(space), inv = fromPerceptual(space);
  const ts = space === 'oklab' ? target.style.oklab : target.style.lab;
  const ss = space === 'oklab' ? style.oklab : style.lab;
  const ratio = [0, 1, 2].map((c) => clampRatio(ss.std[c] / Math.max(1e-5, ts.std[c])));
  const kL = p.preserveLuminance ? 0 : p.strength * p.lumStrength;
  const kC = p.strength * p.colorStrength;
  // Contrast pivot: the luminance mean after blending.
  const pivot = ts.mean[0] + (ss.mean[0] - ts.mean[0]) * kL;
  const inP = [0, 0, 0], res = [0, 0, 0], lin = [0, 0, 0];

  return (r: number, g: number, b: number, out: number[]) => {
    fwd(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), inP);
    if (p.method === 'reinhard') {
      for (let c = 0; c < 3; c++) res[c] = (inP[c] - ts.mean[c]) * ratio[c] + ss.mean[c];
    } else if (p.method === 'histogram') {
      const r2 = sampleTable(style.rgbQ[0], evalCdf(target.rgbCdf[0], r));
      const g2 = sampleTable(style.rgbQ[1], evalCdf(target.rgbCdf[1], g));
      const b2 = sampleTable(style.rgbQ[2], evalCdf(target.rgbCdf[2], b));
      fwd(srgbToLinear(r2), srgbToLinear(g2), srgbToLinear(b2), res);
    } else {
      // Tone curve on L via quantile matching, Reinhard on chroma.
      res[0] = sampleTable(style.lQ, evalCdf(target.lCdf, inP[0]));
      for (let c = 1; c < 3; c++) res[c] = (inP[c] - ts.mean[c]) * ratio[c] + ss.mean[c];
    }
    let L = inP[0] + (res[0] - inP[0]) * kL;
    let A = inP[1] + (res[1] - inP[1]) * kC;
    let B = inP[2] + (res[2] - inP[2]) * kC;
    if (p.contrast !== 1) L = pivot + (L - pivot) * p.contrast;
    if (p.saturation !== 1) { A *= p.saturation; B *= p.saturation; }
    inv(L, A, B, lin);
    out[0] = linearToSrgb(Math.min(1, Math.max(0, lin[0])));
    out[1] = linearToSrgb(Math.min(1, Math.max(0, lin[1])));
    out[2] = linearToSrgb(Math.min(1, Math.max(0, lin[2])));
  };
}

/** Bakes the mapping onto an identity lattice. Layout: red fastest (matches .cube). */
export function bakeLut(map: (r: number, g: number, b: number, out: number[]) => void, size = 33): Float32Array {
  const lut = new Float32Array(size * size * size * 3);
  const o = [0, 0, 0];
  let i = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        map(r / (size - 1), g / (size - 1), b / (size - 1), o);
        lut[i++] = o[0]; lut[i++] = o[1]; lut[i++] = o[2];
      }
  return lut;
}

/** Applies a LUT to RGBA bytes in place using trilinear interpolation. */
export function applyLut(px: Uint8ClampedArray, lut: Float32Array, size: number): void {
  const s1 = size - 1, sz2 = size * size;
  const scale = s1 / 255;
  // Precompute per-byte index and weight.
  const idx = new Int32Array(256), wt = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    const f = v * scale;
    const i0 = Math.min(s1 - 1, Math.floor(f));
    idx[v] = i0; wt[v] = f - i0;
  }
  for (let p = 0; p < px.length; p += 4) {
    const r0 = idx[px[p]], g0 = idx[px[p + 1]], b0 = idx[px[p + 2]];
    const fr = wt[px[p]], fg = wt[px[p + 1]], fb = wt[px[p + 2]];
    const base = (b0 * sz2 + g0 * size + r0) * 3;
    const dr = 3, dg = size * 3, db = sz2 * 3;
    for (let c = 0; c < 3; c++) {
      const c000 = lut[base + c], c100 = lut[base + dr + c];
      const c010 = lut[base + dg + c], c110 = lut[base + dg + dr + c];
      const c001 = lut[base + db + c], c101 = lut[base + db + dr + c];
      const c011 = lut[base + db + dg + c], c111 = lut[base + db + dg + dr + c];
      const x00 = c000 + (c100 - c000) * fr, x10 = c010 + (c110 - c010) * fr;
      const x01 = c001 + (c101 - c001) * fr, x11 = c011 + (c111 - c011) * fr;
      const y0 = x00 + (x10 - x00) * fg, y1 = x01 + (x11 - x01) * fg;
      px[p + c] = (y0 + (y1 - y0) * fb) * 255; // clamped array rounds
    }
  }
}

export function lutToCube(lut: Float32Array, size: number, title: string): string {
  const lines = [`TITLE "${title.replace(/"/g, "'")}"`, `# Created with Snap Lens`, `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  for (let i = 0; i < lut.length; i += 3) lines.push(`${lut[i].toFixed(6)} ${lut[i + 1].toFixed(6)} ${lut[i + 2].toFixed(6)}`);
  return lines.join('\n') + '\n';
}

export function parseCube(text: string): { size: number; lut: Float32Array } {
  let size = 0; const vals: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('TITLE') || line.startsWith('DOMAIN')) continue;
    if (line.startsWith('LUT_3D_SIZE')) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
    for (const v of line.split(/\s+/)) vals.push(parseFloat(v));
  }
  if (!size || vals.length !== size ** 3 * 3) throw new Error('Invalid .cube file');
  return { size, lut: new Float32Array(vals) };
}

/** Lab/Oklab helper used by the self-check. */
export function oklabRoundTrip(r: number, g: number, b: number): number[] {
  const o = [0, 0, 0], l = [0, 0, 0];
  linearToOklab(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b), o);
  oklabToLinear(o[0], o[1], o[2], l);
  return l.map(linearToSrgb);
}
