// Color space conversions. All values are floats; sRGB in [0,1].

export type Space = 'oklab' | 'lab';

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

// Lookup table for 8-bit sRGB -> linear, used on hot paths.
export const SRGB8_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) SRGB8_TO_LINEAR[i] = srgbToLinear(i / 255);

/** Linear RGB -> Oklab (Bjorn Ottosson, 2020). Writes into out. */
export function linearToOklab(r: number, g: number, b: number, out: number[] | Float32Array, o = 0): void {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[o] = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  out[o + 1] = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
}

export function oklabToLinear(L: number, a: number, b: number, out: number[] | Float32Array, o = 0): void {
  const l = L + 0.3963377774 * a + 0.2158037573 * b;
  const m = L - 0.1055613458 * a - 0.0638541728 * b;
  const s = L - 0.0894841775 * a - 1.291485548 * b;
  const l3 = l * l * l, m3 = m * m * m, s3 = s * s * s;
  out[o] = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  out[o + 1] = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  out[o + 2] = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;
}

// CIE Lab (D65), scaled by 1/100 so L is in [0,1] like Oklab.
const XN = 0.95047, YN = 1.0, ZN = 1.08883;
const fLab = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const fLabInv = (t: number) => (t * t * t > 216 / 24389 ? t * t * t : (116 * t - 16) * 27 / 24389);

export function linearToLab(r: number, g: number, b: number, out: number[] | Float32Array, o = 0): void {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN;
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / YN;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / ZN;
  const fx = fLab(x), fy = fLab(y), fz = fLab(z);
  out[o] = (116 * fy - 16) / 100;
  out[o + 1] = (500 * (fx - fy)) / 100;
  out[o + 2] = (200 * (fy - fz)) / 100;
}

export function labToLinear(L: number, a: number, b: number, out: number[] | Float32Array, o = 0): void {
  const fy = (L * 100 + 16) / 116;
  const fx = fy + (a * 100) / 500;
  const fz = fy - (b * 100) / 200;
  const x = fLabInv(fx) * XN, y = fLabInv(fy) * YN, z = fLabInv(fz) * ZN;
  out[o] = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  out[o + 1] = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  out[o + 2] = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
}

export function toPerceptual(space: Space) {
  return space === 'oklab' ? linearToOklab : linearToLab;
}
export function fromPerceptual(space: Space) {
  return space === 'oklab' ? oklabToLinear : labToLinear;
}

export function hex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}
