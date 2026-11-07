'use strict';
/* NAVIA — couche d'interface « cockpit » : dock permanent, feuilles exclusives, modes navigation / exploration.
   Les règles visuelles sont toutes dans style.css (design system). Ici : comportement uniquement.
   Aucune dépendance au survol ; tout est tactile. */
(function () {
  Object.assign(G, {
    moon: '<path d="M20 14.5A8.2 8.2 0 1 1 9.5 4a6.6 6.6 0 0 0 10.5 10.5z"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="17" r="2.2"/>',
    overview: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/><circle cx="12" cy="12" r="2.6"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  });
  fillIcons();
  $('stop').innerHTML = ic('x') + '<span>Arrêter</span>';

  /* ---- feuilles (recherche, réglages, trajet) : une seule à la fois ---- */
  function closeOthers(keep) {
    if (keep !== 'search' && $('search').classList.contains('open')) setSearch(false);
    if (keep !== 'panel') $('panel').hidden = true;
    if (keep !== 'navia' && window.naviaSetOpen) naviaSetOpen(false);
    if (keep !== 'cmp') { const c = $('tCompare'); if (c) c.hidden = true; }
    if (keep) { $('station').hidden = true; }
  }
  let favMode = false;
  window.closeSheets = closeOthers;
  const OWNER = { searchBtn: 'search', favBtn: 'search', layersBtn: 'panel', naviaBtn: 'navia' };
  $('dock').addEventListener('click', e => {                       // phase de capture : avant les gestionnaires d'origine
    const b = e.target.closest('button');
    if (b && OWNER[b.id]) { closeOthers(OWNER[b.id]); if (b.id === 'searchBtn') favMode = false; }
  }, true);
  $('favBtn').addEventListener('click', e => {                     // favoris : feuille de recherche ouverte sans clavier
    e.stopPropagation(); favMode = true;
    setSearch(!$('search').classList.contains('open'), true);
  });
  document.addEventListener('click', e => {
    const x = e.target.closest('[data-close]');
    if (!x) return;
    const k = x.dataset.close;
    if (k === 'search') setSearch(false); else if (k === 'panel') $('panel').hidden = true;
    sync();
  });

  /* ---- aperçu du trajet / recentrage ---- */
  $('ovBtn').addEventListener('click', () => {
    if (state.route) {
      const c = state.route.coords;
      const b = c.reduce((bb, p) => bb.extend(p), new maplibregl.LngLatBounds(c[0], c[0]));
      map.fitBounds(b, { padding: { top: 120, bottom: 130, left: 120, right: 300 }, pitch: 0, bearing: 0, duration: 900 });
      state.hold = Date.now() + 9000;                              // la caméra revient seule au suivi après 9 s
      status('Vue d’ensemble du trajet', 1500);
    } else if (state.pos) {
      state.hold = 0; map.easeTo({ center: state.pos, zoom: 15.5, duration: 700 });
      status('Recentré sur votre position', 1500);
    } else status('Position GPS inconnue', 2500);
  });

  /* ---- thème de carte ---- */
  const seg = $('segMap');
  function syncSeg() { const cur = prefs.mapTheme || 'night'; seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.map === cur)); }
  seg.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { setMapTheme(b.dataset.map); syncSeg(); } });
  syncSeg();

  /* ---- états visuels : dock actif, mode navigation, destination ---- */
  const dockOn = { searchBtn: () => $('search').classList.contains('open') && !favMode, layersBtn: () => !$('panel').hidden, naviaBtn: () => !$('navia').hidden };
  function sync() {
    for (const id in dockOn) $(id).classList.toggle('on', dockOn[id]());
    $('favBtn').classList.toggle('on', $('search').classList.contains('open') && favMode);
    const nav = !$('trip').hidden;
    document.body.classList.toggle('nav', nav);
    const d = state.dest && state.dest.name;
    $('manDest').textContent = nav && d ? 'vers ' + d : '';
    document.body.classList.toggle('sheet-open', $('search').classList.contains('open') || !$('panel').hidden || !$('navia').hidden || ($('tCompare') && !$('tCompare').hidden));
  }
  setInterval(sync, 300);
  sync();
  window.addEventListener('resize', () => setTimeout(sync, 50));
})();
