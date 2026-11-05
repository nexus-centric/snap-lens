import './style.css';
import { Renderer } from './gl/renderer.js';
import { buildColorFn, bakeColorLut } from './core/develop.js';
import { lutToCube } from './core/transfer.js';
import type { Method } from './core/transfer.js';
import type { StyleData, TargetData } from './core/stats.js';
import { defaultSettings, mergeSettings, lookOnly, Settings, BUILTIN_PRESETS, HSL_BANDS, CurvePoints } from './core/settings.js';
import { samplePixels, measureSpatial, applyLook, Aspect, FitResult, SpatialFeatures } from './core/fit.js';
import { mapPoint } from './core/geometry.js';
import { srgbToLinear } from './core/color.js';
import type { WorkerRequest, WorkerResponse } from './worker.js';
import { loadPresets, savePresets, parsePresetFile, newId, encodeSamples, decodeSamples, UserPreset } from './storage.js';
import { el, slider, SliderHandle, curveEditor, colorWheel, WheelHandle, computeHistogram, drawHistogram, fmtSigned } from './ui/widgets.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const PERF = new URLSearchParams(location.search).has('perf');
const isSmall = () => matchMedia('(max-width: 900px)').matches;
const PREVIEW_MAX = () => (isSmall() ? 2048 : 2560);
const ANALYSIS_MAX = 640;

// ---------- Worker ----------
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let nextId = 1;
const pending = new Map<number, (r: WorkerResponse) => void>();
worker.onmessage = (e: MessageEvent<WorkerResponse>) => { const cb = pending.get(e.data.id); pending.delete(e.data.id); cb?.(e.data); };
type Req = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;
const call = (req: Req): Promise<WorkerResponse & { ok: true }> => new Promise((res, rej) => {
  const id = nextId++;
  pending.set(id, (r) => (r.ok ? res(r) : rej(new Error(r.error))));
  worker.postMessage({ ...req, id });
});

// ---------- State ----------
interface Photo {
  id: string; name: string; file: Blob; w: number; h: number;
  preview: ImageBitmap; analysis: ImageData; thumb: string;
  target: TargetData | null; samples: Float32Array; spatial: SpatialFeatures;
  settings: Settings; history: string[]; hIndex: number;
  copyFit: FitResult | null;
}
interface Ref { name: string; analysis: ImageData; thumb: string }
type Aspects = Record<Aspect, boolean>;

const state = {
  photos: [] as Photo[],
  cur: null as Photo | null,
  refs: [] as Ref[],
  refStyle: null as StyleData | null,     // statistics for the statistical mode
  copyMode: 'sliders' as 'sliders' | 'stats',
  aspects: { tone: true, color: true, split: true, effects: true } as Aspects,
  strength: 100,
  statMethod: 'reinhard' as Method,
  presets: loadPresets(),
  clipboard: null as Partial<Settings> | null,
  split: 0.5, splitOn: false, before: false,
  cropMode: false, eyedropper: false,
  zoom: 1, panX: 0, panY: 0,
};
const S = () => state.cur!.settings;

let renderer: Renderer;
try { renderer = new Renderer($<HTMLCanvasElement>('view')); }
catch (e) { document.body.innerHTML = `<p style="padding:24px;font-family:system-ui">${(e as Error).message} Please use a current version of Chrome, Edge, Firefox or Safari.</p>`; throw e; }

// ---------- Helpers ----------
function toast(msg: string) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout((toast as unknown as { h: number }).h);
  (toast as unknown as { h: number }).h = window.setTimeout(() => t.classList.remove('show'), 2200);
}
const status = (m: string) => { $('status').textContent = m; };
const baseName = (n: string) => n.replace(/\.[^.]+$/, '') || 'photo';
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'look';
const imageFiles = (l: Iterable<File> | ArrayLike<File> | null | undefined) => Array.from(l || []).filter((f) => f.type.startsWith('image/'));
function download(blob: Blob, name: string) {
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function toImageData(src: CanvasImageSource & { width: number; height: number }, max: number): ImageData {
  const s = Math.min(1, max / Math.max(src.width, src.height));
  const c = el('canvas'); c.width = Math.max(1, Math.round(src.width * s)); c.height = Math.max(1, Math.round(src.height * s));
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height);
  return x.getImageData(0, 0, c.width, c.height);
}
function thumbOf(src: CanvasImageSource & { width: number; height: number }, max = 160): string {
  const s = max / Math.max(src.width, src.height);
  const c = el('canvas'); c.width = Math.round(src.width * s); c.height = Math.round(src.height * s);
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}
async function decode(file: Blob): Promise<ImageBitmap> {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error('Could not decode this image. JPEG, PNG, WebP and AVIF are supported.'); }
}

// ---------- Photos ----------
async function addPhotos(files: File[]) {
  for (const f of files) {
    status(`Opening ${f.name}...`);
    try {
      const full = await decode(f);
      const s = Math.min(1, PREVIEW_MAX() / Math.max(full.width, full.height));
      const preview = await createImageBitmap(full, { resizeWidth: Math.round(full.width * s), resizeHeight: Math.round(full.height * s), resizeQuality: 'high' });
      const analysis = toImageData(preview, ANALYSIS_MAX);
      const p: Photo = {
        id: newId(), name: f.name || 'pasted.png', file: f, w: full.width, h: full.height, preview, analysis,
        thumb: thumbOf(preview), target: null, samples: samplePixels(analysis.data),
        spatial: measureSpatial(analysis.data, analysis.width, analysis.height),
        settings: defaultSettings(), history: [], hIndex: -1, copyFit: null,
      };
      full.close();
      p.history = [JSON.stringify(p.settings)]; p.hIndex = 0;
      state.photos.push(p);
      call({ kind: 'target', pixels: new Uint8ClampedArray(analysis.data) }).then((r) => { p.target = r.target!; if (state.cur === p && S().copy) scheduleRender(); });
      if (!state.cur || files.length === 1) await selectPhoto(p);
    } catch (e) { toast((e as Error).message); }
  }
  status('');
  renderFilmstrip();
  if (state.cur && state.refs.length && !state.cur.copyFit && state.copyMode === 'sliders') void runCopy();
}

async function selectPhoto(p: Photo) {
  state.cur = p;
  renderer.setSource(p.preview, p.w, p.h);
  lutKey = '';
  state.zoom = 1; state.panX = 0; state.panY = 0;
  document.body.classList.add('has-photo');
  ($('exportQuick') as HTMLButtonElement).disabled = false;
  syncAll(); renderFilmstrip(); renderCopyReport();
  scheduleRender();
}

function renderFilmstrip() {
  const fs = $('filmstrip');
  fs.classList.toggle('show', state.photos.length > 1);
  fs.replaceChildren(...state.photos.map((p) => {
    const b = el('button', { class: 'film' + (p === state.cur ? ' on' : ''), title: p.name });
    b.append(el('img', { src: p.thumb, alt: p.name }));
    b.onclick = () => void selectPhoto(p);
    const x = el('span', { class: 'film-x', text: 'x', title: 'Remove from session', role: 'button' });
    x.onclick = (e) => {
      e.stopPropagation();
      state.photos = state.photos.filter((q) => q !== p); p.preview.close();
      if (state.cur === p) { if (state.photos[0]) void selectPhoto(state.photos[0]); else location.reload(); }
      renderFilmstrip();
    };
    b.append(x);
    return b;
  }), el('button', { class: 'film add', text: 'Add', title: 'Add photos' }));
  (fs.lastChild as HTMLButtonElement).onclick = () => $('openInput').click();
}

