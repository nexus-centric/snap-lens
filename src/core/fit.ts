// "Copy style": measures a reference look and fits editable develop settings
// (white balance, tone, saturation, HSL bands, split toning, vignette, grain)
// so that the target photo's statistics move toward the reference. No ML: plain
// statistics plus 1-D bisection through the same CPU color pipeline used for rendering.
import { SRGB8_TO_LINEAR, linearToOklab, srgbToLinear } from './color.js';
import { linearToSrgb } from './color.js';
import { buildColorFn, bandWeights } from './develop.js';
import { defaultSettings, clone, HSL_BANDS, Settings, CurvePoints } from './settings.js';

export interface Features {
  Lq: number[];        // Oklab L quantiles at QP
  cast: [number, number]; // mean a, b of low-chroma pixels
  castFromNeutrals: boolean;
  mean: [number, number]; // mean a, b of all pixels
  Cq: number[];        // chroma quantiles at 0.5, 0.9
  shadowAB: [number, number]; highlightAB: [number, number]; // mean a, b of low-chroma shadows / highlights (NaN if too few)
  bands: { w: number; h: number; C: number; L: number }[];
}
export interface SpatialFeatures { vignette: number; noise: number }

export const QP = [0.02, 0.15, 0.5, 0.85, 0.98, 0.05, 0.25, 0.75, 0.95, 0.2, 0.8];

/** Float sRGB samples (r, g, b triplets) from RGBA bytes, at most maxN pixels. */
export function samplePixels(px: Uint8ClampedArray | Uint8Array, maxN = 4096): Float32Array {
  const n = px.length >> 2, step = Math.max(1, Math.floor(n / maxN));
  const out: number[] = [];
  for (let i = 0; i < n; i += step) if (px[i * 4 + 3] > 8) out.push(px[i * 4] / 255, px[i * 4 + 1] / 255, px[i * 4 + 2] / 255);
  return new Float32Array(out);
}

function quantile(sorted: Float32Array, p: number) {
  const f = p * (sorted.length - 1), i = Math.floor(f), w = f - i;
  return i + 1 < sorted.length ? sorted[i] * (1 - w) + sorted[i + 1] * w : sorted[i];
}

/** Pixel masks fixed from the unedited image so measurements stay monotone while sliders move. */
export interface Masks { neutral: Uint8Array; shadow: Uint8Array; highlight: Uint8Array }

export function makeMasks(rgb: Float32Array): Masks {
  const n = rgb.length / 3, o = [0, 0, 0];
  const L = new Float32Array(n), C = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    linearToOklab(srgbToLinear(rgb[i * 3]), srgbToLinear(rgb[i * 3 + 1]), srgbToLinear(rgb[i * 3 + 2]), o);
    L[i] = o[0]; C[i] = Math.hypot(o[1], o[2]);
  }
  const Ls = L.slice().sort(), q25 = quantile(Ls, 0.25), q75 = quantile(Ls, 0.75);
  const neutral = new Uint8Array(n), shadow = new Uint8Array(n), highlight = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    neutral[i] = C[i] < 0.035 ? 1 : 0;
    shadow[i] = C[i] < 0.07 && L[i] <= q25 ? 1 : 0;
    highlight[i] = C[i] < 0.07 && L[i] >= q75 ? 1 : 0;
  }
  return { neutral, shadow, highlight };
}

