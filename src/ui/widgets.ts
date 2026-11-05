// Small UI building blocks: sliders, curve editor, color wheels, histogram.
import { curveTable } from '../core/develop.js';
import { oklabToLinear, linearToSrgb } from '../core/color.js';
import type { CurvePoints } from '../core/settings.js';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}

export interface SliderOpts {
  label: string; min: number; max: number; step?: number; def?: number;
  get: () => number; set: (v: number) => void;
  onInput: () => void; onCommit: () => void;
  fmt?: (v: number) => string; track?: string; title?: string;
}
export interface SliderHandle { root: HTMLElement; sync: () => void }

/** Labeled range input. Double-click (or double-tap) the slider or label to reset to default. */
export function slider(o: SliderOpts): SliderHandle {
  const id = 'sl-' + Math.random().toString(36).slice(2, 8);
  const input = el('input', { type: 'range', id, min: String(o.min), max: String(o.max), step: String(o.step ?? 1) });
  const out = el('output', { for: id });
  const label = el('label', { for: id, text: o.label });
  if (o.title) label.title = o.title;
  const root = el('div', { class: 'sl' }, label, out, input);
  if (o.track) input.style.setProperty('--track', o.track);
  const fmt = o.fmt ?? ((v: number) => (v > 0 && o.min < 0 ? '+' : '') + String(Math.round(v * 100) / 100));
  const sync = () => { const v = o.get(); input.value = String(v); out.textContent = fmt(v); root.classList.toggle('changed', v !== (o.def ?? 0)); };
  input.addEventListener('input', () => { o.set(Number(input.value)); out.textContent = fmt(Number(input.value)); root.classList.toggle('changed', Number(input.value) !== (o.def ?? 0)); o.onInput(); });
  input.addEventListener('change', () => o.onCommit());
  const reset = () => { o.set(o.def ?? 0); sync(); o.onInput(); o.onCommit(); };
  input.addEventListener('dblclick', reset);
  label.addEventListener('dblclick', reset);
  sync();
  return { root, sync };
}

export const fmtSigned = (d = 0) => (v: number) => (v > 0 ? '+' : '') + v.toFixed(d);

// ---------- Curve editor ----------
export interface CurveEditor { root: HTMLElement; draw: () => void; setHistogram: (h: Uint32Array[] | null) => void }

export function curveEditor(get: () => CurvePoints, set: (p: CurvePoints) => void, color: () => string, onInput: () => void, onCommit: () => void): CurveEditor {
  const cv = el('canvas', { class: 'curve', width: '600', height: '600', 'aria-label': 'Tone curve editor. Drag points, click to add, double-click a point to remove.' });
  let hist: Uint32Array[] | null = null;
  let drag = -1;
  const pos = (e: PointerEvent): [number, number] => {
    const r = cv.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))];
  };
  const nearest = (x: number, y: number) => {
    const pts = get(); let best = -1, bd = 0.05;
    pts.forEach(([px, py], i) => { const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  cv.addEventListener('pointerdown', (e) => {
    const [x, y] = pos(e);
    let i = nearest(x, y);
    if (i < 0) {
      const pts = get().slice(); pts.push([x, y]); pts.sort((a, b) => a[0] - b[0]);
      set(pts); i = pts.findIndex((p) => p[0] === x && p[1] === y);
      onInput();
    }
    drag = i; cv.setPointerCapture(e.pointerId); draw();
  });
  cv.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const [x, y] = pos(e);
    const pts = get().slice();
    const lo = drag > 0 ? pts[drag - 1][0] + 0.01 : 0, hi = drag < pts.length - 1 ? pts[drag + 1][0] - 0.01 : 1;
    pts[drag] = [Math.min(hi, Math.max(lo, x)), y];
    set(pts); onInput(); draw();
  });
  const end = () => { if (drag >= 0) { drag = -1; onCommit(); } };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.addEventListener('dblclick', (e) => {
    const [x, y] = pos(e as PointerEvent);
    const i = nearest(x, y), pts = get();
    if (i > 0 && i < pts.length - 1) { set(pts.filter((_, k) => k !== i)); onInput(); onCommit(); draw(); }
  });
  function draw() {
    const c = cv.getContext('2d')!, W = cv.width, H = cv.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = '#1b1c1e'; c.fillRect(0, 0, W, H);
    if (hist) {
      const sum = hist[0].map((v, i) => v + hist![1][i] + hist![2][i]);
      const mx = Math.max(...Array.from(sum).slice(2, 254)) || 1;
      c.fillStyle = 'rgba(255,255,255,0.08)';
      c.beginPath(); c.moveTo(0, H);
      for (let i = 0; i < 256; i++) c.lineTo((i / 255) * W, H - Math.min(1, sum[i] / mx) * H * 0.9);
      c.lineTo(W, H); c.fill();
    }
    c.strokeStyle = 'rgba(255,255,255,0.1)'; c.lineWidth = 2;
    for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo((i * W) / 4, 0); c.lineTo((i * W) / 4, H); c.moveTo(0, (i * H) / 4); c.lineTo(W, (i * H) / 4); c.stroke(); }
    c.beginPath(); c.moveTo(0, H); c.lineTo(W, 0); c.strokeStyle = 'rgba(255,255,255,0.15)'; c.stroke();
    const t = curveTable(get(), 300);
    c.beginPath(); t.forEach((v, i) => (i ? c.lineTo((i / 299) * W, H - v * H) : c.moveTo(0, H - v * H)));
    c.strokeStyle = color(); c.lineWidth = 4; c.stroke();
    for (const [x, y] of get()) { c.beginPath(); c.arc(x * W, H - y * H, 12, 0, 7); c.fillStyle = '#fff'; c.fill(); c.strokeStyle = '#000'; c.lineWidth = 2; c.stroke(); }
  }
  draw();
  return { root: cv, draw, setHistogram: (h) => { hist = h; draw(); } };
}

