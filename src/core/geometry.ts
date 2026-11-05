// Geometry: quarter turns, straighten, flips and crop, as an affine map
// from output pixel coordinates (normalized 0..1 in the crop) to source UV (0..1).
import type { Settings } from './settings.js';

export interface Geo { outW: number; outH: number; frameW: number; frameH: number; m: Float32Array /* 3x3 column-major */ }

/** Scale so the straightened image still covers the whole frame (no empty corners). */
export function coverScale(w: number, h: number, deg: number): number {
  const a = Math.abs((deg * Math.PI) / 180), c = Math.cos(a), s = Math.sin(a);
  return Math.max((w * c + h * s) / w, (w * s + h * c) / h);
}

export function computeGeometry(s: Pick<Settings, 'rot90' | 'straighten' | 'flipH' | 'flipV' | 'crop'>, srcW: number, srcH: number, ignoreCrop = false): Geo {
  const q = ((s.rot90 % 4) + 4) % 4;
  const frameW = q % 2 ? srcH : srcW, frameH = q % 2 ? srcW : srcH;
  const crop = ignoreCrop ? { x: 0, y: 0, w: 1, h: 1 } : s.crop;
  const outW = Math.max(1, Math.round(crop.w * frameW)), outH = Math.max(1, Math.round(crop.h * frameH));
  const sc = coverScale(frameW, frameH, s.straighten);
  const a = (-s.straighten * Math.PI) / 180;
  // Build the chain: out uv -> frame px (centered) -> unstraighten -> unrotate quarter turns -> unflip -> src uv.
  const mul = (A: number[], B: number[]) => { // 3x3 row-major multiply
    const R = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) R[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
    return R;
  };
  let M = [crop.w * frameW, 0, (crop.x - 0.5) * frameW, 0, crop.h * frameH, (crop.y - 0.5) * frameH, 0, 0, 1];
  const ca = Math.cos(a) / sc, sa = Math.sin(a) / sc;
  M = mul([ca, -sa, 0, sa, ca, 0, 0, 0, 1], M);
  // Inverse of a clockwise quarter turn q: rotate counterclockwise q times. In y-down coordinates
  // a clockwise turn maps (x, y) -> (-y, x); its inverse maps (x, y) -> (y, -x).
  for (let i = 0; i < q; i++) M = mul([0, 1, 0, -1, 0, 0, 0, 0, 1], M);
  M = mul([(s.flipH ? -1 : 1) / srcW, 0, 0.5, 0, (s.flipV ? -1 : 1) / srcH, 0.5, 0, 0, 1], M);
  // Convert to column-major for GLSL.
  const m = new Float32Array([M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]]);
  return { outW, outH, frameW, frameH, m };
}

/** Applies the geometry matrix to an output uv, returning the source uv. */
export function mapPoint(g: Geo, u: number, v: number): [number, number] {
  const m = g.m;
  return [m[0] * u + m[3] * v + m[6], m[1] * u + m[4] * v + m[7]];
}
