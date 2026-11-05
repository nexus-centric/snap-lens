// Screenshots, copy-style quality check and performance measurement with Playwright.
// Usage: npm run build && npx vite preview --port 4173 &
//        PW_PATH=/path/to/node_modules/playwright node scripts/screenshots.mjs
import { createRequire } from 'node:module';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_PATH || 'playwright');
const URL = process.env.APP_URL || 'http://localhost:4173/';
const IMG = 'test-images/';
mkdirSync('screenshots', { recursive: true }); mkdirSync('tmp', { recursive: true });

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = {};

async function newPage(viewport, scale = 1) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: scale, acceptDownloads: true });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && page.errors.push(m.text()));
  await page.goto(URL + '?perf');
  return page;
}
const open = (page, file) => page.setInputFiles('#openInput', IMG + file);
const addRef = (page, file) => page.setInputFiles('#refDrop input', IMG + file);
const waitCopied = (page) => page.waitForFunction(() => /Copied at/.test(document.getElementById('copyReport').textContent), null, { timeout: 120000 });
const settle = (page, ms = 700) => page.waitForTimeout(ms);
const openSec = (page, id) => page.evaluate((id) => { const s = document.getElementById('sec-' + id); if (!s.classList.contains('open')) s.querySelector('.sec-head').click(); }, id);
const closeSec = (page, id) => page.evaluate((id) => { const s = document.getElementById('sec-' + id); if (s.classList.contains('open')) s.querySelector('.sec-head').click(); }, id);

