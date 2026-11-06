/* Lance le banc de mesure (tests/perf-harness.js) dans un Chromium piloté par puppeteer-core.
   Installation (hors dépôt, gratuit) : npm i puppeteer-core ; puis  NODE_PATH=<dossier>/node_modules node tests/perf-run.js <étiquette> [largeur] [hauteur] [paramètres URL]
   Variables : EDGE (chemin du navigateur), BASE (URL du site, défaut http://localhost:8080), SOFT=1 (GPU logiciel : proxy pessimiste lié au GPU),
   CPU=4 (processeur ralenti ×4 : proxy lié au fil principal), SCEN=follow,idle,pan,zoom,rotate, NONAV=1 (sans navigation), SP_OUT (dossier des résultats). */
const puppeteer = require('puppeteer-core'); const fs = require('fs'); const path = require('path');
const label = process.argv[2] || 'run';
const w = +process.argv[3] || 1180, h = +process.argv[4] || 740;
const extra = process.argv[5] || '';
(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'new',
    args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', process.env.SOFT ? '--use-angle=swiftshader' : '--use-angle=d3d11', ...(process.env.SOFT ? ['--enable-unsafe-swiftshader'] : []), '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    defaultViewport: { width: w, height: h, deviceScaleFactor: 1 } });
  const page = await browser.newPage();
  if (process.env.CPU) { const c = await page.createCDPSession(); await c.send('Emulation.setCPUThrottlingRate', { rate: +process.env.CPU }); }
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('prefs', JSON.stringify({})); } catch (e) {} });
  await page.goto((process.env.BASE || 'http://localhost:8080')+'/?sim=70&from=1.44,43.60&perf=1' + extra, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 5000));
  await page.evaluate(fs.readFileSync(path.join(__dirname, 'perf-harness.js'), 'utf8'));
  if (process.env.NONAV) await page.evaluate(() => { window.__nonav = true; });
  await page.evaluate(() => { __perf.install(); if (!window.__nonav) startNav({ name: 'Albi', coord: [2.15, 43.93] }); });
  await new Promise(r => setTimeout(r, 14000));
  const res = { label, vis: await page.evaluate(() => document.visibilityState), env: await page.evaluate(() => __perf.env()), scenarios: [] };
  if (process.env.PRE) await page.evaluate(process.env.PRE);
  await page.evaluate(() => new Promise(res => { const t0 = Date.now(); const w = () => (map.areTilesLoaded() && !map.isMoving() || Date.now() - t0 > 20000) ? res() : setTimeout(w, 300); w(); }));
  await new Promise(r => setTimeout(r, 1500));
  for (const s of (process.env.SCEN || 'follow,idle,pan,zoom,rotate').split(',')) {
    res.scenarios.push(await page.evaluate(n => __perf.SC[n](), s));
    await new Promise(r => setTimeout(r, 800));
  }
  res.mem = await page.evaluate(() => ({ heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), tiles: Object.values(map.style.sourceCaches).reduce((a, c) => a + Object.keys(c._tiles).length, 0) }));
  fs.writeFileSync((process.env.SP_OUT || '.') + '/perf-' + label + '.json', JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res));
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