// ---------- History ----------
let commitTimer = 0;
function commit() {
  const p = state.cur; if (!p) return;
  clearTimeout(commitTimer);
  const snap = JSON.stringify(p.settings);
  if (snap === p.history[p.hIndex]) return;
  p.history = p.history.slice(0, p.hIndex + 1); p.history.push(snap);
  if (p.history.length > 200) p.history.shift();
  p.hIndex = p.history.length - 1;
  updateUndo();
}
const commitSoon = () => { clearTimeout(commitTimer); commitTimer = window.setTimeout(commit, 400); };
function undoRedo(d: number) {
  const p = state.cur; if (!p) return;
  commit();
  const i = p.hIndex + d; if (i < 0 || i >= p.history.length) return;
  p.hIndex = i; p.settings = JSON.parse(p.history[i]);
  syncAll(); scheduleRender(); updateUndo();
}
function updateUndo() {
  const p = state.cur;
  ($('undoBtn') as HTMLButtonElement).disabled = !p || p.hIndex <= 0;
  ($('redoBtn') as HTMLButtonElement).disabled = !p || p.hIndex >= p.history.length - 1;
}
/** Replace the current settings (e.g. preset, paste, copy style) as one undo step. */
function setSettings(s: Settings) { state.cur!.settings = s; syncAll(); scheduleRender(); commit(); }

// ---------- Rendering ----------
let lutKey = '', rafId = 0, idleTimer = 0, histTimer = 0;
const perf = { lutMs: 0, gpuMs: 0, frames: 0 };
function colorKey(s: Settings) {
  const { temp, tint, exposure, contrast, highlights, shadows, whites, blacks, vibrance, saturation, curve, hsl, grading, copy } = s;
  return JSON.stringify({ temp, tint, exposure, contrast, highlights, shadows, whites, blacks, vibrance, saturation, curve, hsl, grading, copy: copy && { ...copy, style: copy.style.name + copy.style.createdAt } });
}
function scheduleRender() {
  if (!state.cur) return;
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => renderNow(33));
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => renderNow(49), 300); // finer LUT once the user pauses
}
function renderNow(lutSize: number) {
  const p = state.cur; if (!p) return;
  const s = p.settings;
  const key = colorKey(s) + lutSize;
  if (key !== lutKey) {
    const t0 = performance.now();
    renderer.setLut(bakeColorLut(buildColorFn(s, p.target), lutSize), lutSize);
    perf.lutMs = performance.now() - t0;
    lutKey = key;
  }
  const t1 = performance.now();
  const split = state.before ? 1 : state.splitOn ? state.split : 0;
  renderer.render(s, { split, ignoreCrop: state.cropMode });
  if (PERF) renderer.finish();
  perf.gpuMs = performance.now() - t1; perf.frames++;
  layoutCanvas();
  const g = renderer.geometry(s, state.cropMode);
  status(`${p.name}  ${p.w} x ${p.h}  |  preview ${g.outW} x ${g.outH}, color LUT ${lutSize}: ${perf.lutMs.toFixed(0)} ms, draw ${perf.gpuMs.toFixed(1)} ms`);
  clearTimeout(histTimer);
  histTimer = window.setTimeout(updateHistogram, 120);
}
let lastHist: Uint32Array[] | null = null;
function updateHistogram() {
  if (!state.cur) return;
  const g = renderer.geometry(S());
  const sc = 220 / Math.max(g.outW, g.outH);
  const px = renderer.renderToPixels(S(), Math.max(1, Math.round(g.outW * sc)), Math.max(1, Math.round(g.outH * sc)));
  lastHist = computeHistogram(px);
  drawHistogram($<HTMLCanvasElement>('hist'), lastHist);
  curveUI?.setHistogram(lastHist);
  // Restore the canvas render (renderToPixels changed framebuffer state only).
}

// ---------- Viewer: fit, zoom, pan, split, eyedropper ----------
function layoutCanvas() {
  const stage = $('stage'), box = $('canvasBox'), cv = $<HTMLCanvasElement>('view');
  const sw = stage.clientWidth - 24, sh = stage.clientHeight - 24;
  const fit = Math.min(sw / cv.width, sh / cv.height, 4);
  const dw = cv.width * fit * state.zoom, dh = cv.height * fit * state.zoom;
  const maxX = Math.max(0, (dw - sw) / 2), maxY = Math.max(0, (dh - sh) / 2);
  state.panX = Math.max(-maxX, Math.min(maxX, state.panX)); state.panY = Math.max(-maxY, Math.min(maxY, state.panY));
  box.style.width = `${dw}px`; box.style.height = `${dh}px`;
  box.style.transform = `translate(${state.panX}px, ${state.panY}px)`;
  $('split').style.left = `${state.split * 100}%`;
  stage.classList.toggle('split-on', state.splitOn && !state.before && !state.cropMode);
  stage.classList.toggle('zoomed', state.zoom > 1);
  if (state.cropMode) layoutCrop();
}
function setZoom(z: number, cx?: number, cy?: number) {
  const box = $('canvasBox').getBoundingClientRect();
  const old = state.zoom; state.zoom = Math.max(1, Math.min(8, z));
  if (cx !== undefined && cy !== undefined) {
    // Keep the point under the cursor fixed.
    const ox = cx - (box.left + box.width / 2), oy = cy - (box.top + box.height / 2);
    state.panX -= ox * (state.zoom / old - 1); state.panY -= oy * (state.zoom / old - 1);
  }
  if (state.zoom === 1) { state.panX = 0; state.panY = 0; }
  layoutCanvas();
}
function initViewer() {
  const stage = $('stage'), box = $('canvasBox');
  new ResizeObserver(() => state.cur && layoutCanvas()).observe(stage);
  stage.addEventListener('wheel', (e) => { if (!state.cur) return; e.preventDefault(); setZoom(state.zoom * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });
  const pointers = new Map<number, { x: number; y: number }>();
  let mode: '' | 'pan' | 'split' | 'pinch' = '', start = { x: 0, y: 0, px: 0, py: 0, d: 0, z: 1 };
  stage.addEventListener('pointerdown', (e) => {
    if (!state.cur || state.cropMode) return;
    if ((e.target as HTMLElement).closest('.empty')) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (state.eyedropper) { pickNeutral(e.clientX, e.clientY); return; }
    stage.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      mode = 'pinch'; start = { ...start, d: Math.hypot(a.x - b.x, a.y - b.y), z: state.zoom };
    } else if ((e.target as HTMLElement).closest('#split') || (state.splitOn && state.zoom === 1)) {
      mode = 'split'; moveSplit(e.clientX);
    } else if (state.zoom > 1) {
      mode = 'pan'; start = { ...start, x: e.clientX, y: e.clientY, px: state.panX, py: state.panY };
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (mode === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      setZoom(start.z * Math.hypot(a.x - b.x, a.y - b.y) / start.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
    } else if (mode === 'split') moveSplit(e.clientX);
    else if (mode === 'pan') { state.panX = start.px + e.clientX - start.x; state.panY = start.py + e.clientY - start.y; layoutCanvas(); }
  });
  const up = (e: PointerEvent) => { pointers.delete(e.pointerId); if (pointers.size === 0) mode = ''; };
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  stage.addEventListener('dblclick', (e) => { if (!state.cur || state.cropMode || state.eyedropper) return; setZoom(state.zoom > 1 ? 1 : 2.5, e.clientX, e.clientY); });
  function moveSplit(x: number) {
    const r = box.getBoundingClientRect();
    state.split = Math.min(1, Math.max(0, (x - r.left) / r.width));
    renderNow(lutKey.endsWith("49") ? 49 : 33);
  }
  $('split').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') state.split = Math.max(0, state.split - 0.05);
    else if (e.key === 'ArrowRight') state.split = Math.min(1, state.split + 0.05); else return;
    scheduleRender();
  });
  $('zoomFit').onclick = () => setZoom(1);
  $('zoom100').onclick = () => setZoom(2);
}