// ---------- Desktop ----------
{
  const page = await newPage({ width: 1280, height: 800 });
  await settle(page, 300);
  await page.screenshot({ path: 'screenshots/desktop-1280-empty.png' });
  await open(page, 'swaledale.jpg');
  await page.waitForFunction(() => /preview/.test(document.getElementById('status').textContent));
  await settle(page);
  await page.screenshot({ path: 'screenshots/desktop-1280-original.png' });
  await addRef(page, 'ref-ahuriri-sunrise.jpg');
  await waitCopied(page); await settle(page);
  results.copyReport = await page.textContent('#copyReport');
  await page.screenshot({ path: 'screenshots/desktop-1280-copied.png' });
  await page.click('#splitBtn'); await settle(page);
  await page.screenshot({ path: 'screenshots/desktop-1280-split.png' });
  await page.click('#splitBtn');
  // Fine-tune layer: show basic, curve and grading panels with the copied values.
  await closeSec(page, 'copy'); await openSec(page, 'curve'); await settle(page, 300);
  await page.screenshot({ path: 'screenshots/desktop-1280-basic-curve.png' });
  await closeSec(page, 'basic'); await closeSec(page, 'curve'); await openSec(page, 'grading'); await openSec(page, 'mixer'); await settle(page, 300);
  await page.screenshot({ path: 'screenshots/desktop-1280-grading-mixer.png' });
  // Crop mode with an aspect preset.
  await closeSec(page, 'grading'); await closeSec(page, 'mixer'); await openSec(page, 'geometry');
  await page.selectOption('#sec-geometry select', '4:5'); await settle(page);
  await page.screenshot({ path: 'screenshots/desktop-1280-crop.png' });
  await page.evaluate(() => window.__sl.setCropMode(false)); await page.click('text=Reset geometry'); await settle(page);
  // Export a 2048 px version and a LUT.
  await closeSec(page, 'geometry'); await openSec(page, 'export');
  await page.selectOption('#exportSize', '2048');
  let [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#exportGo')]);
  await dl.saveAs('tmp/after-swaledale.jpg');
  [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Export .cube')]);
  await dl.saveAs('tmp/look.cube');
  results.desktopErrors = page.errors;
  await page.close();
}

// ---------- Copy quality: second pair (dawn look onto the same daytime photo) and a triptych ----------
{
  const page = await newPage({ width: 1280, height: 800 });
  await open(page, 'swaledale.jpg');
  await page.waitForFunction(() => /preview/.test(document.getElementById('status').textContent));
  await addRef(page, 'ref-titicaca-dawn.jpg');
  await waitCopied(page); await settle(page);
  results.copyReport2 = await page.textContent('#copyReport');
  await openSec(page, 'export'); await page.selectOption('#exportSize', '2048');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#exportGo')]);
  await dl.saveAs('tmp/after-titicaca.jpg');
  await page.close();
  // Compose reference | before | after triptychs.
  const comp = await browser.newPage({ viewport: { width: 1800, height: 520 } });
  for (const [ref, after, out] of [['ref-ahuriri-sunrise.jpg', 'tmp/after-swaledale.jpg', 'copy-sunrise'], ['ref-titicaca-dawn.jpg', 'tmp/after-titicaca.jpg', 'copy-dawn']]) {
    const { readFileSync } = await import('node:fs');
    const b64 = (p) => 'data:image/jpeg;base64,' + readFileSync(p).toString('base64');
    await comp.setContent(`<body style="margin:0;background:#161719;color:#ddd;font:14px system-ui;display:flex;gap:12px;padding:12px">
      ${[['Reference', b64(IMG + ref)], ['Before', b64(IMG + 'swaledale.jpg')], ['After (copied style)', b64(after)]].map(([t, s]) => `<figure style="margin:0;flex:1"><img src="${s}" style="width:100%;height:440px;object-fit:contain;background:#000"><figcaption style="padding-top:6px">${t}</figcaption></figure>`).join('')}</body>`);
    await comp.waitForTimeout(500);
    await comp.screenshot({ path: `screenshots/${out}-triptych.png` });
  }
  await comp.close();
}

// ---------- Performance on a large photo ----------
if (existsSync(IMG + 'large-austria-36mp.jpg')) {
  const page = await newPage({ width: 1280, height: 800 });
  const t0 = Date.now();
  await open(page, 'large-austria-36mp.jpg');
  await page.waitForFunction(() => /preview/.test(document.getElementById('status').textContent), null, { timeout: 120000 });
  results.largeOpenMs = Date.now() - t0;
  results.perf = await page.evaluate(async () => {
    const sl = window.__sl, out = { color: [], spatial: [], frame: [] };
    const S = sl.S();
    for (let i = 0; i < 30; i++) {          // exposure drag: LUT rebake + draw
      S.exposure = (i - 15) / 10;
      const t = performance.now(); sl.renderNow(33); out.frame.push(performance.now() - t);
      out.color.push(sl.perf.lutMs);
    }
    S.clarity = 40; sl.renderNow(33);       // first use builds the blur once
    for (let i = 0; i < 30; i++) {          // vignette drag: draw only
      S.vignette = -i * 2;
      const t = performance.now(); sl.renderNow(33); out.spatial.push(performance.now() - t);
    }
    const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
    return { colorFrameMedianMs: med(out.frame), lutBakeMedianMs: med(out.color), spatialFrameMedianMs: med(out.spatial), status: document.getElementById('status').textContent };
  });
  await openSec(page, 'export');
  const t1 = Date.now();
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.click('#exportGo')]);
  await dl.saveAs('tmp/large-export.jpg');
  results.largeExport = await page.evaluate(() => window.__lastExport);
  results.largeExportWallMs = Date.now() - t1;
  results.perfErrors = page.errors;
  await page.close();
}

// ---------- Mobile ----------
{
  const page = await newPage({ width: 390, height: 844 }, 2);
  await page.screenshot({ path: 'screenshots/mobile-390-empty.png' });
  await open(page, 'swaledale.jpg');
  await page.waitForFunction(() => /preview/.test(document.getElementById('status').textContent));
  await addRef(page, 'ref-ahuriri-sunrise.jpg');
  await waitCopied(page); await settle(page);
  await page.screenshot({ path: 'screenshots/mobile-390-copy.png' });
  for (const tab of ['basic', 'grading', 'curve', 'geometry']) {
    await page.click(`#tabbar button[data-id="${tab}"]`); await settle(page, 500);
    await page.screenshot({ path: `screenshots/mobile-390-${tab}.png` });
  }
  results.mobileErrors = page.errors;
  await page.close();
}
await browser.close();
writeFileSync('tmp/results.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
