// Core math self-checks. Run with: npm test
declare const console: { log(...a: unknown[]): void };
declare const process: { exit(code: number): never };
import { analyze, analyzeTarget } from '../src/core/stats.js';
import { makeMapper, bakeLut, applyLut, lutToCube, parseCube, DEFAULT_PARAMS, Method } from '../src/core/transfer.js';
import { oklabRoundTrip } from '../src/core/transfer.js';
import { buildColorFn, bakeColorLut, curveTable, toneFn, bandWeights } from '../src/core/develop.js';
import { defaultSettings, Settings, BUILTIN_PRESETS, mergeSettings } from '../src/core/settings.js';
import { computeGeometry, mapPoint } from '../src/core/geometry.js';
import { fitLook, measure, samplePixels, applyLook } from '../src/core/fit.js';

let failed = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`);
  if (!ok) failed++;
}

function makeImage(w: number, h: number, f: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = f(x / (w - 1), y / (h - 1));
    const i = (y * w + x) * 4;
    px[i] = r * 255; px[i + 1] = g * 255; px[i + 2] = b * 255; px[i + 3] = 255;
  }
  return px;
}
// Neutral daylight-like target with a range of hues, and a warm high-contrast reference.
const target = makeImage(200, 150, (x, y) => [0.25 + 0.5 * x * (1 - y * 0.5), 0.35 + 0.4 * (1 - y), 0.3 + 0.5 * y * (1 - x * 0.4)]);
const ref = makeImage(180, 120, (x, y) => [0.95 - 0.55 * y, 0.25 + 0.55 * x * (1 - y), 0.08 + 0.3 * y * x]);

function meanAbsDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) { for (let c = 0; c < 3; c++) s += Math.abs(a[i + c] - b[i + c]); n += 3; }
  return s / n;
}
function maxFnError(s: Settings, label: string, tol = 1e-4) {
  const fn = buildColorFn(s, null), o = [0, 0, 0];
  let e = 0;
  for (let i = 0; i < 4000; i++) {
    const c = [Math.random(), Math.random(), Math.random()];
    fn(c[0], c[1], c[2], o);
    e = Math.max(e, ...o.map((v, k) => Math.abs(v - c[k])));
  }
  check(label, e < tol, `max error ${e.toExponential(2)}`);
}

// --- Color science ---
let maxErr = 0;
for (let i = 0; i < 1000; i++) {
  const c = [Math.random(), Math.random(), Math.random()];
  const o = oklabRoundTrip(c[0], c[1], c[2]);
  maxErr = Math.max(maxErr, ...o.map((v, k) => Math.abs(v - c[k])));
}
check('Oklab round trip', maxErr < 1e-4, `max error ${maxErr.toExponential(2)}`);

// --- Develop pipeline neutrality ---
maxFnError(defaultSettings(), 'Default settings are identity');
const t = toneFn({ contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 });
check('Tone function identity at 0', [0, 0.1, 0.5, 0.9, 1].every((x) => Math.abs(t(x) - x) < 1e-9), 'contrast/highlights/shadows/whites/blacks = 0');
const ct = curveTable([[0, 0], [1, 1]]);
check('Curve identity', ct.every((v, i) => Math.abs(v - i / 1023) < 1e-6), 'two-point identity curve');
const ct3 = curveTable([[0, 0], [0.5, 0.5], [1, 1]]);
check('Curve identity with midpoint', ct3.every((v, i) => Math.abs(v - i / 1023) < 1e-6), 'three collinear points');
const mono = curveTable([[0, 0], [0.3, 0.6], [0.35, 0.62], [1, 1]]);
check('Curve is monotone', mono.every((v, i) => i === 0 || v >= mono[i - 1] - 1e-7), 'Fritsch-Carlson');
{ const s = defaultSettings(); s.exposure = 0; s.contrast = 0; maxFnError(s, 'Exposure and contrast neutral at 0'); }
{ const s = defaultSettings(); s.hsl.hue = Array(8).fill(0); maxFnError(s, 'HSL identity at 0'); }
{ const w = new Array(8).fill(0); let ok = true; for (let h = -180; h < 540; h += 7) { bandWeights(h, w); ok &&= Math.abs(w.reduce((a, b) => a + b) - 1) < 1e-9; } check('HSL band weights sum to 1', ok, 'all hues'); }
{ const s = defaultSettings(); s.exposure = 1; const fn = buildColorFn(s, null), o = [0, 0, 0]; fn(0.2, 0.2, 0.2, o);
  check('Exposure +1 EV doubles linear light', Math.abs(o[0] - 0.2 * 0) > 0 && Math.abs(srgb2lin(o[0]) / srgb2lin(0.2) - 2) < 0.01, `ratio ${(srgb2lin(o[0]) / srgb2lin(0.2)).toFixed(3)}`); }
function srgb2lin(c: number) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
{ const s = defaultSettings(); s.contrast = 50; const fn = buildColorFn(s, null), o = [0, 0, 0], p = [0, 0, 0]; fn(0.2, 0.2, 0.2, o); fn(0.8, 0.8, 0.8, p);
  check('Contrast +50 spreads tones', o[0] < 0.2 && p[0] > 0.8, `0.2 -> ${o[0].toFixed(3)}, 0.8 -> ${p[0].toFixed(3)}`); }
{ const s = defaultSettings(); s.saturation = -100; const fn = buildColorFn(s, null), o = [0, 0, 0]; fn(0.9, 0.3, 0.1, o);
  check('Saturation -100 is gray', Math.max(...o) - Math.min(...o) < 0.01, o.map((v) => v.toFixed(3)).join(' ')); }
{ const s = defaultSettings(); s.temp = 50; const fn = buildColorFn(s, null), o = [0, 0, 0]; fn(0.5, 0.5, 0.5, o);
  check('Temperature + warms gray', o[0] > o[2], o.map((v) => v.toFixed(3)).join(' ')); }
for (const p of BUILTIN_PRESETS) {
  const fn = buildColorFn(mergeSettings(defaultSettings(), p.settings), null), o = [0, 0, 0];
  let ok = true; for (let i = 0; i < 500; i++) { fn(Math.random(), Math.random(), Math.random(), o); ok &&= o.every((v) => Number.isFinite(v) && v >= 0 && v <= 1); }
  check(`Preset "${p.name}" outputs valid colors`, ok, '500 random colors');
}

// --- LUTs ---
const idLut = bakeLut((r, g, b, o) => { o[0] = r; o[1] = g; o[2] = b; }, 33);
const t2 = target.slice(); applyLut(t2, idLut, 33);
check('Identity LUT apply', meanAbsDiff(t2, target) < 0.01, `mean abs diff ${meanAbsDiff(t2, target).toFixed(4)} / 255`);
const parsed = parseCube(lutToCube(idLut, 33, 'id'));
check('.cube write/parse round trip', parsed.size === 33 && parsed.lut.every((v, i) => Math.abs(v - idLut[i]) < 1e-5), '33 points');
{ const lut = bakeColorLut(buildColorFn(defaultSettings(), null), 33); const o = target.slice(); applyLut(o, lut, 33);
  check('Develop LUT of default settings is identity', meanAbsDiff(o, target) < 0.01, `mean abs diff ${meanAbsDiff(o, target).toFixed(4)} / 255`); }

// --- Geometry ---
{ const g = computeGeometry(defaultSettings(), 400, 300); const [u, v] = mapPoint(g, 0.25, 0.75);
  check('Geometry identity', Math.abs(u - 0.25) < 1e-9 && Math.abs(v - 0.75) < 1e-9 && g.outW === 400, `(${u}, ${v})`); }
{ const s = defaultSettings(); s.rot90 = 1; const g = computeGeometry(s, 400, 300); const [u, v] = mapPoint(g, 0, 0);
  // After a clockwise quarter turn the top-left output pixel comes from the bottom-left of the source.
  check('Geometry quarter turn', g.outW === 300 && g.outH === 400 && Math.abs(u) < 1e-9 && Math.abs(v - 1) < 1e-9, `size ${g.outW}x${g.outH}, uv (${u.toFixed(2)}, ${v.toFixed(2)})`); }
{ const s = defaultSettings(); s.flipH = true; const g = computeGeometry(s, 400, 300); const [u] = mapPoint(g, 0.1, 0.5);
  check('Geometry flip', Math.abs(u - 0.9) < 1e-9, `u ${u}`); }

// --- Statistical transfer (kept from the first version) ---
const tData = analyzeTarget(target), tStyle = analyze(target, 'self'), rStyle = analyze(ref, 'ref');
for (const method of ['reinhard', 'histogram', 'tone'] as Method[]) {
  const lut = bakeLut(makeMapper(tData, tStyle, { ...DEFAULT_PARAMS, method }), 65);
  const out = target.slice(); applyLut(out, lut, 65);
  check(`Self transfer ${method}`, meanAbsDiff(out, target) < 1.5, `mean abs diff ${meanAbsDiff(out, target).toFixed(3)} / 255`);
}

// --- Copy style fitting ---
{
  const tS = samplePixels(target), rS = samplePixels(ref);
  const self = fitLook(tS, tS);
  const s0 = applyLook(defaultSettings(), self.look, { tone: true, color: true, split: true, effects: true }, 100);
  const fn = buildColorFn(s0, null), o = [0, 0, 0]; let e = 0;
  for (let i = 0; i < tS.length; i += 3) { fn(tS[i], tS[i + 1], tS[i + 2], o); e += Math.abs(o[0] - tS[i]) + Math.abs(o[1] - tS[i + 1]) + Math.abs(o[2] - tS[i + 2]); }
  const selfErr = (e / tS.length) * 255;
  check('Copy style onto itself is near identity', selfErr < 3, `mean abs diff ${selfErr.toFixed(2)} / 255, fit ${self.ms} ms`);

  // Same content, known look: the fit should recover most of it.
  const look = defaultSettings();
  Object.assign(look, { temp: 25, tint: 5, exposure: 0.3, contrast: 20, saturation: -25 });
  look.grading.highlights = { h: 70, s: 25, l: 0 };
  const lookFn = buildColorFn(look, null);
  const rKnown = new Float32Array(tS.length);
  for (let i = 0; i < tS.length; i += 3) { lookFn(tS[i], tS[i + 1], tS[i + 2], o); rKnown.set(o, i); }
  const fitK = fitLook(rKnown, tS);
  const sK = applyLook(defaultSettings(), fitK.look, { tone: true, color: true, split: true, effects: true }, 100);
  const fnK = buildColorFn(sK, null);
  let before = 0, after = 0;
  for (let i = 0; i < tS.length; i += 3) {
    fnK(tS[i], tS[i + 1], tS[i + 2], o);
    for (let c = 0; c < 3; c++) { before += Math.abs(tS[i + c] - rKnown[i + c]); after += Math.abs(o[c] - rKnown[i + c]); }
  }
  before = (before / tS.length) * 255; after = (after / tS.length) * 255;
  check('Copy style recovers a known look on the same content', after < before * 0.35, `mean abs diff to reference ${before.toFixed(2)} -> ${after.toFixed(2)} / 255; temp ${sK.temp}, contrast ${sK.contrast}, saturation ${sK.saturation}`);

  const fit = fitLook(rS, tS);
  const s1 = applyLook(defaultSettings(), fit.look, { tone: true, color: true, split: true, effects: true }, 100);
  const fn1 = buildColorFn(s1, null), out = new Float32Array(tS.length);
  for (let i = 0; i < tS.length; i += 3) { fn1(tS[i], tS[i + 1], tS[i + 2], o); out.set(o, i); }
  const R = measure(rS), B = measure(tS), A = measure(out);
  const d = (x: number[], y: number[]) => Math.hypot(...x.map((v, i) => v - y[i]));
  const lq = [d(B.Lq, R.Lq), d(A.Lq, R.Lq)], cq = [d(B.Cq, R.Cq), d(A.Cq, R.Cq)];
  check('Copy style (different content): lightness quantiles move toward reference', lq[1] < lq[0] * 0.5, `${lq[0].toFixed(4)} -> ${lq[1].toFixed(4)}`);
  check('Copy style (different content): chroma level moves toward reference', cq[1] < cq[0] * 0.6, `${cq[0].toFixed(4)} -> ${cq[1].toFixed(4)}`);
  console.log('      report: ' + fit.report.map((r) => `[${r.aspect}] ${r.text}`).join(' | '));
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