function pickNeutral(cx: number, cy: number) {
  const p = state.cur!; const r = $('canvasBox').getBoundingClientRect();
  const u = (cx - r.left) / r.width, v = (cy - r.top) / r.height;
  state.eyedropper = false; $('stage').classList.remove('picking'); syncAll();
  if (u < 0 || u > 1 || v < 0 || v > 1) return;
  const g = renderer.geometry(S(), state.cropMode);
  const [su, sv] = mapPoint(g, u, v);
  const a = p.analysis, x0 = Math.round(su * (a.width - 1)), y0 = Math.round(sv * (a.height - 1));
  let rr = 0, gg = 0, bb = 0, n = 0;
  for (let y = y0 - 2; y <= y0 + 2; y++) for (let x = x0 - 2; x <= x0 + 2; x++) {
    if (x < 0 || y < 0 || x >= a.width || y >= a.height) continue;
    const i = (y * a.width + x) * 4; rr += a.data[i]; gg += a.data[i + 1]; bb += a.data[i + 2]; n++;
  }
  if (!n) return;
  // Include the statistical copy stage if present, then solve gains that make the color neutral.
  const c = [rr / n / 255, gg / n / 255, bb / n / 255];
  if (S().copy && p.target) {
    const s0 = defaultSettings(); s0.copy = S().copy; buildColorFn(s0, p.target)(c[0], c[1], c[2], c);
  }
  const lr = Math.max(1e-4, srgbToLinear(c[0])), lg = Math.max(1e-4, srgbToLinear(c[1])), lb = Math.max(1e-4, srgbToLinear(c[2]));
  const temp = Math.log(lb / lr) / (2 * 0.0035), tint = -Math.log(Math.sqrt(lr * lb) / lg) / 0.003;
  S().temp = Math.round(Math.max(-100, Math.min(100, temp))); S().tint = Math.round(Math.max(-100, Math.min(100, tint)));
  syncAll(); scheduleRender(); commit();
  toast(`White balance set from the picked point: temperature ${S().temp}, tint ${S().tint}`);
}

// ---------- Crop overlay ----------
const ASPECTS: [string, string][] = [['original', 'Original'], ['free', 'Free'], ['1:1', '1:1'], ['4:5', '4:5'], ['3:2', '3:2'], ['2:3', '2:3'], ['16:9', '16:9'], ['9:16', '9:16']];
function aspectValue(s: Settings, frameW: number, frameH: number): number | null {
  if (s.aspect === 'free') return null;
  if (s.aspect === 'original') return frameW / frameH;
  const [a, b] = s.aspect.split(':').map(Number); return a / b;
}
function fitCropToAspect() {
  const s = S(), g = renderer.geometry(s, true), ar = aspectValue(s, g.frameW, g.frameH);
  if (!ar) return;
  const c = s.crop, cx = c.x + c.w / 2, cy = c.y + c.h / 2;
  let w = c.w, h = (w * g.frameW) / (ar * g.frameH);
  if (h > 1) { h = 1; w = (h * ar * g.frameH) / g.frameW; }
  if (w > 1) { w = 1; h = (w * g.frameW) / (ar * g.frameH); }
  s.crop = { w, h, x: Math.min(1 - w, Math.max(0, cx - w / 2)), y: Math.min(1 - h, Math.max(0, cy - h / 2)) };
}
function layoutCrop() {
  const c = S().crop, r = $('cropRect');
  r.style.left = `${c.x * 100}%`; r.style.top = `${c.y * 100}%`; r.style.width = `${c.w * 100}%`; r.style.height = `${c.h * 100}%`;
}
function setCropMode(on: boolean) {
  state.cropMode = on; ($('crop') as HTMLElement).hidden = !on;
  $('stage').classList.toggle('cropping', on);
  syncAll(); scheduleRender(); if (!on) commit();
}
function initCrop() {
  const overlay = $('crop'), rect = $('cropRect');
  let mode = '', start = { x: 0, y: 0, c: { x: 0, y: 0, w: 1, h: 1 } };
  overlay.addEventListener('pointerdown', (e) => {
    const h = (e.target as HTMLElement).dataset.h;
    if (!h && e.target !== rect) return;
    mode = h || 'move'; overlay.setPointerCapture(e.pointerId);
    start = { x: e.clientX, y: e.clientY, c: { ...S().crop } };
    e.stopPropagation();
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!mode) return;
    const box = overlay.getBoundingClientRect();
    const dx = (e.clientX - start.x) / box.width, dy = (e.clientY - start.y) / box.height;
    const s = S(), c0 = start.c; let { x, y, w, h } = c0;
    const g = renderer.geometry(s, true), ar = aspectValue(s, g.frameW, g.frameH);
    const min = 0.05;
    if (mode === 'move') { x = Math.min(1 - w, Math.max(0, c0.x + dx)); y = Math.min(1 - h, Math.max(0, c0.y + dy)); }
    else {
      const west = mode.includes('w'), north = mode.includes('n');
      const ax = west ? c0.x + c0.w : c0.x, ay = north ? c0.y + c0.h : c0.y; // fixed corner
      let px = (west ? c0.x : c0.x + c0.w) + dx, py = (north ? c0.y : c0.y + c0.h) + dy;
      px = Math.min(1, Math.max(0, px)); py = Math.min(1, Math.max(0, py));
      w = Math.max(min, Math.abs(px - ax)); h = Math.max(min, Math.abs(py - ay));
      if (ar) {
        // Keep the aspect ratio in pixels, limited by the frame.
        const hFromW = (w * g.frameW) / (ar * g.frameH);
        h = hFromW;
        const maxH = north ? ay : 1 - ay, maxW = west ? ax : 1 - ax;
        if (h > maxH) { h = maxH; w = (h * ar * g.frameH) / g.frameW; }
        if (w > maxW) { w = maxW; h = (w * g.frameW) / (ar * g.frameH); }
      } else {
        w = Math.min(w, west ? ax : 1 - ax); h = Math.min(h, north ? ay : 1 - ay);
      }
      x = west ? ax - w : ax; y = north ? ay - h : ay;
    }
    s.crop = { x, y, w, h }; layoutCrop();
  });
  const end = () => { if (mode) { mode = ''; commitSoon(); } };
  overlay.addEventListener('pointerup', end); overlay.addEventListener('pointercancel', end);
}