// ---------- Color wheel (Oklab hue and chroma) ----------
let wheelImage: ImageData | null = null;
function wheelPixels(size: number): ImageData {
  if (wheelImage && wheelImage.width === size) return wheelImage;
  const img = new ImageData(size, size), lin = [0, 0, 0];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (x - size / 2) / (size / 2), dy = -(y - size / 2) / (size / 2), r = Math.hypot(dx, dy);
    const i = (y * size + x) * 4;
    if (r > 1) { img.data[i + 3] = 0; continue; }
    const h = Math.atan2(dy, dx);
    oklabToLinear(0.72, Math.cos(h) * r * 0.13, Math.sin(h) * r * 0.13, lin);
    img.data[i] = linearToSrgb(Math.min(1, Math.max(0, lin[0]))) * 255;
    img.data[i + 1] = linearToSrgb(Math.min(1, Math.max(0, lin[1]))) * 255;
    img.data[i + 2] = linearToSrgb(Math.min(1, Math.max(0, lin[2]))) * 255;
    img.data[i + 3] = r > 0.97 ? (1 - r) / 0.03 * 255 : 255;
  }
  return (wheelImage = img);
}

export interface WheelHandle { root: HTMLElement; sync: () => void }
export function colorWheel(label: string, get: () => { h: number; s: number }, set: (h: number, s: number) => void, onInput: () => void, onCommit: () => void): WheelHandle {
  const size = 240;
  const cv = el('canvas', { class: 'wheel', width: String(size), height: String(size), 'aria-label': `${label} color wheel` });
  const out = el('output', { class: 'wheel-val' });
  const root = el('div', { class: 'wheel-box' }, el('div', { class: 'wheel-title', text: label }), cv, out);
  const draw = () => {
    const c = cv.getContext('2d')!;
    c.clearRect(0, 0, size, size);
    c.putImageData(wheelPixels(size), 0, 0);
    const { h, s } = get();
    const r = (Math.min(100, s) / 100) * (size / 2), a = (h * Math.PI) / 180;
    const x = size / 2 + Math.cos(a) * r, y = size / 2 - Math.sin(a) * r;
    c.beginPath(); c.arc(x, y, 9, 0, 7); c.lineWidth = 3; c.strokeStyle = '#fff'; c.stroke();
    c.beginPath(); c.arc(x, y, 11, 0, 7); c.lineWidth = 1.5; c.strokeStyle = 'rgba(0,0,0,.6)'; c.stroke();
    out.textContent = s ? `Hue ${Math.round(h)}  Sat ${Math.round(s)}` : 'Neutral';
  };
  let dragging = false;
  const move = (e: PointerEvent) => {
    const r = cv.getBoundingClientRect();
    const dx = (e.clientX - r.left - r.width / 2) / (r.width / 2), dy = -(e.clientY - r.top - r.height / 2) / (r.height / 2);
    const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360, s = Math.min(100, Math.hypot(dx, dy) * 100);
    set(Math.round(h), Math.round(s)); draw(); onInput();
  };
  cv.addEventListener('pointerdown', (e) => { dragging = true; cv.setPointerCapture(e.pointerId); move(e); });
  cv.addEventListener('pointermove', (e) => dragging && move(e));
  const end = () => { if (dragging) { dragging = false; onCommit(); } };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.addEventListener('dblclick', () => { set(0, 0); draw(); onInput(); onCommit(); });
  draw();
  return { root, sync: draw };
}

// ---------- Histogram ----------
export function computeHistogram(px: Uint8ClampedArray): Uint32Array[] {
  const h = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < px.length; i += 4) { h[0][px[i]]++; h[1][px[i + 1]]++; h[2][px[i + 2]]++; }
  return h;
}
export function drawHistogram(cv: HTMLCanvasElement, h: Uint32Array[] | null) {
  const c = cv.getContext('2d')!, W = cv.width, H = cv.height;
  c.clearRect(0, 0, W, H);
  if (!h) return;
  let mx = 1;
  for (const ch of h) for (let i = 1; i < 255; i++) mx = Math.max(mx, ch[i]);
  c.globalCompositeOperation = 'lighter';
  ['rgba(230,70,70,0.75)', 'rgba(70,200,90,0.75)', 'rgba(80,120,240,0.85)'].forEach((col, k) => {
    c.fillStyle = col; c.beginPath(); c.moveTo(0, H);
    for (let i = 0; i < 256; i++) c.lineTo((i / 255) * W, H - Math.min(1, Math.sqrt(h[k][i] / mx)) * H * 0.95);
    c.lineTo(W, H); c.closePath(); c.fill();
  });
  c.globalCompositeOperation = 'source-over';
}
