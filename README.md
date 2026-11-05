# Snap Lens

Snap Lens is a photo editor that runs entirely in the browser. Its main feature is copying the color, tone and mood of reference photos onto your photo. The copied look is written into ordinary Lightroom-style sliders, so you can see what was copied and fine-tune it. It uses no AI or machine learning models and has no server: images are decoded, edited and exported on your device and never uploaded.

## Features

### Copy style from reference photos (the main feature)

- Add one or more reference photos (file picker, drag and drop, or paste). Several references are blended into one look.
- The app measures the reference and your photo and fits editable settings:
  - Tone: exposure, contrast, whites, blacks, plus a residual tone curve from lightness quantiles.
  - Color: white balance cast (temperature, tint) measured on near-neutral pixels, vibrance and saturation level, and hue and saturation shifts for each of the 8 color mixer bands.
  - Split toning: the tint of near-neutral shadows and highlights, written to the color grading wheels.
  - Effects: a vignette estimate (corner versus center lightness) and a grain estimate (fine-scale noise).
- A readable report lists what was copied, for example "Temperature +12, Highlights tint orange (hue 52, sat 18)".
- An overall strength slider and per-aspect toggles (Tone, Color, Split toning, Vignette and grain).
- Copy to all photos in the session; each photo gets its own fit.
- Save a copied look as an adaptive preset. It stores a compact reference sample and refits the look to every photo it is applied to.
- Statistical match mode keeps the direct transfer methods: Oklab or CIELAB mean and standard deviation (Reinhard), per-channel histogram matching, and a lightness tone curve plus mean and standard deviation.
- The dominant colors of the reference (k-means in Oklab) are shown as swatches; click one to copy its hex value.

### Editing (the fine-tune layer)

- Basic: white balance with temperature, tint and a neutral-point eyedropper; exposure, contrast, highlights, shadows, whites, blacks; texture, clarity, dehaze; vibrance and saturation.
- Tone curve: point curves for RGB and for red, green and blue separately. Drag points, click to add, double-click to remove.
- Color mixer: hue, saturation and luminance for red, orange, yellow, green, aqua, blue, purple and magenta.
- Color grading: shadow, midtone and highlight wheels (hue, saturation, luminance) with blending and balance.
- Detail: sharpening (amount, radius) and noise reduction. Effects: vignette (amount, midpoint, feather) and grain (amount, size).
- Geometry: crop with aspect presets (original, free, 1:1, 4:5, 3:2, 2:3, 16:9, 9:16), rotate, straighten (with automatic zoom to avoid empty corners), and flip.
- Live RGB histogram, before and after (split line or full toggle), zoom and pan (wheel, pinch, double-click), double-click a slider to reset it, undo and redo per photo, reset all.
- Presets: built-in looks, user presets in browser storage, and JSON import and export. Copy and paste settings between photos (crop and rotation are not included).
- Several photos per session with a filmstrip.
- Export JPEG (adjustable quality) or PNG at full resolution or a smaller long edge. Export the color look as a `.cube` 3D LUT (17, 33 or 65 points).

## How it works

- Non-destructive: the original file is never changed. Each photo has a settings object, and every render runs the pipeline from the original. Undo history stores settings snapshots.
- Color pipeline (`src/core/develop.ts`): every per-pixel operation (statistical match, white balance, exposure, tone, vibrance, saturation, color mixer, color grading, curves) is a function of the input color. The CPU implementation is baked into a 3D LUT (33 points while dragging, 49 points when idle, 65 points for export). The same code is used for the `.cube` export, for copy-style fitting and for the tests, so the preview, export and LUT always agree.
  - Tone works on display-encoded luminance and scales RGB to keep hue. Saturation, vibrance, the color mixer and color grading work in Oklab lightness, chroma and hue.