// ---------- Panels ----------
const sliders: SliderHandle[] = [];
const wheels: WheelHandle[] = [];
const syncers: (() => void)[] = [];
let curveUI: ReturnType<typeof curveEditor> | null = null;
const onInput = () => { scheduleRender(); };
const onCommit = () => commit();

function sl(label: string, min: number, max: number, get: () => number, set: (v: number) => void, extra: Partial<Parameters<typeof slider>[0]> = {}) {
  const h = slider({ label, min, max, get: () => (state.cur ? get() : extra.def ?? 0), set: (v) => state.cur && set(v), onInput, onCommit, ...extra });
  sliders.push(h); return h.root;
}
function syncAll() {
  for (const s of sliders) s.sync();
  for (const w of wheels) w.sync();
  for (const f of syncers) f();
  curveUI?.draw();
  updateUndo();
}

interface Section { id: string; title: string; short: string; body: HTMLElement; open?: boolean; hero?: boolean }
const sections: Section[] = [];
function section(id: string, title: string, short: string, body: HTMLElement, opts: Partial<Section> = {}) { sections.push({ id, title, short, body, ...opts }); }
function group(title: string, ...kids: (Node | string)[]) { return el('div', { class: 'group' }, el('div', { class: 'group-title', text: title }), ...kids); }
function seg<T extends string>(options: [T, string][], get: () => T, set: (v: T) => void, label: string) {
  const root = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  const btns = options.map(([v, t]) => { const b = el('button', { type: 'button', role: 'radio', text: t }); b.onclick = () => { set(v); sync(); }; root.append(b); return [v, b] as const; });
  const sync = () => btns.forEach(([v, b]) => { b.classList.toggle('on', get() === v); b.setAttribute('aria-checked', String(get() === v)); });
  syncers.push(sync); sync();
  return root;
}
function button(text: string, onClick: () => void, cls = 'btn', title = '') { const b = el('button', { class: cls, type: 'button', text }); if (title) b.title = title; b.onclick = onClick; return b; }

// ----- Copy style (hero) -----
function buildCopy(): HTMLElement {
  const thumbs = el('div', { class: 'ref-thumbs', id: 'refThumbs' });
  const input = el('input', { type: 'file', accept: 'image/*', multiple: '', hidden: '' }) as HTMLInputElement;
  const drop = el('label', { class: 'drop', tabindex: '0', id: 'refDrop' }, input,
    el('strong', { text: 'Add reference photos' }), el('span', { text: 'The look you want. Drop, paste or click. Several photos are blended.' }));
  input.onchange = () => { void addRefs(imageFiles(input.files)); input.value = ''; };
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); void addRefs(imageFiles(e.dataTransfer?.files)); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });

  const modeSeg = seg<'sliders' | 'stats'>([['sliders', 'Editable sliders'], ['stats', 'Statistical match']], () => state.copyMode, (v) => { state.copyMode = v; renderCopyReport(); }, 'Copy method');
  const aspects = el('div', { class: 'chips', id: 'aspectChips' });
  const aspectNames: [Aspect, string][] = [['tone', 'Tone'], ['color', 'Color'], ['split', 'Split toning'], ['effects', 'Vignette and grain']];
  for (const [a, label] of aspectNames) {
    const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'true', text: label });
    b.onclick = () => { state.aspects[a] = !state.aspects[a]; syncChips(); reapplyCopy(); };
    aspects.append(b);
  }
  const syncChips = () => aspectNames.forEach(([a], i) => { const b = aspects.children[i] as HTMLElement; b.classList.toggle('on', state.aspects[a]); b.setAttribute('aria-pressed', String(state.aspects[a])); });
  syncers.push(syncChips);
  const strength = slider({ label: 'Strength', min: 0, max: 100, def: 100, get: () => state.strength, set: (v) => { state.strength = v; }, onInput: () => reapplyCopy(false), onCommit: () => commit(), fmt: (v) => `${v}%` });
  sliders.push(strength);
  const statMethod = seg<Method>([['reinhard', 'Mean / std'], ['histogram', 'Histogram'], ['tone', 'Tone curve']], () => state.statMethod, (v) => { state.statMethod = v; if (state.cur?.settings.copy) { S().copy!.method = v; scheduleRender(); commit(); } }, 'Statistical method');
  const statsBox = el('div', { class: 'stats-only' }, statMethod, el('p', { class: 'note', text: 'Statistical match transfers color statistics directly (Oklab mean and spread, per-channel histograms or the lightness curve). It is exact but not broken down into sliders.' }));
  const report = el('div', { class: 'report', id: 'copyReport' });
  const run = button('Copy style to photo', () => void runCopy(), 'btn primary wide', 'Analyze the references and set the sliders');
  run.id = 'copyRun';
  const actions = el('div', { class: 'row' },
    button('Copy to all photos', () => void copyToAll(), 'btn', 'Fit the look separately to every photo in the session'),
    button('Save as preset', () => savePresetFromCopy(), 'btn', 'Save the look; it adapts to each photo it is applied to'),
    button('Remove', () => removeCopy(), 'btn ghost', 'Reset everything the copy changed'));
  const palette = el('div', { class: 'palette', id: 'refPalette' });
  return el('div', {}, drop, thumbs, palette, modeSeg, el('div', { class: 'sliders-only' }, el('div', { class: 'sub', text: 'What to copy' }), aspects), strength.root, statsBox, run, report, actions);
}

