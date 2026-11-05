// User presets in localStorage. A preset holds look settings (no geometry) and,
// for copied styles, a compact reference sample so the look can be refitted per photo.
import type { Preset, Settings } from './core/settings.js';
import type { SpatialFeatures } from './core/fit.js';

export interface UserPreset extends Preset {
  reference?: { samples: string; spatial?: SpatialFeatures; aspects?: Record<string, boolean>; strength?: number };
}

const KEY = 'snap-lens.presets.v1';

export function loadPresets(): UserPreset[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v.filter(isPreset) : [];
  } catch { return []; }
}
export function savePresets(list: UserPreset[]): void { localStorage.setItem(KEY, JSON.stringify(list)); }

function isPreset(p: unknown): p is UserPreset {
  const o = p as UserPreset;
  return !!o && typeof o.name === 'string' && !!o.settings && typeof o.settings === 'object';
}

export function parsePresetFile(text: string): UserPreset[] {
  const data = JSON.parse(text);
  const items = Array.isArray(data) ? data : Array.isArray(data?.presets) ? data.presets : [data];
  const out = items.filter(isPreset).map((p: UserPreset) => ({ ...p, id: newId(), builtin: false }));
  if (!out.length) throw new Error('No valid presets found in this file');
  return out;
}

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/** Float sRGB samples (0..1) <-> base64 of bytes, to keep presets small. */
export function encodeSamples(s: Float32Array): string {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = Math.round(s[i] * 255);
  let str = '';
  for (let i = 0; i < b.length; i += 0x8000) str += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(str);
}
export function decodeSamples(b64: string): Float32Array {
  const str = atob(b64), out = new Float32Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) / 255;
  return out;
}
export type { Settings };
