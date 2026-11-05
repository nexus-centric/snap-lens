// CPU reference implementation of all color-only (per-pixel) operations.
// It is baked into a 3D LUT that the WebGL renderer applies, used for .cube export,
// for style fitting, and for tests. Spatial effects (clarity, sharpening, vignette...) live in the shader.
import { srgbToLinear, linearToSrgb, linearToOklab, oklabToLinear } from './color.js';
import type { TargetData } from './stats.js';
import { makeMapper, DEFAULT_PARAMS } from './transfer.js';
import type { Settings, CurvePoints } from './settings.js';

export type ColorFn = (r: number, g: number, b: number, out: number[]) => void;

/** Oklab hue angles (degrees) of the 8 HSL bands. */
export const BAND_HUES = [29, 55, 105, 142, 195, 255, 295, 330];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** Monotone cubic (Fritsch-Carlson) curve sampled into a table over [0,1]. */
export function curveTable(points: CurvePoints, n = 1024): Float32Array {
  const pts = [...points].map(([x, y]) => [clamp01(x), clamp01(y)] as [number, number]).sort((a, b) => a[0] - b[0]);
  const t = new Float32Array(n);
  if (pts.length < 2) { for (let i = 0; i < n; i++) t[i] = i / (n - 1); return t; }
  const k = pts.length;
  const d: number[] = [], m: number[] = [];
  for (let i = 0; i < k - 1; i++) d.push((pts[i + 1][1] - pts[i][1]) / Math.max(1e-6, pts[i + 1][0] - pts[i][0]));
  m.push(d[0]);
  for (let i = 1; i < k - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[k - 2]);
  for (let i = 0; i < k - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const tau = 3 / Math.sqrt(s); m[i] = tau * a * d[i]; m[i + 1] = tau * b * d[i]; }
  }
  let seg = 0;
  for (let j = 0; j < n; j++) {
    const x = j / (n - 1);
    if (x <= pts[0][0]) { t[j] = pts[0][1]; continue; }
    if (x >= pts[k - 1][0]) { t[j] = pts[k - 1][1]; continue; }
    while (seg < k - 2 && x > pts[seg + 1][0]) seg++;
    const [x0, y0] = pts[seg], [x1, y1] = pts[seg + 1];
    const h = x1 - x0, s = (x - x0) / h;
    const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s, h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
    t[j] = clamp01(h00 * y0 + h10 * h * m[seg] + h01 * y1 + h11 * h * m[seg + 1]);
  }
  return t;
}

const isIdentityCurve = (p: CurvePoints) => p.every(([x, y]) => Math.abs(x - y) < 1e-6);

function lookup(t: Float32Array, x: number): number {
  const f = clamp01(x) * (t.length - 1), i = Math.min(t.length - 2, Math.floor(f)), w = f - i;
  return t[i] + (t[i + 1] - t[i]) * w;
}

/** Global tone function on display-encoded luminance x in [0,1]. Identity when all inputs are 0. */
export function toneFn(s: Pick<Settings, 'contrast' | 'highlights' | 'shadows' | 'whites' | 'blacks'>) {
  const bp = (-s.blacks / 100) * 0.12, wp = 1 - (s.whites / 100) * 0.12;
  const sh = (s.shadows / 100) * 0.14, hi = (s.highlights / 100) * 0.14;
  const g = Math.exp((s.contrast / 100) * 0.9);
  return (x: number) => {
    x = clamp01((x - bp) / (wp - bp));
    x += sh * 6.75 * x * (1 - x) * (1 - x) + hi * 6.75 * x * x * (1 - x);
    x = clamp01(x);
    if (g !== 1) x = x < 0.5 ? 0.5 * Math.pow(2 * x, g) : 1 - 0.5 * Math.pow(2 - 2 * x, g);
    return x;
  };
}

/** Partition-of-unity weights of a hue (degrees) over the 8 bands. */
export function bandWeights(h: number, w: number[]): void {
  w.fill(0);
  h = ((h % 360) + 360) % 360;
  for (let i = 0; i < 8; i++) {
    const a = BAND_HUES[i], b = BAND_HUES[(i + 1) % 8];
    const span = ((b - a + 360) % 360) || 360;
    const off = (h - a + 360) % 360;
    if (off <= span) { const t = off / span; w[i] = 1 - t; w[(i + 1) % 8] = t; return; }
  }
}

/** Shadow / midtone / highlight weights for Oklab lightness. */
export function gradingWeights(L: number, blending: number, balance: number): [number, number, number] {
  const width = 0.15 + 0.35 * (blending / 100);
  const c = 0.5 - (balance / 100) * 0.25;
  const ws = 1 - smoothstep(c - width, c, L);
  const wh = smoothstep(c, c + width, L);
  return [ws, Math.max(0, 1 - ws - wh), wh];
}

export function wbGains(temp: number, tint: number): [number, number, number] {
  const gr = Math.exp(temp * 0.0035), gb = Math.exp(-temp * 0.0035), gg = Math.exp(-tint * 0.003);
  const norm = 0.2126 * gr + 0.7152 * gg + 0.0722 * gb;
  return [gr / norm, gg / norm, gb / norm];
}