async function addRefs(files: File[]) {
  if (!files.length) return;
  for (const f of files) {
    try {
      const bmp = await decode(f);
      state.refs.push({ name: f.name || 'pasted.png', analysis: toImageData(bmp, ANALYSIS_MAX), thumb: thumbOf(bmp, 200) });
      bmp.close();
    } catch (e) { toast((e as Error).message); }
  }
  await refsChanged();
}
async function refsChanged() {
  renderRefs();
  state.refStyle = null;
  if (state.refs.length) {
    const total = state.refs.reduce((n, r) => n + r.analysis.data.length, 0), pooled = new Uint8ClampedArray(total);
    let o = 0; for (const r of state.refs) { pooled.set(r.analysis.data, o); o += r.analysis.data.length; }
    const name = state.refs.length === 1 ? baseName(state.refs[0].name) : `Blend of ${state.refs.length} photos`;
    state.refStyle = (await call({ kind: 'analyze', pixels: pooled, name, sources: state.refs.length })).style!;
    renderRefs();
    if (state.cur) await runCopy();
  }
}
function renderRefs() {
  $('refThumbs').replaceChildren(...state.refs.map((r, i) => {
    const d = el('div', { class: 'ref' }, el('img', { src: r.thumb, alt: r.name }));
    const x = button('x', () => { state.refs.splice(i, 1); void refsChanged(); }, 'ref-x', `Remove ${r.name}`);
    d.append(x); return d;
  }));
  const pal = $('refPalette');
  pal.replaceChildren(...(state.refStyle?.palette ?? []).map((p) => {
    const b = el('button', { class: 'swatch', type: 'button', title: `Copy ${p.hex} (${Math.round(p.weight * 100)} percent)` }, el('span', {}), el('code', { text: p.hex }));
    (b.firstChild as HTMLElement).style.background = p.hex;
    b.onclick = async () => { try { await navigator.clipboard.writeText(p.hex); toast(`Copied ${p.hex}`); } catch { toast(p.hex); } };
    return b;
  }));
  $('copyRun').toggleAttribute('disabled', !state.refs.length);
}
function refSamples(): { samples: Float32Array; spatial: SpatialFeatures } {
  const per = Math.floor(6000 / Math.max(1, state.refs.length));
  const parts = state.refs.map((r) => samplePixels(r.analysis.data, per));
  const samples = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { samples.set(p, o); o += p.length; }
  const sp = state.refs.map((r) => measureSpatial(r.analysis.data, r.analysis.width, r.analysis.height));
  return { samples, spatial: { vignette: sp.reduce((a, b) => a + b.vignette, 0) / sp.length, noise: sp.reduce((a, b) => a + b.noise, 0) / sp.length } };
}
async function fitPhoto(p: Photo, ref: { samples: Float32Array; spatial?: SpatialFeatures }) {
  const r = await call({ kind: 'fit', ref: ref.samples, target: p.samples, refSp: ref.spatial, tgtSp: p.spatial });
  return r.fit!;
}
let lastRef: { samples: Float32Array; spatial: SpatialFeatures } | null = null;
async function runCopy() {
  const p = state.cur;
  if (!p) { toast('Open a photo to edit first'); return; }
  if (!state.refs.length) { toast('Add a reference photo first'); return; }
  if (state.copyMode === 'stats') {
    if (!state.refStyle) return;
    p.settings.copy = { style: state.refStyle, method: state.statMethod, space: 'oklab', strength: state.strength, lumStrength: 100, colorStrength: 100 };
    syncAll(); scheduleRender(); commit(); renderCopyReport();
    toast('Statistical match applied'); return;
  }
  const btn = $('copyRun'); btn.setAttribute('disabled', ''); btn.textContent = 'Analyzing...';
  try {
    lastRef = refSamples();
    p.copyFit = await fitPhoto(p, lastRef);
    p.settings = applyLook(p.settings, p.copyFit.look, state.aspects, state.strength);
    syncAll(); scheduleRender(); commit(); renderCopyReport();
    toast(`Style copied in ${p.copyFit.ms} ms. Fine-tune it in the other panels.`);
  } catch (e) { toast((e as Error).message); }
  btn.removeAttribute('disabled'); btn.textContent = 'Copy style to photo';
}
function reapplyCopy(doCommit = true) {
  const p = state.cur; if (!p) return;
  if (state.copyMode === 'stats' && p.settings.copy) { p.settings.copy.strength = state.strength; scheduleRender(); return; }
  if (!p.copyFit) return;
  p.settings = applyLook(p.settings, p.copyFit.look, state.aspects, state.strength);
  syncAll(); scheduleRender(); renderCopyReport();
  if (doCommit) commit();
}
async function copyToAll() {
  if (!state.refs.length) { toast('Add a reference photo first'); return; }
  lastRef = refSamples();
  let n = 0;
  for (const p of state.photos) {
    status(`Copying style to ${p.name}...`);
    p.copyFit = await fitPhoto(p, lastRef);
    p.settings = applyLook(p.settings, p.copyFit.look, state.aspects, state.strength);
    p.history.push(JSON.stringify(p.settings)); p.hIndex = p.history.length - 1; n++;
  }
  syncAll(); scheduleRender(); renderCopyReport();
  toast(`Style copied to ${n} photo${n > 1 ? 's' : ''}`);
}
function removeCopy() {
  const p = state.cur; if (!p) return;
  const off = { tone: false, color: false, split: false, effects: false };
  if (p.copyFit) p.settings = applyLook(p.settings, p.copyFit.look, off, 0);
  p.settings.copy = null; p.copyFit = null;
  syncAll(); scheduleRender(); commit(); renderCopyReport();
}
function renderCopyReport() {
  const box = $('copyReport'); if (!box) return;
  document.body.classList.toggle('mode-stats', state.copyMode === 'stats');
  const p = state.cur;
  if (state.copyMode === 'stats') {
    box.replaceChildren(p?.settings.copy ? el('p', { text: `Statistical match active: ${p.settings.copy.style.name}, ${p.settings.copy.method}, strength ${p.settings.copy.strength}%.` }) : el('p', { class: 'muted', text: 'Not applied yet.' }));
    return;
  }
  if (!p?.copyFit) { box.replaceChildren(el('p', { class: 'muted', text: state.refs.length ? 'Ready. Press Copy style to photo.' : 'Add a reference photo to start. The copied look appears here and in the panels as normal slider values.' })); return; }
  const names: Record<Aspect, string> = { tone: 'Tone', color: 'Color', split: 'Split toning', effects: 'Effects' };
  box.replaceChildren(el('div', { class: 'sub', text: `Copied at ${state.strength}% strength (values below are at 100%)` }),
    ...p.copyFit.report.map((r) => el('div', { class: 'rep' + (state.aspects[r.aspect] ? '' : ' off') }, el('b', { text: names[r.aspect] }), el('span', { text: r.text }))));
}