export function measure(rgb: Float32Array, masks: Masks = makeMasks(rgb)): Features {
  const n = rgb.length / 3;
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n), C = new Float32Array(n), H = new Float32Array(n);
  const o = [0, 0, 0];
  let ca = 0, cb = 0, cn = 0, ma = 0, mb = 0;
  for (let i = 0; i < n; i++) {
    linearToOklab(srgbToLinear(rgb[i * 3]), srgbToLinear(rgb[i * 3 + 1]), srgbToLinear(rgb[i * 3 + 2]), o);
    L[i] = o[0]; A[i] = o[1]; B[i] = o[2]; C[i] = Math.hypot(o[1], o[2]); H[i] = (Math.atan2(o[2], o[1]) * 180) / Math.PI;
    ma += o[1]; mb += o[2];
    if (masks.neutral[i]) { ca += o[1]; cb += o[2]; cn++; }
  }
  ma /= n; mb /= n;
  const Ls = L.slice().sort(), Cs = C.slice().sort();
  let sa = 0, sb = 0, sn = 0, ha = 0, hb = 0, hn = 0;
  const bands = HSL_BANDS.map(() => ({ w: 0, h: 0, C: 0, L: 0, hx: 0, hy: 0 }));
  const bw = new Array(8).fill(0);
  for (let i = 0; i < n; i++) {
    // Split toning is judged on low-chroma pixels only, so scene content (green grass, blue sky) does not count as a tint.
    if (masks.shadow[i]) { sa += A[i]; sb += B[i]; sn++; }
    if (masks.highlight[i]) { ha += A[i]; hb += B[i]; hn++; }
    if (C[i] > 0.03) {
      bandWeights(H[i], bw);
      for (let k = 0; k < 8; k++) if (bw[k] > 0) {
        const w = bw[k], bd = bands[k];
        bd.w += w; bd.C += w * C[i]; bd.L += w * L[i];
        bd.hx += w * Math.cos((H[i] * Math.PI) / 180); bd.hy += w * Math.sin((H[i] * Math.PI) / 180);
      }
    }
  }
  return {
    Lq: QP.map((p) => quantile(Ls, p)),
    cast: cn > n * 0.03 ? [ca / cn, cb / cn] : [ma, mb],
    castFromNeutrals: cn > n * 0.03,
    mean: [ma, mb],
    Cq: [quantile(Cs, 0.5), quantile(Cs, 0.9)],
    shadowAB: sn > n * 0.02 ? [sa / sn, sb / sn] : [NaN, NaN],
    highlightAB: hn > n * 0.02 ? [ha / hn, hb / hn] : [NaN, NaN],
    bands: bands.map((b) => ({ w: b.w / n, h: (Math.atan2(b.hy, b.hx) * 180) / Math.PI, C: b.w ? b.C / b.w : 0, L: b.w ? b.L / b.w : 0 })),
  };
}

/** Vignette (corner vs center lightness) and fine noise level, from RGBA bytes. */
export function measureSpatial(px: Uint8ClampedArray | Uint8Array, w: number, h: number): SpatialFeatures {
  const o = [0, 0, 0];
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    linearToOklab(SRGB8_TO_LINEAR[px[i * 4]], SRGB8_TO_LINEAR[px[i * 4 + 1]], SRGB8_TO_LINEAR[px[i * 4 + 2]], o);
    L[i] = o[0];
  }
  let cs = 0, cn = 0, es = 0, en = 0;
  const res: number[] = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const dx = (x / w - 0.5) * 2, dy = (y / h - 0.5) * 2, r = Math.hypot(dx, dy) / Math.SQRT2;
    const v = L[y * w + x];
    if (r < 0.35) { cs += v; cn++; } else if (r > 0.85) { es += v; en++; }
    if ((x + y) % 3 === 0) {
      const m = (L[y * w + x - 1] + L[y * w + x + 1] + L[(y - 1) * w + x] + L[(y + 1) * w + x]) / 4;
      res.push(Math.abs(v - m));
    }
  }
  res.sort((a, b) => a - b);
  // The 30th percentile of the residual ignores edges and mostly measures noise or grain.
  return { vignette: en && cn ? es / en - cs / cn : 0, noise: res.length ? res[Math.floor(res.length * 0.3)] : 0 };
}

export type Aspect = 'tone' | 'color' | 'split' | 'effects';
export const ASPECT_KEYS: Record<Aspect, (keyof Settings)[]> = {
  tone: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'curve'],
  color: ['temp', 'tint', 'vibrance', 'saturation', 'hsl'],
  split: ['grading'],
  effects: ['vignette', 'grain', 'grainSize'],
};

