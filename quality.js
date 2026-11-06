'use strict';
/* NAVIA — qualité adaptative et robustesse de la session (écran de voiture = ressources limitées).
   Aucune fonctionnalité n'est retirée : on ne règle que la définition de rendu, la cadence des animations
   et le flou des panneaux, par paliers, d'après la cadence RÉELLEMENT mesurée.
     palier 0 : plein (définition native, plafonnée à 1,5)    palier 1 : définition ×0,82
     palier 2 : ×0,68, météo à ~20 i/s, flou réduit           palier 3 : ×0,55, météo à ~15 i/s, panneaux sans flou
   Descente rapide (2 fenêtres de 2,5 s sous 38 i/s), remontée prudente (3 fenêtres au-dessus de 57 i/s).
   Le dernier palier stable est mémorisé : on repart de là au prochain lancement. */
(function () {
  const SCALE = [1, 0.82, 0.68, 0.55], WX_MS = [30, 33, 50, 66];
  const BASE = Math.min(window.devicePixelRatio || 1, 1.5);
  const Q = { level: 0, fps: 0, lastRender: 0, dts: [], low: 0, high: 0, since: 0 };
  window.NAVIA_Q = Q;
  try { Q.level = Math.min(3, Math.max(0, Number(localStorage.getItem('q.level')) || 0)); } catch (e) { /* ignoré */ }

  function apply(level) {
    Q.level = level; Q.since = Date.now();
    try { localStorage.setItem('q.level', String(level)); } catch (e) { /* ignoré */ }
    for (let i = 1; i <= 3; i++) document.body.classList.toggle('q' + i, level >= i);
    try { map.setPixelRatio(BASE * SCALE[level]); } catch (e) { /* ancienne version : on ne touche pas à la définition */ }
    WX_DT = WX_MS[level];
    show();
  }
  function show() {
    const el = document.getElementById('qInfo');
    if (el) el.textContent = `Qualité adaptative : palier ${Q.level}/3` + (Q.fps ? ` · ${Q.fps} i/s mesurées en roulant` : ' · mesure en cours');
  }

  map.on('render', () => { Q.lastRender = performance.now(); });
  let prev = 0;
  function tick(t) {
    requestAnimationFrame(tick);
    if (document.hidden) { prev = 0; return; }
    const active = t - Q.lastRender < 40;                       // la carte s'est redessinée à cette image : la cadence est significative
    if (active && prev) { const d = t - prev; if (d < 250) Q.dts.push(d); }
    prev = active ? t : 0;
    if (!Q.t0) Q.t0 = t;
    if (t - Q.t0 < 2500) return;
    Q.t0 = t;
    if (Q.dts.length < 40) { Q.dts = []; return; }              // carte au repos : rien à mesurer
    const fps = 1000 / (Q.dts.reduce((a, b) => a + b, 0) / Q.dts.length);
    Q.dts = []; Q.fps = Math.round(fps);
    if (fps < 38) { Q.high = 0; if (++Q.low >= 2 && Q.level < 3) { Q.low = 0; apply(Q.level + 1); } }
    else if (fps > 57) { Q.low = 0; if (++Q.high >= 3 && Q.level > 0 && Date.now() - Q.since > 15000) { Q.high = 0; apply(Q.level - 1); } }
    else { Q.low = 0; Q.high = 0; }
    show();
  }
  requestAnimationFrame(tick);
  apply(Q.level);

  /* ---- session longue : veille, perte de réseau, contexte WebGL ---- */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { try { map.resize(); map.triggerRepaint(); } catch (e) { /* ignoré */ } }   // retour d'un autre onglet / sortie de veille
  });
  function reloadTiles() {
    try { for (const id of Object.keys(map.style.sourceCaches)) { const s = map.getSource(id); if (s && s.type === 'vector' && s.reload) s.reload(); } map.triggerRepaint(); } catch (e) { /* ignoré */ }
  }
  window.addEventListener('online', () => { status('Connexion rétablie', 2000); reloadTiles(); try { fetchWeather(); } catch (e) { /* ignoré */ } });
  window.addEventListener('offline', () => status('Hors connexion : la carte déjà chargée reste utilisable', 4000));
  let errBurst = 0;
  map.on('error', e => {                                        // tuile manquante : on réessaie en différé, sans bruit
    if (++errBurst === 1) setTimeout(() => { errBurst = 0; if (navigator.onLine !== false) reloadTiles(); }, 8000);
  });
  const cv = map.getCanvas();
  cv.addEventListener('webglcontextlost', () => { logError('contexte WebGL perdu'); status('Affichage interrompu, restauration…', 4000); });
  cv.addEventListener('webglcontextrestored', () => { logError('contexte WebGL restauré'); status('Affichage restauré', 2000); });
})();