// ----- Presets -----
function buildPresets(): HTMLElement {
  const list = el('div', { class: 'presets', id: 'presetList' });
  const name = el('input', { type: 'text', placeholder: 'Preset name', maxlength: '60', 'aria-label': 'Preset name' }) as HTMLInputElement;
  const fileIn = el('input', { type: 'file', accept: '.json,application/json', hidden: '' }) as HTMLInputElement;
  fileIn.onchange = async () => {
    const f = fileIn.files?.[0]; fileIn.value = ''; if (!f) return;
    try { const items = parsePresetFile(await f.text()); state.presets.unshift(...items); persistPresets(); toast(`Imported ${items.length} preset(s)`); }
    catch (e) { toast((e as Error).message); }
  };
  syncers.push(renderPresets);
  return el('div', {}, list,
    el('div', { class: 'row' }, name, button('Save current', () => {
      if (!state.cur) return;
      state.presets.unshift({ id: newId(), name: name.value.trim() || `Look ${state.presets.length + 1}`, settings: lookOnly(S()) });
      name.value = ''; persistPresets(); toast('Preset saved');
    })),
    el('div', { class: 'row' }, button('Import', () => fileIn.click()), button('Export all', () => {
      if (!state.presets.length) { toast('No user presets yet'); return; }
      download(new Blob([JSON.stringify({ app: 'snap-lens', presets: state.presets }, null, 1)], { type: 'application/json' }), 'snap-lens-presets.json');
    }), fileIn),
    el('div', { class: 'sub', text: 'Settings clipboard' }),
    el('div', { class: 'row' },
      button('Copy settings', () => { if (!state.cur) return; state.clipboard = lookOnly(S()); navigator.clipboard?.writeText(JSON.stringify(state.clipboard)).catch(() => {}); toast('Settings copied (crop and rotation excluded)'); }),
      button('Paste settings', () => { if (!state.cur || !state.clipboard) { toast('Nothing copied yet'); return; } setSettings(mergeSettings(S(), state.clipboard)); toast('Settings pasted'); }),
      button('Paste to all', () => { if (!state.clipboard) { toast('Nothing copied yet'); return; } for (const p of state.photos) { p.settings = mergeSettings(p.settings, state.clipboard); p.history.push(JSON.stringify(p.settings)); p.hIndex = p.history.length - 1; } syncAll(); scheduleRender(); toast('Pasted to all photos'); })));
}
function persistPresets() { try { savePresets(state.presets); } catch { toast('Browser storage is full or disabled'); } renderPresets(); }
function renderPresets() {
  const list = $('presetList'); if (!list) return;
  const item = (p: UserPreset) => {
    const row = el('div', { class: 'preset' });
    const b = button(p.name, () => void applyPreset(p), 'preset-name', p.reference ? 'Copied look: refits to each photo' : 'Apply preset');
    row.append(b);
    if (p.reference) row.append(el('span', { class: 'badge', text: 'adaptive' }));
    if (!p.builtin) {
      row.append(button('JSON', () => download(new Blob([JSON.stringify(p, null, 1)], { type: 'application/json' }), `${slug(p.name)}.preset.json`), 'mini', 'Export this preset'));
      row.append(button('Delete', () => { if (confirm(`Delete preset "${p.name}"?`)) { state.presets = state.presets.filter((q) => q !== p); persistPresets(); } }, 'mini'));
    }
    return row;
  };
  list.replaceChildren(
    ...(state.presets.length ? [el('div', { class: 'sub', text: 'Your presets' }), ...state.presets.map(item)] : []),
    el('div', { class: 'sub', text: 'Built-in looks' }), ...BUILTIN_PRESETS.map(item));
}
async function applyPreset(p: UserPreset) {
  if (!state.cur) { toast('Open a photo first'); return; }
  const base = mergeSettings(defaultSettings(), { ...lookOnly(S()), ...Object.fromEntries(['rot90', 'straighten', 'flipH', 'flipV', 'crop', 'aspect'].map((k) => [k, (S() as unknown as Record<string, unknown>)[k]])) });
  let s = mergeSettings(base, p.settings);
  if (p.reference) {
    // Adaptive preset: refit the stored reference to this photo.
    const fit = await fitPhoto(state.cur, { samples: decodeSamples(p.reference.samples), spatial: p.reference.spatial });
    state.cur.copyFit = fit;
    s = applyLook(s, fit.look, (p.reference.aspects as Aspects) ?? state.aspects, p.reference.strength ?? 100);
    renderCopyReport();
  }
  setSettings(s);
  toast(`Applied ${p.name}`);
}
function savePresetFromCopy() {
  const p = state.cur;
  if (!p || !lastRef) { toast('Copy a style first'); return; }
  const n = prompt('Name for this look', state.refStyle?.name ?? 'Copied look');
  if (n === null) return;
  state.presets.unshift({ id: newId(), name: n.trim() || 'Copied look', settings: lookOnly(p.settings),
    reference: { samples: encodeSamples(lastRef.samples), spatial: lastRef.spatial, aspects: { ...state.aspects }, strength: state.strength } });
  persistPresets(); toast('Saved. Applying this preset refits the look to each photo.');
}

// ----- Basic -----
function buildBasic(): HTMLElement {
  const pick = button('Pick neutral', () => { state.eyedropper = !state.eyedropper; $('stage').classList.toggle('picking', state.eyedropper); syncAll(); if (state.eyedropper) toast('Click something that should be white or gray'); }, 'btn small', 'Eyedropper: click a neutral point in the photo');
  syncers.push(() => pick.classList.toggle('on', state.eyedropper));
  return el('div', {},
    group('White balance', el('div', { class: 'row tight' }, pick),
      sl('Temperature', -100, 100, () => S().temp, (v) => (S().temp = v), { track: 'linear-gradient(90deg,#4a7bd6,#d8d8d8,#e0a33a)' }),
      sl('Tint', -100, 100, () => S().tint, (v) => (S().tint = v), { track: 'linear-gradient(90deg,#4fb35a,#d8d8d8,#c25bc2)' })),
    group('Tone',
      sl('Exposure', -5, 5, () => S().exposure, (v) => (S().exposure = v), { step: 0.01, fmt: fmtSigned(2) }),
      sl('Contrast', -100, 100, () => S().contrast, (v) => (S().contrast = v)),
      sl('Highlights', -100, 100, () => S().highlights, (v) => (S().highlights = v)),
      sl('Shadows', -100, 100, () => S().shadows, (v) => (S().shadows = v)),
      sl('Whites', -100, 100, () => S().whites, (v) => (S().whites = v)),
      sl('Blacks', -100, 100, () => S().blacks, (v) => (S().blacks = v))),
    group('Presence',
      sl('Texture', -100, 100, () => S().texture, (v) => (S().texture = v)),
      sl('Clarity', -100, 100, () => S().clarity, (v) => (S().clarity = v)),
      sl('Dehaze', -100, 100, () => S().dehaze, (v) => (S().dehaze = v)),
      sl('Vibrance', -100, 100, () => S().vibrance, (v) => (S().vibrance = v)),
      sl('Saturation', -100, 100, () => S().saturation, (v) => (S().saturation = v))),
    el('p', { class: 'note', text: 'Double-click a slider or its name to reset it.' }));
}

// ----- Tone curve -----
let curveCh: 'rgb' | 'r' | 'g' | 'b' = 'rgb';
function buildCurve(): HTMLElement {
  const colors = { rgb: '#e8e8e8', r: '#ff6b6b', g: '#5fd47a', b: '#6f9bff' };
  curveUI = curveEditor(() => (state.cur ? S().curve[curveCh] : [[0, 0], [1, 1]] as CurvePoints), (p) => { if (state.cur) S().curve[curveCh] = p; }, () => colors[curveCh], onInput, onCommit);
  const ch = seg<'rgb' | 'r' | 'g' | 'b'>([['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']], () => curveCh, (v) => { curveCh = v; curveUI!.draw(); }, 'Curve channel');
  return el('div', {}, ch, curveUI.root,
    el('div', { class: 'row' }, button('Reset channel', () => { if (!state.cur) return; S().curve[curveCh] = [[0, 0], [1, 1]]; curveUI!.draw(); scheduleRender(); commit(); }, 'btn small'),
      button('Medium contrast', () => { if (!state.cur) return; S().curve[curveCh] = [[0, 0], [0.25, 0.21], [0.75, 0.79], [1, 1]]; curveUI!.draw(); scheduleRender(); commit(); }, 'btn small'),
      button('Matte', () => { if (!state.cur) return; S().curve[curveCh] = [[0, 0.07], [0.3, 0.3], [1, 0.97]]; curveUI!.draw(); scheduleRender(); commit(); }, 'btn small')),
    el('p', { class: 'note', text: 'Drag points. Click the line to add a point; double-click a point to remove it.' }));
}

// ----- Color mixer -----
let hslMode: 'hue' | 'sat' | 'lum' = 'hue';
function buildMixer(): HTMLElement {
  const swatch = ['#e5484d', '#f08a3c', '#f2cf3a', '#4bbf5a', '#3cc4c4', '#3d7ef2', '#8e5ae8', '#d94fb7'];
  const box = el('div', {});
  const rows = HSL_BANDS.map((name, i) => {
    const h = slider({ label: name, min: -100, max: 100, get: () => (state.cur ? S().hsl[hslMode][i] : 0), set: (v) => { if (state.cur) S().hsl[hslMode][i] = v; }, onInput, onCommit, track: `linear-gradient(90deg, #555, ${swatch[i]})` });
    h.root.querySelector('label')!.prepend(el('i', { class: 'dot', style: `background:${swatch[i]}` }));
    sliders.push(h); return h.root;
  });
  box.append(...rows);
  const modeSeg = seg<'hue' | 'sat' | 'lum'>([['hue', 'Hue'], ['sat', 'Saturation'], ['lum', 'Luminance']], () => hslMode, (v) => { hslMode = v; syncAll(); }, 'Mixer property');
  return el('div', {}, modeSeg, box);
}