export interface FitResult { look: Partial<Settings>; report: { aspect: Aspect; text: string }[]; ms: number }

const clampV = (v: number, lo = -100, hi = 100) => Math.max(lo, Math.min(hi, v));

/** Solve one scalar so that measure(settings) hits goal; f must be monotone in the parameter. */
function bisect(lo: number, hi: number, iters: number, f: (x: number) => number, goal: number): number {
  let flo = f(lo) - goal, fhi = f(hi) - goal;
  if (flo * fhi > 0) return Math.abs(flo) < Math.abs(fhi) ? lo : hi;
  for (let i = 0; i < iters; i++) {
    const mid = (lo + hi) / 2, fm = f(mid) - goal;
    if (fm * flo <= 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

function apply(s: Settings, rgb: Float32Array): Float32Array {
  const fn = buildColorFn(s, null), out = new Float32Array(rgb.length), o = [0, 0, 0];
  for (let i = 0; i < rgb.length; i += 3) { fn(rgb[i], rgb[i + 1], rgb[i + 2], o); out[i] = o[0]; out[i + 1] = o[1]; out[i + 2] = o[2]; }
  return out;
}

const HUE_NAMES: [number, string][] = [[29, 'red'], [55, 'orange'], [90, 'gold'], [110, 'yellow'], [142, 'green'], [175, 'teal'], [210, 'cyan'], [255, 'blue'], [295, 'purple'], [330, 'magenta']];
export function hueName(h: number): string {
  h = ((h % 360) + 360) % 360;
  let best = HUE_NAMES[0][1], bd = 999;
  for (const [c, n] of HUE_NAMES) { const d = Math.min(Math.abs(h - c), 360 - Math.abs(h - c)); if (d < bd) { bd = d; best = n; } }
  return best;
}

/**
 * Fit a look. ref/target are sRGB float samples; spatial features are optional.
 * Returns only the settings keys touched by the fit (see ASPECT_KEYS).
 */
export function fitLook(ref: Float32Array, target: Float32Array, refSp?: SpatialFeatures, tgtSp?: SpatialFeatures): FitResult {
  const t0 = Date.now();
  const R = measure(ref);
  const s = defaultSettings();
  const tMasks = makeMasks(target);
  const m = (st: Settings) => measure(apply(st, target), tMasks);
  const report: FitResult['report'] = [];
  const I = 9;

  // 1. White balance cast (two alternating rounds; temperature mostly moves b, tint mostly a).
  const neutralRef = !!R.castFromNeutrals;
  for (let round = 0; round < 2; round++) {
    if (!neutralRef) break;
    s.temp = bisect(-40, 40, I, (v) => m({ ...s, temp: v }).cast[1], R.cast[1]);
    s.tint = bisect(-40, 40, I, (v) => -m({ ...s, tint: v }).cast[0], -R.cast[0]);
  }
  // 2. Tone. Scenes differ in content, so slider ranges are limited and the residual curve is damped;
  // this copies the tonal character without forcing the exact histogram.
  for (let round = 0; round < 2; round++) {
    s.exposure = bisect(-1.5, 1.5, I, (v) => m({ ...s, exposure: v }).Lq[2], R.Lq[2]);
    // Contrast targets the 15-85 percent spread; shadows and highlights are left to the residual curve
    // because they act on nearly the same quantiles and would fight contrast.
    s.contrast = bisect(-50, 50, I, (v) => { const f = m({ ...s, contrast: v }); return f.Lq[3] - f.Lq[1]; }, R.Lq[3] - R.Lq[1]);
    s.blacks = bisect(-40, 40, I, (v) => m({ ...s, blacks: v }).Lq[0], R.Lq[0]);
    s.whites = bisect(-40, 40, I, (v) => m({ ...s, whites: v }).Lq[4], R.Lq[4]);
  }
  {
    const f = m(s);
    const enc = (L: number) => linearToSrgb(Math.max(0, Math.min(1, L * L * L)));
    const pts: CurvePoints = [[0, 0]];
    for (const qi of [5, 6, 2, 7, 8]) {
      const x = enc(f.Lq[qi]), y = x + (enc(R.Lq[qi]) - x) * 0.5;
      if (x > pts[pts.length - 1][0] + 0.04 && x < 0.97) pts.push([x, Math.max(pts[pts.length - 1][1], y)]);
    }
    pts.push([1, 1]);
    const maxDev = Math.max(...pts.map(([x, y]) => Math.abs(x - y)));
    if (maxDev > 0.012) s.curve = { ...s.curve, rgb: pts.map(([x, y]) => [+x.toFixed(4), +y.toFixed(4)]) as CurvePoints };
  }
  // 3. Saturation level: saturation matches strong colors, vibrance matches typical colors.
  for (let round = 0; round < 2; round++) {
    s.saturation = bisect(-50, 50, I, (v) => m({ ...s, saturation: v }).Cq[1], R.Cq[1]);
    s.vibrance = bisect(-50, 50, I, (v) => m({ ...s, vibrance: v }).Cq[0], R.Cq[0]);
  }
  // 4. HSL per band: hue shift, chroma ratio and lightness difference where both images have that color.
  for (let round = 0; round < 2; round++) {
    const f = m(s);
    for (let k = 0; k < 8; k++) {
      const a = f.bands[k], r = R.bands[k];
      if (a.w < 0.02 || r.w < 0.02) continue;
      const conf = Math.min(1, Math.min(a.w, r.w) / 0.05);
      let dh = r.h - a.h; dh = ((dh + 540) % 360) - 180;
      s.hsl.hue[k] = clampV(s.hsl.hue[k] + conf * (dh / 30) * 100 * 0.4, -20, 20);
      s.hsl.sat[k] = clampV(s.hsl.sat[k] + conf * (r.C / Math.max(0.01, a.C) - 1) * 100 * 0.5, -40, 40);
    }
  }
  // 5. Split toning: tint of near-neutral shadows and highlights.
  for (let round = 0; round < 3; round++) {
    const f = m(s);
    for (const [key, cur, ref] of [['shadows', f.shadowAB, R.shadowAB], ['highlights', f.highlightAB, R.highlightAB]] as const) {
      if (!Number.isFinite(cur[0]) || !Number.isFinite(ref[0])) continue;
      const w = s.grading[key];
      const curA = (w.s / 100) * 0.08 * Math.cos((w.h * Math.PI) / 180), curB = (w.s / 100) * 0.08 * Math.sin((w.h * Math.PI) / 180);
      const na = curA + ((ref[0] - cur[0]) / 0.7) * 0.7, nb = curB + ((ref[1] - cur[1]) / 0.7) * 0.7;
      const mag = Math.min(40, (Math.hypot(na, nb) / 0.08) * 100);
      s.grading[key] = { h: Math.round(((Math.atan2(nb, na) * 180) / Math.PI + 360) % 360), s: Math.round(mag), l: 0 };
    }
  }
  // 6. Effects from spatial features.
  if (refSp && tgtSp) {
    const dv = refSp.vignette - tgtSp.vignette;
    s.vignette = Math.round(clampV((dv / 0.25) * 100, -50, 0));
    const dn = refSp.noise - tgtSp.noise;
    s.grain = Math.round(clampV((dn / 0.012) * 100, 0, 60));
    if (s.grain > 0) s.grainSize = 30;
  }

  // Round for display and build the report.
  const r0 = (v: number) => Math.round(v);
  for (const k of ['temp', 'tint', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'vibrance', 'saturation'] as const) s[k] = r0(s[k]);
  s.exposure = Math.round(s.exposure * 100) / 100;
  s.hsl = { hue: s.hsl.hue.map(r0), sat: s.hsl.sat.map(r0), lum: s.hsl.lum.map(r0) };
  const sign = (v: number, d = 0) => (v > 0 ? '+' : '') + v.toFixed(d);
  const list = (pairs: [string, number][], d = 0) => pairs.filter(([, v]) => Math.abs(v) >= (d ? 0.05 : 3)).map(([n, v]) => `${n} ${sign(v, d)}`).join(', ');
  const tone = [list([['Exposure', s.exposure]], 2), list([['Contrast', s.contrast], ['Highlights', s.highlights], ['Shadows', s.shadows], ['Whites', s.whites], ['Blacks', s.blacks]])].filter(Boolean).join(', ');
  report.push({ aspect: 'tone', text: (tone || 'No tone change') + (s.curve.rgb.length > 2 ? '; plus a tone curve' : '') });
  const bandsTxt = HSL_BANDS.map((n, k) => [n, s.hsl.hue[k], s.hsl.sat[k], s.hsl.lum[k]] as const)
    .filter(([, h, sa, l]) => Math.abs(h) + Math.abs(sa) + Math.abs(l) >= 15)
    .map(([n, h, sa, l]) => `${n.toLowerCase()} (hue ${sign(h)}, sat ${sign(sa)}, lum ${sign(l)})`).join(', ');
  report.push({ aspect: 'color', text: [list([['Temperature', s.temp], ['Tint', s.tint], ['Vibrance', s.vibrance], ['Saturation', s.saturation]]) || 'White balance unchanged', bandsTxt ? 'color mixer: ' + bandsTxt : ''].filter(Boolean).join('; ') });
  const g = s.grading;
  const wheelTxt = (n: string, w: { h: number; s: number }) => (w.s >= 3 ? `${n} tint ${hueName(w.h)} (hue ${w.h}, sat ${w.s})` : '');
  report.push({ aspect: 'split', text: [wheelTxt('Shadows', g.shadows), wheelTxt('Midtones', g.midtones), wheelTxt('Highlights', g.highlights)].filter(Boolean).join(', ') || 'No split toning' });
  report.push({ aspect: 'effects', text: refSp ? (list([['Vignette', s.vignette], ['Grain', s.grain]]) || 'No vignette or grain') : 'Not measured' });

  const look: Partial<Settings> = {};
  for (const keys of Object.values(ASPECT_KEYS)) for (const k of keys) (look as Record<string, unknown>)[k] = clone(s[k]);
  return { look, report, ms: Date.now() - t0 };
}

/**
 * Blend a fitted look into settings: enabled aspects are set to neutral + strength * fitted value.
 * Disabled aspects are reset to neutral (they were set by a previous copy).
 */
export function applyLook(base: Settings, look: Partial<Settings>, aspects: Record<Aspect, boolean>, strength: number): Settings {
  const out = clone(base), d = defaultSettings() as unknown as Record<string, unknown>;
  const k = strength / 100;
  const lerp = (a: unknown, b: unknown): unknown => {
    if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * k;
    if (Array.isArray(a) && Array.isArray(b)) {
      // Curves: lerp point y toward the identity line.
      if (Array.isArray(b[0])) return (b as number[][]).map(([x, y]) => [x, x + (y - x) * k]);
      return b.map((v, i) => lerp(a[i] ?? 0, v));
    }
    if (a && b && typeof a === 'object') {
      if ('h' in (b as object)) return { ...(b as object), s: ((b as { s: number }).s) * k, l: ((b as { l: number }).l) * k };
      const o: Record<string, unknown> = {};
      for (const key of Object.keys(b as object)) o[key] = lerp((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]);
      return o;
    }
    return b;
  };
  for (const [aspect, keys] of Object.entries(ASPECT_KEYS) as [Aspect, (keyof Settings)[]][]) {
    for (const key of keys) {
      if (!(key in look)) continue;
      (out as unknown as Record<string, unknown>)[key] = aspects[aspect] ? lerp(d[key], (look as Record<string, unknown>)[key]) : clone(d[key]);
    }
  }
  if (aspects.effects && 'grainSize' in look) out.grainSize = look.grainSize as number;
  return out;
}
