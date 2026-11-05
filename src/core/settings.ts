// Non-destructive edit settings. The original image is never modified;
// every render runs the pipeline with one of these objects.
import type { StyleData } from './stats.js';
import type { Method } from './transfer.js';
import type { Space } from './color.js';

export type CurvePoints = [number, number][];
export interface Wheel { h: number; s: number; l: number }   // h in degrees, s 0..100, l -100..100

export interface CopyStyle {
  style: StyleData;
  method: Method;
  space: Space;
  strength: number;      // 0..100
  lumStrength: number;   // 0..100
  colorStrength: number; // 0..100
}

export interface Settings {
  temp: number; tint: number;                      // -100..100
  exposure: number;                                // EV, -5..5
  contrast: number; highlights: number; shadows: number; whites: number; blacks: number; // -100..100
  texture: number; clarity: number; dehaze: number; // -100..100
  vibrance: number; saturation: number;            // -100..100
  curve: { rgb: CurvePoints; r: CurvePoints; g: CurvePoints; b: CurvePoints };
  hsl: { hue: number[]; sat: number[]; lum: number[] };  // 8 bands, -100..100
  grading: { shadows: Wheel; midtones: Wheel; highlights: Wheel; blending: number; balance: number };
  sharpen: number; sharpenRadius: number;          // 0..150, 0.5..3 px
  noise: number;                                   // 0..100
  vignette: number; vignetteMid: number; vignetteFeather: number; // -100..100, 0..100, 0..100
  grain: number; grainSize: number;                // 0..100
  rot90: number;                                   // 0..3 quarter turns clockwise
  straighten: number;                              // degrees, -45..45
  flipH: boolean; flipV: boolean;
  crop: { x: number; y: number; w: number; h: number }; // normalized, in the rotated frame
  aspect: string;                                  // 'free' | 'original' | 'w:h'
  copy: CopyStyle | null;
}

export const HSL_BANDS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'];

const identityCurve = (): CurvePoints => [[0, 0], [1, 1]];
const wheel = (): Wheel => ({ h: 0, s: 0, l: 0 });

export function defaultSettings(): Settings {
  return {
    temp: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    texture: 0, clarity: 0, dehaze: 0, vibrance: 0, saturation: 0,
    curve: { rgb: identityCurve(), r: identityCurve(), g: identityCurve(), b: identityCurve() },
    hsl: { hue: Array(8).fill(0), sat: Array(8).fill(0), lum: Array(8).fill(0) },
    grading: { shadows: wheel(), midtones: wheel(), highlights: wheel(), blending: 50, balance: 0 },
    sharpen: 0, sharpenRadius: 1, noise: 0,
    vignette: 0, vignetteMid: 50, vignetteFeather: 50, grain: 0, grainSize: 25,
    rot90: 0, straighten: 0, flipH: false, flipV: false,
    crop: { x: 0, y: 0, w: 1, h: 1 }, aspect: 'original',
    copy: null,
  };
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Keys that describe the photo geometry; excluded from presets and copy/paste. */
export const GEOMETRY_KEYS = ['rot90', 'straighten', 'flipH', 'flipV', 'crop', 'aspect'] as const;

/** Merge a partial settings object (preset, pasted settings, import) over a base, ignoring unknown keys. */
export function mergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  const out = clone(base);
  const def = defaultSettings() as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in def)) continue;
    const d = def[k];
    if (k === 'copy') { (out as unknown as Record<string, unknown>)[k] = v ? clone(v) : null; continue; }
    if (typeof d === 'number' && typeof v === 'number' && Number.isFinite(v)) (out as unknown as Record<string, unknown>)[k] = v;
    else if (typeof d === 'boolean' && typeof v === 'boolean') (out as unknown as Record<string, unknown>)[k] = v;
    else if (typeof d === 'string' && typeof v === 'string') (out as unknown as Record<string, unknown>)[k] = v;
    else if (d && typeof d === 'object' && v && typeof v === 'object') (out as unknown as Record<string, unknown>)[k] = { ...clone(d), ...clone(v) };
  }
  return out;
}

/** Settings without geometry, for presets and copy/paste. */
export function lookOnly(s: Settings): Partial<Settings> {
  const o = clone(s) as Partial<Settings>;
  for (const k of GEOMETRY_KEYS) delete o[k];
  return o;
}

export interface Preset { id: string; name: string; builtin?: boolean; settings: Partial<Settings> }

const curve = (...pts: CurvePoints) => pts;

export const BUILTIN_PRESETS: Preset[] = [
  { id: 'b-natural', name: 'Natural Pop', builtin: true, settings: { contrast: 12, highlights: -25, shadows: 20, whites: 8, blacks: -6, clarity: 12, vibrance: 22, saturation: 4 } },
  { id: 'b-warm', name: 'Warm Afternoon', builtin: true, settings: { temp: 22, tint: 4, exposure: 0.1, contrast: 8, highlights: -20, shadows: 12, vibrance: 15,
    grading: { shadows: { h: 30, s: 10, l: 0 }, midtones: { h: 40, s: 8, l: 0 }, highlights: { h: 50, s: 14, l: 0 }, blending: 50, balance: 0 } } },
  { id: 'b-matte', name: 'Cool Matte', builtin: true, settings: { temp: -12, contrast: -15, highlights: -15, shadows: 15, saturation: -18,
    curve: { rgb: curve([0, 0.08], [0.25, 0.27], [0.75, 0.76], [1, 0.95]), r: curve([0, 0], [1, 1]), g: curve([0, 0], [1, 1]), b: curve([0, 0.03], [1, 1]) } } },
  { id: 'b-film', name: 'Faded Film', builtin: true, settings: { contrast: -8, highlights: -18, saturation: -12, vibrance: 6, grain: 22, grainSize: 30, vignette: -14,
    curve: { rgb: curve([0, 0.06], [0.3, 0.3], [0.7, 0.72], [1, 0.96]), r: curve([0, 0.02], [1, 1]), g: curve([0, 0], [1, 1]), b: curve([0, 0.05], [1, 0.95]) },
    grading: { shadows: { h: 200, s: 12, l: 0 }, midtones: { h: 0, s: 0, l: 0 }, highlights: { h: 45, s: 16, l: 0 }, blending: 60, balance: 0 } } },
  { id: 'b-teal', name: 'Teal and Orange', builtin: true, settings: { contrast: 15, highlights: -10, shadows: 8, vibrance: 10,
    hsl: { hue: [0, 0, -10, 30, 0, -8, 0, 0], sat: [0, 15, -10, -30, 10, 10, -20, -20], lum: [0, 8, 0, -10, 0, -10, 0, 0] },
    grading: { shadows: { h: 195, s: 28, l: -4 }, midtones: { h: 0, s: 0, l: 0 }, highlights: { h: 35, s: 24, l: 0 }, blending: 55, balance: -5 } } },
  { id: 'b-bw', name: 'Bold Black and White', builtin: true, settings: { saturation: -100, contrast: 30, highlights: -10, shadows: 10, whites: 12, blacks: -12, clarity: 18,
    hsl: { hue: Array(8).fill(0), sat: Array(8).fill(0), lum: [10, 15, 10, -10, -20, -30, 0, 0] } } },
  { id: 'b-soft', name: 'Soft Pastel', builtin: true, settings: { exposure: 0.2, contrast: -20, highlights: -10, shadows: 25, clarity: -12, saturation: -10, vibrance: 15,
    curve: { rgb: curve([0, 0.05], [0.5, 0.55], [1, 1]), r: curve([0, 0], [1, 1]), g: curve([0, 0], [1, 1]), b: curve([0, 0], [1, 1]) } } },
];