// ----- Color grading -----
function buildGrading(): HTMLElement {
  const zones: ['shadows' | 'midtones' | 'highlights', string][] = [['shadows', 'Shadows'], ['midtones', 'Midtones'], ['highlights', 'Highlights']];
  const wrap = el('div', { class: 'wheels' });
  for (const [z, label] of zones) {
    const w = colorWheel(label, () => (state.cur ? S().grading[z] : { h: 0, s: 0 }), (h, s) => { if (state.cur) { S().grading[z].h = h; S().grading[z].s = s; } }, onInput, onCommit);
    wheels.push(w);
    w.root.append(sl('Luminance', -100, 100, () => S().grading[z].l, (v) => (S().grading[z].l = v)));
    wrap.append(w.root);
  }
  return el('div', {}, wrap,
    sl('Blending', 0, 100, () => S().grading.blending, (v) => (S().grading.blending = v), { def: 50 }),
    sl('Balance', -100, 100, () => S().grading.balance, (v) => (S().grading.balance = v)),
    el('p', { class: 'note', text: 'Drag inside a wheel to tint that tonal range. Double-click a wheel to reset it.' }));
}

// ----- Detail and effects -----
function buildDetail(): HTMLElement {
  return el('div', {},
    group('Sharpening', sl('Amount', 0, 150, () => S().sharpen, (v) => (S().sharpen = v)),
      sl('Radius', 0.5, 3, () => S().sharpenRadius, (v) => (S().sharpenRadius = v), { step: 0.1, def: 1, fmt: (v) => v.toFixed(1) })),
    group('Noise reduction', sl('Luminance and color', 0, 100, () => S().noise, (v) => (S().noise = v))));
}
function buildEffects(): HTMLElement {
  return el('div', {},
    group('Vignette', sl('Amount', -100, 100, () => S().vignette, (v) => (S().vignette = v)),
      sl('Midpoint', 0, 100, () => S().vignetteMid, (v) => (S().vignetteMid = v), { def: 50 }),
      sl('Feather', 0, 100, () => S().vignetteFeather, (v) => (S().vignetteFeather = v), { def: 50 })),
    group('Grain', sl('Amount', 0, 100, () => S().grain, (v) => (S().grain = v)),
      sl('Size', 0, 100, () => S().grainSize, (v) => (S().grainSize = v), { def: 25 })));
}

// ----- Geometry -----
function buildGeometry(): HTMLElement {
  const cropBtn = button('Crop', () => setCropMode(!state.cropMode), 'btn', 'Show the whole frame and drag the crop box');
  syncers.push(() => { cropBtn.classList.toggle('on', state.cropMode); cropBtn.textContent = state.cropMode ? 'Done cropping' : 'Edit crop'; });
  const aspect = el('select', { 'aria-label': 'Aspect ratio' }) as HTMLSelectElement;
  for (const [v, t] of ASPECTS) aspect.append(el('option', { value: v, text: t }));
  aspect.onchange = () => { if (!state.cur) return; S().aspect = aspect.value; fitCropToAspect(); scheduleRender(); commit(); if (!state.cropMode) setCropMode(true); };
  syncers.push(() => { aspect.value = state.cur ? S().aspect : 'original'; });
  const turn = (d: number) => { if (!state.cur) return; S().rot90 = (S().rot90 + d + 4) % 4; S().crop = { x: 0, y: 0, w: 1, h: 1 }; if (S().aspect !== 'free') fitCropToAspect(); scheduleRender(); commit(); };
  return el('div', {},
    el('div', { class: 'row' }, cropBtn, el('label', { class: 'inline' }, 'Aspect ', aspect)),
    el('div', { class: 'row' }, button('Rotate left', () => turn(-1), 'btn small'), button('Rotate right', () => turn(1), 'btn small'),
      button('Flip H', () => { if (!state.cur) return; S().flipH = !S().flipH; scheduleRender(); commit(); }, 'btn small'),
      button('Flip V', () => { if (!state.cur) return; S().flipV = !S().flipV; scheduleRender(); commit(); }, 'btn small')),
    sl('Straighten', -45, 45, () => S().straighten, (v) => (S().straighten = v), { step: 0.1, fmt: (v) => `${v.toFixed(1)} deg` }),
    el('div', { class: 'row' }, button('Reset geometry', () => { if (!state.cur) return; Object.assign(S(), { rot90: 0, straighten: 0, flipH: false, flipV: false, crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: 'original' }); syncAll(); scheduleRender(); commit(); }, 'btn small')));
}

// ----- Export -----
function buildExport(): HTMLElement {
  const fmt = el('select', { id: 'fmt', 'aria-label': 'Format' }, el('option', { value: 'image/jpeg', text: 'JPEG' }), el('option', { value: 'image/png', text: 'PNG' })) as HTMLSelectElement;
  let quality = 92;
  const q = slider({ label: 'JPEG quality', min: 50, max: 100, def: 92, get: () => quality, set: (v) => (quality = v), onInput: () => {}, onCommit: () => {}, fmt: (v) => String(v) });
  const size = el('select', { id: 'exportSize', 'aria-label': 'Size' }, el('option', { value: '0', text: 'Full resolution' }), el('option', { value: '4096', text: 'Long edge 4096 px' }), el('option', { value: '2048', text: 'Long edge 2048 px' })) as HTMLSelectElement;
  const lutSize = el('select', { 'aria-label': 'LUT size' }, el('option', { value: '17', text: '17 points' }), el('option', { value: '33', text: '33 points', selected: '' }), el('option', { value: '65', text: '65 points' })) as HTMLSelectElement;
  const go = button('Export image', () => void exportImage(fmt.value, quality / 100, Number(size.value)), 'btn primary', '');
  go.id = 'exportGo';
  return el('div', {},
    el('div', { class: 'row' }, fmt, size), q.root, go,
    el('div', { class: 'sub', text: 'Color look as 3D LUT' }),
    el('div', { class: 'row' }, lutSize, button('Export .cube', () => exportCube(Number(lutSize.value)))),
    el('p', { class: 'note', text: 'The .cube LUT contains color and tone only: white balance, exposure, tone, curves, color mixer, color grading, vibrance, saturation and statistical match. Local effects such as texture, clarity, dehaze, sharpening, noise reduction, vignette, grain and crop cannot be stored in a LUT.' }));
}
async function exportImage(type: string, quality: number, longEdge: number) {
  const p = state.cur; if (!p) return;
  const btn = $('exportGo'); btn.setAttribute('disabled', '');
  status('Decoding full resolution...');
  let r2: Renderer | null = null;
  try {
    const full = await decode(p.file);
    const cv = el('canvas');
    r2 = new Renderer(cv);
    let src: ImageBitmap = full;
    let scale = 1;
    const cap = Math.min(r2.maxTex, longEdge || Infinity);
    if (Math.max(full.width, full.height) > cap) {
      scale = cap / Math.max(full.width, full.height);
      src = await createImageBitmap(full, { resizeWidth: Math.round(full.width * scale), resizeHeight: Math.round(full.height * scale), resizeQuality: 'high' });
      full.close();
      if (!longEdge) toast(`This GPU supports up to ${r2.maxTex} px; exporting at ${src.width} x ${src.height}.`);
    }
    status(`Rendering ${src.width} x ${src.height}...`);
    const t0 = performance.now();
    r2.setSource(src, src.width, src.height);
    r2.setLut(bakeColorLut(buildColorFn(p.settings, p.target), 65), 65);
    const g = r2.geometry(p.settings);
    const px = r2.renderToPixels(p.settings, g.outW, g.outH);
    src.close();
    const out = el('canvas'); out.width = g.outW; out.height = g.outH;
    out.getContext('2d')!.putImageData(new ImageData(px as Uint8ClampedArray<ArrayBuffer>, g.outW, g.outH), 0, 0);
    const ms = performance.now() - t0;
    const blob = await new Promise<Blob | null>((res) => out.toBlob(res, type, quality));
    if (!blob) throw new Error('Export failed. The image may be too large for this browser.');
    download(blob, `${baseName(p.name)}-edit.${type === 'image/png' ? 'png' : 'jpg'}`);
    status(`Exported ${g.outW} x ${g.outH} (render ${ms.toFixed(0)} ms, ${(blob.size / 1e6).toFixed(1)} MB)`);
    (window as unknown as { __lastExport: unknown }).__lastExport = { w: g.outW, h: g.outH, ms, bytes: blob.size };
  } catch (e) { status((e as Error).message); toast((e as Error).message); }
  r2?.gl.getExtension('WEBGL_lose_context')?.loseContext();
  btn.removeAttribute('disabled');
}
function exportCube(size: number) {
  const p = state.cur; if (!p) return;
  const lut = bakeColorLut(buildColorFn(p.settings, p.target), size);
  download(new Blob([lutToCube(lut, size, `Snap Lens ${baseName(p.name)}`)], { type: 'text/plain' }), `${slug(baseName(p.name))}-look-${size}.cube`);
  toast('LUT exported (color and tone only)');
}