- WebGL2 renderer (`src/gl/renderer.ts`): fragment shaders apply geometry (one affine matrix), noise reduction, texture, clarity, dehaze and sharpening (unsharp masks over cached Gaussian blurs), then the 3D LUT, then vignette and grain. Blurs are recomputed only when the photo or a radius changes, so slider drags only redraw one pass.
- Export renders the same shaders at full resolution in a separate WebGL2 context. Images larger than the GPU texture limit are scaled to that limit.
- Copy style (`src/core/fit.ts`): measures Oklab lightness quantiles, chroma quantiles, neutral cast, the tint of neutral shadows and highlights, and per-band hue and chroma of both images. Each slider is then solved with a 1-D bisection through the CPU pipeline on about 4000 sample pixels. Pixel masks are fixed from the unedited photo, so measurements stay monotone. Ranges are limited and the residual curve is damped, because two photos rarely show the same scene. The fitting runs in a Web Worker and takes about half a second.

## Getting started

Requires Node.js 20.19 or newer (Node 24 recommended, see `.nvmrc`).

```sh
npm ci
npm run dev       # development server
npm test          # core math checks
npm run build     # production build in dist/
npm run preview   # serve dist/
```

Screenshots, copy-quality comparisons and performance numbers (needs Playwright with Chromium):

```sh
npm run build && npx vite preview --port 4173 &
PW_PATH=/path/to/node_modules/playwright node scripts/screenshots.mjs
```

Add `?perf` to the app URL to make the status line show GPU time measured with a synchronizing read.

## Tests

`npm test` compiles `src/core` and runs `scripts/test-math.ts`. It checks:

- Color conversion accuracy.
- Neutrality: default settings, exposure and contrast at 0, tone function at 0, identity curves, and the color mixer at 0 are all exact identities.
- Basic behavior of single sliders.
- Every built-in preset gives valid colors.
- Identity LUT application, `.cube` write and parse round trip, and the develop LUT of default settings.
- Geometry identity, quarter turn and flip.
- The statistical transfer methods: transferring an image onto itself changes almost nothing.
- Copy style:
  - Copying a photo onto itself is near identity.
  - A known look applied to the same content is mostly recovered.
  - For different content, lightness and chroma statistics move toward the reference.

Test photos are listed in `test-images/SOURCES.md`.

## Deploy to GitHub Pages

`.github/workflows/pages.yml` runs on pushes to `main`. It installs dependencies, runs the tests, builds with `VITE_BASE=/<repository name>/` and deploys `dist/` with the official Pages actions, pinned by commit SHA. In the repository settings, set the Pages source to GitHub Actions. Dependabot keeps npm packages and actions up to date.

## Project structure

```
index.html               app shell
src/main.ts              UI, state, history, copy style, presets, export
src/ui/widgets.ts        sliders, curve editor, color wheels, histogram
src/gl/renderer.ts       WebGL2 pipeline
src/worker.ts            Web Worker: statistics and copy-style fitting
src/storage.ts           presets in localStorage, JSON import
src/core/settings.ts     settings model, defaults, built-in presets
src/core/develop.ts      CPU color pipeline and LUT baking
src/core/fit.ts          copy-style measurement and fitting
src/core/geometry.ts     crop, rotation and flip matrix
src/core/color.ts        sRGB, Oklab and CIELAB conversions
src/core/stats.ts        statistics, quantiles, palette
src/core/transfer.ts     statistical transfer, LUT application, .cube I/O
scripts/test-math.ts     tests
scripts/screenshots.mjs  screenshots, copy-quality triptychs, performance
```

## Known limitations

- Highlights, shadows, whites and blacks are global tone adjustments. They are not local tone mapping as in Lightroom.
- Input is 8-bit display-referred (JPEG, PNG, WebP, AVIF). RAW files are not supported. EXIF metadata and color profiles are not kept on export; output is sRGB.
- Copy style matches statistics, not semantics. With very different scenes (for example a night silhouette onto a sunny landscape) some fitted values reach their limits; lower the strength or turn off an aspect.
- Export of very large images needs a GPU texture limit at least as large as the image and enough memory. Mobile Safari may need the long-edge option.
- The `.cube` LUT contains color and tone only. Local effects (texture, clarity, dehaze, sharpening, noise reduction, vignette, grain) and geometry are not part of it.

## License

MIT, see `LICENSE`. Test photos keep their own licenses, see `test-images/SOURCES.md`.
