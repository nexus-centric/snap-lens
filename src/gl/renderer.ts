// WebGL2 renderer. Spatial operations (noise reduction, texture, clarity, dehaze,
// sharpening, vignette, grain) run in fragment shaders; all color-only operations
// arrive as a baked 3D LUT built by the CPU pipeline in core/develop.ts.
import type { Settings } from '../core/settings.js';
import { computeGeometry, Geo } from '../core/geometry.js';

const VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

// Separable Gaussian blur with a fixed tap count and a stride for large radii.
const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform vec2 uDir; uniform float uSigma;
void main() {
  float stride = max(1.0, uSigma * 3.0 / 12.0);
  vec4 acc = vec4(0.0); float wsum = 0.0;
  for (int i = -12; i <= 12; i++) {
    float x = float(i) * stride;
    float w = exp(-0.5 * x * x / (uSigma * uSigma));
    acc += texture(uTex, vUv + uDir * x) * w; wsum += w;
  }
  o = acc / wsum;
}`;

const MAIN_FS = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv; out vec4 o;
uniform sampler2D uSrc, uBS, uBM, uBL;
uniform sampler3D uLut;
uniform float uLutSize;
uniform mat3 uGeo;
uniform vec2 uOut;        // output size in pixels
uniform float uScale;     // full-resolution pixels per output pixel
uniform float uSplit;     // 0..1: left part shows the original
uniform float uNoise, uTexture, uClarity, uDehaze, uSharpen;
uniform float uVig, uVigMid, uVigFeather, uGrain, uGrainSize;
uniform float uFlipY;     // 1 when rendering to the canvas
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  vec2 uv = vec2(vUv.x, uFlipY > 0.5 ? 1.0 - vUv.y : vUv.y);
  vec2 suv = (uGeo * vec3(uv, 1.0)).xy;
  vec3 c = texture(uSrc, suv).rgb;
  if (vUv.x < uSplit) { o = vec4(c, 1.0); return; }
  if (uNoise > 0.0) {
    vec3 bm = texture(uBM, suv).rgb; vec3 d = c - bm;
    float w = exp(-dot(d, d) / (0.0015 + 0.02 * uNoise));
    c = mix(c, bm, clamp(uNoise * 1.2, 0.0, 1.0) * w);
  }
  if (uTexture != 0.0) c += uTexture * 0.8 * (c - texture(uBM, suv).rgb);
  if (uClarity != 0.0 || uDehaze != 0.0) {
    vec3 bl = texture(uBL, suv).rgb;
    float l = luma(c), lb = luma(bl);
    float mid = clamp(1.0 - pow(2.0 * l - 1.0, 2.0), 0.0, 1.0);
    c += uClarity * 0.7 * (l - lb) * mid;
    float dc = min(bl.r, min(bl.g, bl.b));
    if (uDehaze > 0.0) {
      float t = max(0.2, 1.0 - uDehaze * 0.8 * dc);
      vec3 A = vec3(0.92);
      c = (c - A) / t + A;
    } else if (uDehaze < 0.0) {
      c = mix(c, vec3(0.82), -uDehaze * 0.45);
    }
  }
  if (uSharpen > 0.0) c += uSharpen * (luma(c) - luma(texture(uBS, suv).rgb));
  c = clamp(c, 0.0, 1.0);
  c = texture(uLut, c * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize).rgb;
  if (uVig != 0.0) {
    vec2 p = (uv - 0.5) * 2.0;
    float r = length(p) * 0.7071;
    float m0 = mix(0.15, 0.85, uVigMid);
    float mask = smoothstep(m0, m0 + mix(0.05, 0.9, uVigFeather), r);
    c = uVig < 0.0 ? c * (1.0 + uVig * mask) : mix(c, vec3(1.0), uVig * mask);
  }
  if (uGrain > 0.0) {
    float cell = 1.0 + uGrainSize * 3.0;
    vec2 gp = uv * uOut * uScale / cell;
    float n = vnoise(gp) * 0.6 + vnoise(gp * 2.1 + 17.0) * 0.4;
    float l = luma(c);
    c += (n - 0.5) * uGrain * 0.22 * (0.35 + 2.6 * l * (1.0 - l));
  }
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

interface Target { tex: WebGLTexture; fb: WebGLFramebuffer; w: number; h: number }

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private blurProg: WebGLProgram; private mainProg: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private src: Target | null = null;
  private srcFull = { w: 0, h: 0 }; // full-resolution size of the photo
  private blurs = new Map<string, { key: string; t: Target }>();
  private tmp: Target | null = null; private tmpSmall: Target | null = null; private small: Target | null = null;
  private lut: WebGLTexture; private lutSize = 0;
  private dummy: WebGLTexture;
  readonly maxTex: number;

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.blurProg = this.program(BLUR_FS); this.mainProg = this.program(MAIN_FS);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    for (const p of [this.blurProg, this.mainProg]) {
      const loc = gl.getAttribLocation(p, 'aPos');
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    this.lut = gl.createTexture()!;
    this.dummy = this.makeTex(1, 1);
  }

  private program(fs: string): WebGLProgram {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader error');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link error');
    return p;
  }

  private makeTex(w: number, h: number, data: TexImageSource | null = null): WebGLTexture {
    const gl = this.gl, t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (data) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, data);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  private makeTarget(w: number, h: number, data: TexImageSource | null = null): Target {
    const gl = this.gl, tex = this.makeTex(w, h, data), fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h };
  }
  private free(t: Target | null) { if (t) { this.gl.deleteTexture(t.tex); this.gl.deleteFramebuffer(t.fb); } }

  /** Upload the (preview-sized) source image. fullW/fullH is the original resolution. */
  setSource(img: TexImageSource & { width: number; height: number }, fullW: number, fullH: number) {
    this.free(this.src); this.free(this.tmp); this.free(this.tmpSmall); this.free(this.small);
    for (const b of this.blurs.values()) this.free(b.t);
    this.blurs.clear();
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.src = this.makeTarget(img.width, img.height, img);
    this.srcFull = { w: fullW, h: fullH };
    this.tmp = this.makeTarget(img.width, img.height);
    const sw = Math.max(1, Math.round(img.width / 4)), shh = Math.max(1, Math.round(img.height / 4));
    this.small = this.makeTarget(sw, shh); this.tmpSmall = this.makeTarget(sw, shh);
  }
  get sourceSize() { return this.src ? { w: this.src.w, h: this.src.h } : { w: 0, h: 0 }; }
  /** Full-resolution pixels per source texel. */
  get scale() { return this.src ? this.srcFull.w / this.src.w : 1; }

  setLut(data: Float32Array, size: number) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_3D, this.lut);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, size, size, size, 0, gl.RGB, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    this.lutSize = size;
  }

  private blurPass(from: Target, to: Target, dir: [number, number], sigma: number) {
    const gl = this.gl;
    gl.useProgram(this.blurProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, to.fb);
    gl.viewport(0, 0, to.w, to.h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, from.tex);
    gl.uniform1i(gl.getUniformLocation(this.blurProg, 'uTex'), 0);
    gl.uniform2f(gl.getUniformLocation(this.blurProg, 'uDir'), dir[0] / from.w, dir[1] / from.h);
    gl.uniform1f(gl.getUniformLocation(this.blurProg, 'uSigma'), Math.max(0.3, sigma));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Returns a cached blurred copy of the source. sigmaFull is in full-resolution pixels. */
  private blurred(name: string, sigmaFull: number, quarter: boolean): Target {
    const sigma = sigmaFull / this.scale / (quarter ? 4 : 1);
    const key = sigma.toFixed(3);
    const hit = this.blurs.get(name);
    if (hit && hit.key === key) return hit.t;
    const src = this.src!;
    let t = hit?.t;
    const w = quarter ? this.small!.w : src.w, h = quarter ? this.small!.h : src.h;
    if (!t) t = this.makeTarget(w, h);
    if (quarter) {
      this.blurPass(src, this.small!, [0, 0], 0.3); // plain downsample
      this.blurPass(this.small!, this.tmpSmall!, [1, 0], sigma);
      this.blurPass(this.tmpSmall!, t, [0, 1], sigma);
    } else {
      this.blurPass(src, this.tmp!, [1, 0], sigma);
      this.blurPass(this.tmp!, t, [0, 1], sigma);
    }
    this.blurs.set(name, { key, t });
    return t;
  }

  geometry(s: Settings, ignoreCrop = false): Geo {
    return computeGeometry(s, this.src!.w, this.src!.h, ignoreCrop);
  }

  /**
   * Render the photo. With target null the canvas is resized and drawn; otherwise
   * the result goes into an offscreen framebuffer of the given size (for histogram and export).
   */
  render(s: Settings, opts: { split?: number; ignoreCrop?: boolean; outW?: number; outH?: number; fb?: WebGLFramebuffer | null } = {}): Geo {
    const gl = this.gl;
    if (!this.src || !this.lutSize) throw new Error('Nothing to render');
    const geo = this.geometry(s, opts.ignoreCrop);
    const fullLong = Math.max(this.srcFull.w, this.srcFull.h);
    const needBS = s.sharpen > 0, needBM = s.noise > 0 || s.texture !== 0, needBL = s.clarity !== 0 || s.dehaze !== 0;
    const bs = needBS ? this.blurred('s', s.sharpenRadius, false).tex : this.dummy;
    const bm = needBM ? this.blurred('m', Math.max(2, fullLong / 1500), false).tex : this.dummy;
    const bl = needBL ? this.blurred('l', fullLong * 0.012, true).tex : this.dummy;
    const outW = opts.outW ?? geo.outW, outH = opts.outH ?? geo.outH;
    const toCanvas = opts.fb === undefined;
    if (toCanvas && (this.canvas.width !== outW || this.canvas.height !== outH)) { this.canvas.width = outW; this.canvas.height = outH; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, toCanvas ? null : opts.fb!);
    gl.viewport(0, 0, outW, outH);
    const p = this.mainProg;
    gl.useProgram(p);
    const u = (n: string) => gl.getUniformLocation(p, n);
    const texs: [string, WebGLTexture, number][] = [['uSrc', this.src.tex, gl.TEXTURE_2D], ['uBS', bs, gl.TEXTURE_2D], ['uBM', bm, gl.TEXTURE_2D], ['uBL', bl, gl.TEXTURE_2D], ['uLut', this.lut, gl.TEXTURE_3D]];
    texs.forEach(([n, t, kind], i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(kind, t); gl.uniform1i(u(n), i); });
    gl.uniform1f(u('uLutSize'), this.lutSize);
    gl.uniformMatrix3fv(u('uGeo'), false, geo.m);
    gl.uniform2f(u('uOut'), outW, outH);
    gl.uniform1f(u('uScale'), (geo.outW / outW) * this.scale);
    gl.uniform1f(u('uSplit'), opts.split ?? 0);
    gl.uniform1f(u('uFlipY'), toCanvas ? 1 : 0);
    gl.uniform1f(u('uNoise'), s.noise / 100);
    gl.uniform1f(u('uTexture'), s.texture / 100);
    gl.uniform1f(u('uClarity'), s.clarity / 100);
    gl.uniform1f(u('uDehaze'), s.dehaze / 100);
    gl.uniform1f(u('uSharpen'), (s.sharpen / 100) * 1.5);
    gl.uniform1f(u('uVig'), s.vignette / 100);
    gl.uniform1f(u('uVigMid'), s.vignetteMid / 100);
    gl.uniform1f(u('uVigFeather'), s.vignetteFeather / 100);
    gl.uniform1f(u('uGrain'), s.grain / 100);
    gl.uniform1f(u('uGrainSize'), s.grainSize / 100);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return geo;
  }

  /** Render into a new framebuffer and read pixels back (top row first). */
  renderToPixels(s: Settings, outW: number, outH: number, ignoreCrop = false): Uint8ClampedArray {
    const gl = this.gl;
    const t = this.makeTarget(outW, outH);
    this.render(s, { outW, outH, fb: t.fb, ignoreCrop });
    const px = new Uint8ClampedArray(outW * outH * 4);
    gl.readPixels(0, 0, outW, outH, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.free(t);
    return px; // framebuffer rows are already top-first because uv.y = 0 maps to the first row
  }

  /** Blocks until the GPU is done (reads one pixel); used only for timing. */
  finish() { const gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); }
}