/** Builds the color function for a settings object. target is needed only for statistical copy. */
export function buildColorFn(s: Settings, target: TargetData | null): ColorFn {
  const copy = s.copy && target
    ? makeMapper(target, s.copy.style, {
      ...DEFAULT_PARAMS, method: s.copy.method, space: s.copy.space, strength: s.copy.strength / 100,
      lumStrength: s.copy.lumStrength / 100, colorStrength: s.copy.colorStrength / 100,
    })
    : null;
  const [gr, gg, gb] = wbGains(s.temp, s.tint);
  const ex = Math.pow(2, s.exposure);
  const toneNeutral = !s.contrast && !s.highlights && !s.shadows && !s.whites && !s.blacks;
  const tone = toneFn(s);
  const toneT = new Float32Array(1025);
  for (let i = 0; i <= 1024; i++) toneT[i] = srgbToLinear(tone(i / 1024));
  const sat = 1 + s.saturation / 100, vib = s.vibrance / 100;
  const hslOn = [...s.hsl.hue, ...s.hsl.sat, ...s.hsl.lum].some((v) => v !== 0);
  const G = s.grading;
  const wheelAB = [G.shadows, G.midtones, G.highlights].map((w) => [
    (w.s / 100) * 0.08 * Math.cos((w.h * Math.PI) / 180), (w.s / 100) * 0.08 * Math.sin((w.h * Math.PI) / 180), (w.l / 100) * 0.1]);
  const gradeOn = wheelAB.some((v) => v[0] || v[1] || v[2]);
  const curves = (['rgb', 'r', 'g', 'b'] as const).map((k) => (isIdentityCurve(s.curve[k]) ? null : curveTable(s.curve[k])));
  const lin = [0, 0, 0], lab = [0, 0, 0], bw = new Array(8).fill(0), tmp = [0, 0, 0];

  return (r, g, b, out) => {
    if (copy) { copy(r, g, b, tmp); r = tmp[0]; g = tmp[1]; b = tmp[2]; }
    let R = srgbToLinear(r) * gr * ex, Gc = srgbToLinear(g) * gg * ex, B = srgbToLinear(b) * gb * ex;
    // Tone: operate on luminance, keep hue by scaling RGB.
    if (!toneNeutral || ex !== 1 || gr !== 1) {
      const Y = 0.2126 * R + 0.7152 * Gc + 0.0722 * B;
      if (!toneNeutral && Y > 1e-6) {
        const Yn = lookup(toneT, linearToSrgb(Math.min(1, Y)));
        const k = Yn / Y;
        R *= k; Gc *= k; B *= k;
      }
      // Soft gamut compression toward luminance when a channel exceeds 1.
      const mx = Math.max(R, Gc, B);
      if (mx > 1) {
        const Y2 = Math.min(1, 0.2126 * R + 0.7152 * Gc + 0.0722 * B);
        const t = (1 - Y2) / Math.max(1e-6, mx - Y2);
        R = Y2 + (R - Y2) * t; Gc = Y2 + (Gc - Y2) * t; B = Y2 + (B - Y2) * t;
      }
    }
    if (sat !== 1 || vib !== 0 || hslOn || gradeOn) {
      linearToOklab(Math.max(0, R), Math.max(0, Gc), Math.max(0, B), lab);
      let L = lab[0], A = lab[1], Bb = lab[2];
      let C = Math.hypot(A, Bb), h = (Math.atan2(Bb, A) * 180) / Math.PI;
      if (hslOn && C > 1e-5) {
        bandWeights(h, bw);
        let dh = 0, ds = 0, dl = 0;
        for (let i = 0; i < 8; i++) { dh += bw[i] * s.hsl.hue[i]; ds += bw[i] * s.hsl.sat[i]; dl += bw[i] * s.hsl.lum[i]; }
        const gate = smoothstep(0, 0.04, C);
        h += (dh / 100) * 30 * gate;
        C *= Math.max(0, 1 + (ds / 100) * gate);
        L += (dl / 100) * 0.2 * gate * Math.min(1, C / 0.08);
      }
      if (vib !== 0) C *= Math.max(0, 1 + vib * (1 - Math.min(1, C / 0.2)));
      C *= Math.max(0, sat);
      A = C * Math.cos((h * Math.PI) / 180); Bb = C * Math.sin((h * Math.PI) / 180);
      if (gradeOn) {
        const w = gradingWeights(L, G.blending, G.balance);
        for (let i = 0; i < 3; i++) { A += w[i] * wheelAB[i][0]; Bb += w[i] * wheelAB[i][1]; L += w[i] * wheelAB[i][2]; }
      }
      oklabToLinear(L, A, Bb, lin);
      R = lin[0]; Gc = lin[1]; B = lin[2];
    }
    let or = linearToSrgb(clamp01(R)), og = linearToSrgb(clamp01(Gc)), ob = linearToSrgb(clamp01(B));
    if (curves[0]) { or = lookup(curves[0], or); og = lookup(curves[0], og); ob = lookup(curves[0], ob); }
    if (curves[1]) or = lookup(curves[1], or);
    if (curves[2]) og = lookup(curves[2], og);
    if (curves[3]) ob = lookup(curves[3], ob);
    out[0] = or; out[1] = og; out[2] = ob;
  };
}

/** Bakes a color function into an RGB float LUT, red fastest (same layout as .cube). */
export function bakeColorLut(fn: ColorFn, size: number): Float32Array {
  const lut = new Float32Array(size * size * size * 3);
  const o = [0, 0, 0];
  let i = 0;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    fn(r / (size - 1), g / (size - 1), b / (size - 1), o);
    lut[i++] = o[0]; lut[i++] = o[1]; lut[i++] = o[2];
  }
  return lut;
}