// ---------- Assemble panels ----------
function buildSide() {
  section('copy', 'Copy style from reference', 'Copy', buildCopy(), { open: true, hero: true });
  section('presets', 'Presets', 'Presets', buildPresets());
  section('basic', 'Basic', 'Light', buildBasic(), { open: true });
  section('curve', 'Tone curve', 'Curve', buildCurve());
  section('mixer', 'Color mixer', 'Mixer', buildMixer());
  section('grading', 'Color grading', 'Grading', buildGrading());
  section('detail', 'Detail', 'Detail', buildDetail());
  section('effects', 'Effects', 'Effects', buildEffects());
  section('geometry', 'Crop and rotate', 'Crop', buildGeometry());
  section('export', 'Export', 'Export', buildExport());

  const side = $('side'), tabbar = $('tabbar');
  const hist = el('div', { class: 'hist-card' }, el('canvas', { id: 'hist', width: '600', height: '180', 'aria-label': 'RGB histogram' }));
  side.append(hist);
  let active = 'copy';
  const setActive = (id: string) => {
    active = id;
    for (const s of sections) { s.body.parentElement!.classList.toggle('active', s.id === id); }
    tabbar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.id === id));
    if (id === 'geometry' && isSmall() && state.cur && !state.cropMode) setCropMode(true);
    if (id !== 'geometry' && state.cropMode && isSmall()) setCropMode(false);
  };
  for (const s of sections) {
    const head = el('button', { class: 'sec-head', type: 'button', 'aria-expanded': String(!!s.open) }, el('span', { text: s.title }), el('span', { class: 'chev', 'aria-hidden': 'true' }));
    const body = el('div', { class: 'sec-body' }); body.append(s.body);
    const wrap = el('section', { class: 'sec' + (s.open ? ' open' : '') + (s.hero ? ' hero' : ''), id: `sec-${s.id}` }, head, body);
    s.body = body;
    head.onclick = () => { const o = wrap.classList.toggle('open'); head.setAttribute('aria-expanded', String(o)); if (o && s.id === 'curve') curveUI?.draw(); };
    side.append(wrap);
    const t = el('button', { type: 'button', text: s.short }); t.dataset.id = s.id; t.onclick = () => setActive(s.id);
    tabbar.append(t);
  }
  setActive(active);
}

// ---------- Inputs, keyboard, paste ----------
function initInputs() {
  const open = $<HTMLInputElement>('openInput');
  $('openBtn').onclick = () => open.click(); $('emptyOpen').onclick = () => open.click();
  open.onchange = () => { void addPhotos(imageFiles(open.files)); open.value = ''; };
  const stage = $('stage');
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('over'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('over'));
  stage.addEventListener('drop', (e) => { e.preventDefault(); stage.classList.remove('over'); void addPhotos(imageFiles(e.dataTransfer?.files)); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  window.addEventListener('paste', (e) => {
    const files = imageFiles(Array.from(e.clipboardData?.items || []).map((i) => i.getAsFile()).filter((f): f is File => !!f));
    if (!files.length) return;
    e.preventDefault();
    const copyFocused = !!document.activeElement?.closest('#sec-copy') || $('sec-copy').classList.contains('active') && isSmall();
    if (state.cur && (copyFocused || !state.refs.length)) { void addRefs(files); toast('Pasted as reference photo'); }
    else { void addPhotos(files); toast('Pasted as photo to edit'); }
  });
  $('undoBtn').onclick = () => undoRedo(-1); $('redoBtn').onclick = () => undoRedo(1);
  $('resetAll').onclick = () => { if (!state.cur) return; const g = S(); setSettings({ ...defaultSettings(), rot90: g.rot90, straighten: g.straighten, flipH: g.flipH, flipV: g.flipV, crop: g.crop, aspect: g.aspect }); state.cur.copyFit = null; renderCopyReport(); toast('All adjustments reset'); };
  const toggle = (key: 'splitOn' | 'before', btn: string) => { state[key] = !state[key]; $(btn).setAttribute('aria-pressed', String(state[key])); $(btn).classList.toggle('on', state[key]); scheduleRender(); };
  $('splitBtn').onclick = () => toggle('splitOn', 'splitBtn');
  $('beforeBtn').onclick = () => toggle('before', 'beforeBtn');
  $('exportQuick').onclick = () => { const sec = $('sec-export'); sec.classList.add('open'); (document.querySelector('#tabbar button[data-id="export"]') as HTMLButtonElement)?.click(); sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  window.addEventListener('keydown', (e) => {
    const typing = (e.target as HTMLElement).matches('input[type=text], textarea, select');
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undoRedo(e.shiftKey ? 1 : -1); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); undoRedo(1); }
    else if (!typing && e.key === '\\') $('beforeBtn').click();
    else if (!typing && e.key === 'Escape' && state.cropMode) setCropMode(false);
  });
}

buildSide();
initInputs();
initViewer();
initCrop();
renderRefs(); renderCopyReport(); syncAll();

// Hooks for automated screenshots and performance checks.
(window as unknown as Record<string, unknown>).__sl = { addPhotos, addRefs, state, perf, renderNow, setSettings, runCopy, selectPhoto, S: () => state.cur?.settings, setCropMode };
