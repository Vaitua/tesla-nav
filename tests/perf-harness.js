/* NAVIA — banc de mesure de fluidité (à exécuter dans la page : chargé par fetch + eval, voir tests/PERF.md).
   Mesure ce qu'on peut mesurer honnêtement depuis la page :
     - cadence réelle (intervalle entre requestAnimationFrame) : FPS moyen, p50/p95/p99, images > 33 ms et > 50 ms
     - temps JS d'un rendu MapLibre (map._render) et de la boucle d'animation de l'app (frame)
     - tâches longues (> 50 ms) sur le fil principal, mémoire JS, tuiles chargées
   Le temps GPU n'est pas mesurable directement : il se voit dans la cadence (FPS) quand le GPU est le goulot.
   Les chiffres dépendent du matériel : toujours lire `env.renderer` (SwiftShader = rendu logiciel, très pessimiste). */
(function () {
  if (window.__perf) return;
  const q = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const r1 = x => Math.round(x * 10) / 10;
  const P = { rd: [], fr: [], lt: [], on: false };

  function install() {
    if (P.installed) return; P.installed = true;
    const origRender = map._render;
    map._render = function (a) { const s = performance.now(); const r = origRender.call(this, a); if (P.on) P.rd.push(performance.now() - s); return r; };
    const origFrame = window.frame;
    window.frame = function (ts) { const s = performance.now(); const r = origFrame(ts); if (P.on) P.fr.push(performance.now() - s); return r; };
    try { new PerformanceObserver(l => { if (P.on) l.getEntries().forEach(e => P.lt.push(e.duration)); }).observe({ entryTypes: ['longtask'] }); } catch (e) { P.noLongTask = true; }
  }
  function env() {
    const gl = map.painter.context.gl, dbg = gl.getExtension('WEBGL_debug_renderer_info');
    let layers = 0, sources = 0, tiles = 0;
    try { const st = map.getStyle(); layers = st.layers.length; sources = Object.keys(st.sources).length; } catch (e) { /* ignoré */ }
    try { for (const c of Object.values(map.style.sourceCaches)) tiles += Object.keys(c._tiles).length; } catch (e) { /* ignoré */ }
    return { renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'inconnu', viewport: `${innerWidth}x${innerHeight}`, dpr: devicePixelRatio,
      mapPixelRatio: map.getPixelRatio ? map.getPixelRatio() : null, canvas: `${map.getCanvas().width}x${map.getCanvas().height}`, layers, sources, tiles,
      zoom: +map.getZoom().toFixed(2), pitch: +map.getPitch().toFixed(1), body: document.body.className, lite: !!prefs.lite, glass: !document.body.classList.contains('noglass') };
  }
  /* Exécute un scénario pendant `ms` ; `drive(t, n)` (facultatif) est appelé à chaque image. */
  function run(name, ms, drive) {
    return new Promise(resolve => {
      const ts = [], heap0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
      P.rd = []; P.fr = []; P.lt = []; P.on = true;
      let t0 = null, n = 0;
      const tick = t => {
        if (t0 === null) t0 = t;
        ts.push(t); n++;
        if (drive) drive((t - t0) / ms, n);
        if (t - t0 < ms) return requestAnimationFrame(tick);
        P.on = false;
        const dts = []; for (let i = 1; i < ts.length; i++) dts.push(ts[i] - ts[i - 1]);
        const heap1 = performance.memory ? performance.memory.usedJSHeapSize : 0;
        resolve({ scenario: name, seconds: r1((ts[ts.length - 1] - ts[0]) / 1000), frames: ts.length, fps: r1(1000 / mean(dts)),
          frameMs: { p50: r1(q(dts, .5)), p95: r1(q(dts, .95)), p99: r1(q(dts, .99)), max: r1(Math.max(...dts)) },
          jank33: dts.filter(d => d > 33.4).length, jank50: dts.filter(d => d > 50).length,
          mapRenderJsMs: { n: P.rd.length, mean: r1(mean(P.rd)), p95: r1(q(P.rd, .95)), max: r1(Math.max(0, ...P.rd)) },
          appFrameJsMs: { mean: r1(mean(P.fr)), p95: r1(q(P.fr, .95)) },
          longTasks: P.noLongTask ? 'non supporté' : { n: P.lt.length, totalMs: Math.round(P.lt.reduce((a, b) => a + b, 0)) },
          heapMB: { start: r1(heap0 / 1048576), end: r1(heap1 / 1048576) } });
      };
      requestAnimationFrame(tick);
    });
  }
  /* Scénarios de manipulation : la caméra de l'app est suspendue (state.hold) pour que seul le banc la pilote. */
  const hold = () => { state.hold = Date.now() + 1e9; };
  const release = () => { state.hold = 0; };
  const SC = {
    idle: () => run('immobile (suivi actif)', 4000),
    follow: () => { release(); return run('suivi GPS en navigation', 12000); },
    pan: () => { hold(); const c = map.getCenter(); return run('glisser la carte', 6000, f => map.jumpTo({ center: [c.lng + Math.sin(f * 6.28) * 0.01, c.lat + Math.cos(f * 6.28) * 0.006] })).then(r => { release(); return r; }); },
    zoom: () => { hold(); const z0 = map.getZoom(); return run('zoom avant/arrière (±2 niveaux)', 6000, f => map.jumpTo({ zoom: z0 + Math.sin(f * 12.56) * 2 })).then(r => { release(); return r; }); },
    rotate: () => { hold(); const b0 = map.getBearing(); return run('rotation + inclinaison', 6000, f => map.jumpTo({ bearing: b0 + f * 360, pitch: 55 + Math.sin(f * 12.56) * 20 })).then(r => { release(); return r; }); },
  };
  window.__perf = { install, env, run, SC, hold, release };
})();
