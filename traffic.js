'use strict';
/* NAVIA — trafic, événements routiers et zones de vigilance (données réelles, gratuites, sans clé dans le navigateur).

   Architecture multi-sources (voir docs/TRAFIC.md) :
     - Bison Futé / DIR (DATEX II, Licence Ouverte 2.0) : événements + vitesses mesurées. Les flux sources sont en XML, sans CORS et lourds :
       un pipeline GitHub Actions les convertit toutes les ~10 min en JSON léger (branche `data`, servie en HTTPS avec CORS).
     - Bordeaux Métropole (open data, CORS ouvert) : trafic détaillé, interrogé directement, seulement quand la carte est sur la métropole.
     - TomTom : facultatif, uniquement via un proxy Cloudflare Worker (la clé ne va jamais dans le navigateur) — voir worker/traffic-proxy.js.
   Règles : jamais de requête au déplacement de la carte ; rafraîchissement par source ; cache HTTP du navigateur respecté ; reprise différée
   en cas d'erreur ; l'âge réel des données (date de publication de la source) est toujours affiché ; trafic jugé trop ancien = masqué. */
(function () {
  const CFG = Object.assign({ base: 'https://raw.githubusercontent.com/Vaitua/tesla-nav/data/' }, window.NAVIA_CONFIG || {}, P.get('tbase') ? { base: P.get('tbase') } : {});   // ?tbase= : essais locaux
  const MIN = 60000;
  const BDX_URL = 'https://datahub.bordeaux-metropole.fr/api/explore/v2.1/catalog/datasets/ci_trafi_l/exports/geojson';
  const BDX_BBOX = [-0.80, 44.70, -0.40, 44.98];
  /* Registre des sources : priorité (1 = prioritaire), cadence, âge maximal avant masquage */
  const SOURCES = {
    flow: [
      { id: 'dir', name: 'Bison Futé / DIR', prio: 1, url: CFG.base + 'flow.json', every: 6 * MIN, maxAge: 30 * MIN },
      { id: 'bdx', name: 'Bordeaux Métropole', prio: 2, url: BDX_URL, every: 3 * MIN, maxAge: 15 * MIN, bbox: BDX_BBOX },
    ],
    events: [
      { id: 'dir', name: 'Bison Futé / DIR', prio: 1, url: CFG.base + 'events.json', every: 5 * MIN, maxAge: 3 * 60 * MIN },
    ],
  };
  const T = { st: {}, flowFc: null, ev: [], route: null, said: new Set(), cur: null };
  const on = k => prefs[k] !== false;
  const LV = ['Fluide', 'Ralenti', 'Dense', 'Saturé'];
  const LV_COL = ['#34d399', '#fb923c', '#ef4444', '#be123c'];

  /* ---------- icônes (SVG pour l'interface, canvas pour la carte) ---------- */
  Object.assign(G, {
    traffic: '<rect x="8" y="2.5" width="8" height="19" rx="3"/><circle cx="12" cy="7.5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="16.5" r="1.4"/>',
    warn: '<path d="M12 3.5 22 20.5H2z"/><path d="M12 10v4.5M12 17.6v.1"/>',
    ev_accident: '<path d="m12 2.5 2.2 5.3 5.6-1.7-2.2 5.5 5 2.9-5.4 1.6 1.4 5.6-5-3.1-5 3.1 1.4-5.6L1.6 15l5-2.9-2.2-5.5 5.6 1.7z"/>',
    ev_travaux: '<path d="M12 4 18.5 20H5.5z"/><path d="M8.8 12.5h6.4M7.2 16.5h9.6M3.5 20.5h17"/>',
    ev_fermeture: '<circle cx="12" cy="12" r="9"/><path d="M6.5 12h11"/>',
    ev_obstacle: '<path d="m12 3 9 9-9 9-9-9z"/><path d="M12 8.5v4M12 15.6v.1"/>',
    ev_danger: '<path d="M12 3.5 22 20.5H2z"/><path d="M12 10v4.5M12 17.6v.1"/>',
    ev_bouchon: '<path d="M3 8h8M3 12h13M3 16h18"/><path d="m17 6 4 4-4 4"/>',
    ev_voie: '<path d="M8 3v18M16 3v18M12 5v3M12 11v3M12 17v3"/>',
  });
  fillIcons();
  const CAT = {
    accident: { t: 'Accident', col: '#ef4444', major: true, voice: true },
    fermeture: { t: 'Route fermée', col: '#dc2626', major: true, voice: true },
    bouchon: { t: 'Ralentissement important', col: '#be123c', major: true, voice: true },
    danger: { t: 'Danger', col: '#fbbf24', major: true, voice: true },
    obstacle: { t: 'Obstacle sur la chaussée', col: '#fb923c', major: false, voice: true },
    travaux: { t: 'Travaux', col: '#f59e0b', major: false, voice: false },
    voie: { t: 'Voie neutralisée', col: '#94a3b8', major: false, voice: false },
  };
  const SUB = { animalsOnTheRoad: 'Animaux sur la chaussée', snowOnTheRoad: 'Neige sur la chaussée', rockfalls: 'Chute de pierres', subsidence: 'Affaissement de la chaussée',
    objectOnTheRoad: 'Objet sur la chaussée', obstructionOnTheRoad: 'Obstacle sur la chaussée', singleAlternateLineTraffic: 'Circulation alternée', narrowLanes: 'Voies rétrécies',
    contraflow: 'Circulation basculée', closedPermanentlyForTheWinter: 'Fermée pour l’hiver', roadClosed: 'Route fermée', laneClosures: 'Voie fermée', queuingTraffic: 'Circulation en file',
    incident: 'Incident' };
  const evTitle = e => (e.cat === 'danger' || e.cat === 'obstacle' || e.cat === 'voie' || e.cat === 'fermeture') && SUB[e.sub] ? SUB[e.sub] : CAT[e.cat].t;
  function evIcon(cat) {
    const s = 72, c = document.createElement('canvas'), x = c.getContext('2d'), col = CAT[cat].col;
    c.width = c.height = s;
    x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = 7; x.shadowOffsetY = 2;
    x.fillStyle = '#0a1020'; x.beginPath(); x.arc(36, 36, 30, 0, 6.283); x.fill();
    x.shadowColor = 'transparent';
    x.fillStyle = col; x.beginPath(); x.arc(36, 36, 26, 0, 6.283); x.fill();
    x.strokeStyle = cat === 'danger' ? '#1a1200' : '#fff'; x.fillStyle = x.strokeStyle; x.lineWidth = 4.4; x.lineCap = x.lineJoin = 'round';
    const P = d => new Path2D(d), sc = 1.45, tx = 36 - 12 * sc, ty = 36 - 12 * sc;
    x.save(); x.translate(tx, ty); x.scale(sc, sc); x.lineWidth = 3;
    const g = G['ev_' + cat].match(/d="([^"]+)"/g).map(m => m.slice(3, -1));
    for (const d of g) { const p = P(d); x.stroke(p); if (cat === 'accident') x.fill(p); }
    x.restore();
    return x.getImageData(0, 0, s, s);
  }

  /* ---------- sources : récupération, cache, erreurs ---------- */
  const age = ms => ms < 90000 ? 'à l’instant' : ms < 90 * MIN ? `il y a ${Math.round(ms / MIN)} min` : `il y a ${Math.round(ms / 3600000)} h`;
  const stOf = id => T.st[id] || (T.st[id] = { data: null, updated: 0, fetched: 0, ok: null, err: 0, next: 0, busy: false });
  async function getJson(url) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
    try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    finally { clearTimeout(timer); }
  }
  const inBbox = (b) => { const c = map.getCenter(); return c.lng >= b[0] && c.lng <= b[2] && c.lat >= b[1] && c.lat <= b[3]; };
  const wanted = (kind, s) => (kind === 'flow' ? on('tFlow') : on('tEv')) && (!s.bbox || inBbox(s.bbox));
  async function refresh(kind, s) {
    const st = stOf(kind + ':' + s.id);
    if (st.busy) return;
    st.busy = true;
    try {
      const j = await getJson(s.url);
      st.data = j; st.fetched = Date.now(); st.ok = true; st.err = 0; st.next = Date.now() + s.every;
      st.updated = s.id === 'bdx' ? Date.parse((j.features && j.features[0] && j.features[0].properties.mdate) || '') || Date.now() : Date.parse(j.updated) || Date.now();
      st.ver = (st.ver || 0) + 1;
      rebuild(kind);
    } catch (e) {                                                       // erreur : on garde les anciennes données et on réessaie plus tard (2, 4, 8… min, max 30)
      st.ok = false; st.err++; st.next = Date.now() + Math.min(30 * MIN, 2 * MIN * 2 ** (st.err - 1));
      if (st.err === 1) logError('trafic ' + s.id + ' : ' + e.message);
    } finally { st.busy = false; paintCard(); }
  }
  function tick() {
    if (document.hidden || navigator.onLine === false) return;
    for (const kind of ['flow', 'events']) for (const s of SOURCES[kind]) {
      const st = stOf(kind + ':' + s.id);
      if (wanted(kind, s) && Date.now() >= st.next) refresh(kind, s);
    }
  }

  /* ---------- normalisation, priorités, déduplication ---------- */
  const fresh = (kind, s) => { const st = stOf(kind + ':' + s.id); return st.data && Date.now() - st.updated <= s.maxAge ? st : null; };
  const SEG_LEVEL = { FLUIDE: 0, DENSE: 2, EMBOUTEILLE: 3 };
  function flowFeatures() {
    const feats = [];
    for (const s of SOURCES.flow) {
      const st = fresh('flow', s);
      if (!st) continue;                                                // donnée trop ancienne : on ne la présente pas comme du temps réel
      if (s.id === 'dir') for (const g of st.data.segments) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: g.c }, properties: { l: g.l, v: g.v, q: g.q, a: g.a, s: 'dir' } });
      if (s.id === 'bdx') for (const f of st.data.features) {
        const p = f.properties, l = SEG_LEVEL[p.etat];
        if (l == null || p.origine === 'DIRA') continue;                // INCONNU ignoré ; DIRA = déjà couvert par la source prioritaire (déduplication)
        feats.push({ type: 'Feature', geometry: f.geometry, properties: { l, v: null, q: null, a: p.ident || '', s: 'bdx' } });
      }
    }
    return feats;
  }
  const hav = (a, b) => dist(a, b);
  /* Déduplication d'événements : même catégorie à moins de 150 m = même événement ; la source de plus forte priorité l'emporte */
  function dedupe(list) {
    const out = [];
    for (const e of list.sort((x, y) => x.prio - y.prio)) if (!out.some(o => o.cat === e.cat && hav(o.a, e.a) < 150)) out.push(e);
    return out;
  }
  function eventList() {
    const all = [];
    for (const s of SOURCES.events) {
      const st = fresh('events', s);
      if (st) for (const e of st.data.events) all.push(Object.assign({ prio: s.prio, srcName: s.name, pub: st.updated }, e));
    }
    return dedupe(all);
  }

  /* ---------- couches MapLibre (indépendantes, mises à jour par setData uniquement quand les données changent) ---------- */
  const EMPTY = { type: 'FeatureCollection', features: [] };
  function initLayers() {
    if (!map.isStyleLoaded && !map.getStyle()) return;
    if (map.getSource('traf-flow')) return;
    const before = map.getLayer('route-casing') ? 'route-casing' : undefined;
    for (const cat of Object.keys(CAT)) if (!map.hasImage('ev-' + cat)) map.addImage('ev-' + cat, evIcon(cat), { pixelRatio: 2 });
    map.addSource('traf-flow', { type: 'geojson', data: T.flowFc || EMPTY });
    map.addSource('traf-ev', { type: 'geojson', data: EMPTY });
    map.addSource('traf-ev-line', { type: 'geojson', data: EMPTY });
    const vis = k => ({ visibility: on(k) ? 'visible' : 'none' });
    const wd = ['interpolate', ['linear'], ['zoom'], 6, 1.2, 10, 2.6, 13, 5, 16, 9];
    map.addLayer({ id: 'traf-flow-casing', type: 'line', source: 'traf-flow', minzoom: 6, layout: Object.assign({ 'line-cap': 'round', 'line-join': 'round' }, vis('tFlow')),
      paint: { 'line-color': '#050a18', 'line-opacity': ['match', ['get', 'l'], 0, 0.35, 0.8], 'line-width': ['+', wd, 2.4] } }, before);
    map.addLayer({ id: 'traf-flow', type: 'line', source: 'traf-flow', minzoom: 6, layout: Object.assign({ 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'l'] }, vis('tFlow')),
      paint: { 'line-color': ['match', ['get', 'l'], 0, LV_COL[0], 1, LV_COL[1], 2, LV_COL[2], 3, LV_COL[3], '#64748b'], 'line-opacity': ['match', ['get', 'l'], 0, 0.6, 0.96], 'line-width': wd } }, before);
    map.addLayer({ id: 'traf-ev-line', type: 'line', source: 'traf-ev-line', minzoom: 8, layout: Object.assign({ 'line-cap': 'butt' }, vis('tEv')),
      paint: { 'line-color': ['get', 'col'], 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 2, 14, 5], 'line-dasharray': [1.2, 1.2], 'line-opacity': 0.9 } }, before);
    const sym = (id, filter, minzoom) => map.addLayer({ id, type: 'symbol', source: 'traf-ev', minzoom, filter,
      layout: Object.assign({ 'icon-image': ['concat', 'ev-', ['get', 'cat']], 'icon-allow-overlap': false, 'icon-padding': 5, 'symbol-sort-key': ['-', 0, ['get', 'sev']],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 7, 0.62, 11, 0.9, 15, 1.15] }, vis('tEv')) });
    sym('traf-ev-major', ['==', ['get', 'major'], 1], 7);
    sym('traf-ev-minor', ['==', ['get', 'major'], 0], 11);
    for (const id of ['traf-ev-major', 'traf-ev-minor']) {
      map.on('click', id, e => { if (e.features.length) openEvent(e.features[0].properties.id); });
      map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
    }
    lastVer = { flow: '', events: '' };                                 // sources toutes neuves : on pousse les données déjà reçues
    rebuild('flow'); rebuild('events');
  }
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  let lastVer = { flow: '', events: '' };
  function rebuild(kind) {
    if (kind === 'flow') {
      const vers = SOURCES.flow.map(s => stOf('flow:' + s.id).ver || 0).join('|') + '|' + SOURCES.flow.map(s => fresh('flow', s) ? 1 : 0).join('');
      if (vers === lastVer.flow) return;                                // rien de nouveau : on ne touche pas à la carte
      lastVer.flow = vers; T.flowFc = { type: 'FeatureCollection', features: flowFeatures() };
      const src = map.getSource('traf-flow'); if (src) src.setData(T.flowFc);
    } else {
      const vers = SOURCES.events.map(s => stOf('events:' + s.id).ver || 0).join('|') + '|' + SOURCES.events.map(s => fresh('events', s) ? 1 : 0).join('');
      if (vers === lastVer.events) return;
      lastVer.events = vers; T.ev = eventList();
      const pts = T.ev.map(e => ({ type: 'Feature', geometry: { type: 'Point', coordinates: e.b ? [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2] : e.a },
        properties: { id: e.id, cat: e.cat, sev: e.sev, major: CAT[e.cat].major ? 1 : 0 } }));
      const lines = T.ev.filter(e => e.b).map(e => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [e.a, e.b] }, properties: { col: CAT[e.cat].col } }));
      const s1 = map.getSource('traf-ev'), s2 = map.getSource('traf-ev-line');
      if (s1) s1.setData({ type: 'FeatureCollection', features: pts }); if (s2) s2.setData({ type: 'FeatureCollection', features: lines });
    }
    T.route = null; routeScan();                                        // les données ont changé : on recalcule l'impact sur le trajet
  }
  function applyVis() {
    for (const [ids, k] of [[['traf-flow', 'traf-flow-casing'], 'tFlow'], [['traf-ev-major', 'traf-ev-minor', 'traf-ev-line'], 'tEv']])
      for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on(k) ? 'visible' : 'none');
    if (map.getLayer('zones')) map.setLayoutProperty('zones', 'visibility', on('rd') ? 'visible' : 'none');
    const z = map.getLayer('zones-line'); if (z) map.setLayoutProperty('zones-line', 'visibility', on('rd') ? 'visible' : 'none');
  }
  map.on('style.load', initLayers);
  if (map.getStyle() && map.getStyle().layers.length && map.getLayer('route-casing')) initLayers();

  /* ---------- fiche d'événement ---------- */
  const card = document.createElement('div');
  card.id = 'evCard'; card.hidden = true; document.body.appendChild(card);
  const hhmm = iso => iso ? new Date(iso).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  function openEvent(id) {
    const e = T.ev.find(x => x.id === id);
    if (!e) return;
    T.cur = id;
    $('station').hidden = true; $('pick').hidden = true;
    const here = state.pos ? dist(state.pos, e.a) : null;
    const r = T.route && T.route.events.find(x => x.e.id === id);
    const impact = !state.route ? 'Aucun trajet en cours.' : r ? (r.d >= -50 ? `Sur votre itinéraire, dans ${fmtDist(Math.max(0, r.d))}${r.eta ? ` (≈ ${fmtDur(r.eta)})` : ''}.` : 'Sur votre itinéraire, déjà dépassé.') : 'Hors de votre itinéraire.';
    const st = stOf('events:dir');
    card.innerHTML = `<div class="evHead"><span class="evIc" style="--c:${CAT[e.cat].col}">${ic('ev_' + e.cat)}</span><div><b>${esc(evTitle(e))}</b>
        <small>${esc([e.road, e.town].filter(Boolean).join(' · ') || 'Réseau routier national')}</small></div><button class="ghost" data-evclose>${ic('x')}</button></div>
      ${e.text ? `<p>${esc(e.text)}</p>` : ''}${e.where ? `<p class="evWhere">${esc(e.where)}</p>` : ''}
      <div class="evGrid"><span>Distance<b>${here == null ? '—' : fmtDist(here)}</b></span><span>Signalé<b>${hhmm(e.from)}</b></span>${e.to ? `<span>Fin prévue<b>${hhmm(e.to)}</b></span>` : ''}
        <span>Mis à jour<b>${e.upd ? age(Date.now() - Date.parse(e.upd)) : '—'}</b></span></div>
      <p class="evImpact ${r ? 'on' : ''}">${impact}</p>
      <small class="evSrc">Source : ${esc(e.srcName)} — ${esc(e.src)} · données publiées ${age(Date.now() - e.pub)} · Licence Ouverte 2.0</small>`;
    card.hidden = false;
    map.easeTo({ center: e.a, duration: 500, zoom: Math.max(map.getZoom(), 12.5) }); state.hold = Date.now() + 8000;
  }
  card.addEventListener('click', e => { if (e.target.closest('[data-evclose]')) card.hidden = true; });

  /* ---------- impact sur le trajet : événements et ralentissements devant nous ---------- */
  function samples(coords, cum) {                                       // points de passage tous les ~80 m
    const out = []; let next = 0;
    for (let i = 0; i < coords.length; i++) if (cum[i] >= next || i === coords.length - 1) { out.push({ c: coords[i], a: cum[i] }); next = cum[i] + 80; }
    return out;
  }
  /* point le plus proche du tracé (distance au segment entre deux points de passage, pas au point : l'écart de géométrie des sources atteint ~100 m) */
  function nearest(S, p, maxM) {
    let bd = maxM, best = null;
    const dl = (maxM + 120) / 111000, dlo = dl / Math.cos(p[1] * RAD);
    for (let i = 0; i < S.length - 1; i++) {
      const q = S[i].c;
      if (Math.abs(q[1] - p[1]) > dl || Math.abs(q[0] - p[0]) > dlo) continue;
      const d = proj(p, q, S[i + 1].c).d;
      if (d < bd) { bd = d; best = i; }
    }
    return best == null ? null : { i: best, d: bd };
  }
  /* Ralentissements sur un tracé : tronçons de mesure alignés avec le sens de marche ; retard estimé (modèle simple, pas une mesure) */
  function slowOn(S, flow) {
    const out = []; let delay = 0;
    for (const f of flow.features) {
      const p = f.properties; if (p.l < 1) continue;
      const [a, b] = f.geometry.coordinates.length > 1 ? [f.geometry.coordinates[0], f.geometry.coordinates[f.geometry.coordinates.length - 1]] : [null, null];
      if (!a) continue;
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], n = nearest(S, mid, 110);
      if (!n || [a, b].filter(q => nearest(S, q, 130)).length < 1) continue;   // le milieu ET au moins une extrémité du tronçon doivent suivre le tracé
      const j = Math.min(S.length - 1, n.i + 1), ro = bearing(S[Math.max(0, n.i - 1)].c, S[j].c);
      if (Math.abs(angDiff(ro, bearing(a, b))) > 60) continue;           // autre sens de circulation : pas concerné
      const len = Math.max(150, dist(a, b)), v = Math.max(5, p.v || 20), vref = /^A\d/.test(p.a) ? 90 : 50;
      const dl = Math.max(0, len * (1 / (v / 3.6) - 1 / (vref / 3.6)));
      out.push({ a: S[n.i].a, len, l: p.l, v: p.v, dl, road: p.a }); delay += dl;
    }
    return { sections: out.sort((x, y) => x.a - y.a), delayS: delay };
  }
  function routeScan() {
    const r = state.route;
    if (!r || !r.coords) { T.route = null; return; }
    const S = samples(r.coords, r.cum), events = [];
    if (on('tEv')) for (const e of T.ev) {
      const n = nearest(S, e.a, 90) || (e.b && nearest(S, e.b, 90));
      if (n) events.push({ e, along: S[n.i].a });
    }
    const slow = on('tFlow') && T.flowFc ? slowOn(S, T.flowFc) : { sections: [], delayS: 0 };
    T.route = { r, S, events, slow, ver: r };
  }
  function ahead() {                                                    // vue relative à notre position sur l'itinéraire
    if (!T.route || T.route.r !== state.route) routeScan();
    if (!T.route) return null;
    const cur = state.alongFix, v = Math.max(8, state.kmh / 3.6);
    if (cur == null) return null;
    T.route.events.forEach(x => { x.d = x.along - cur; x.eta = x.d / v; });
    return { events: T.route.events.filter(x => x.d > -50).sort((a, b) => a.d - b.d), sections: T.route.slow.sections.filter(s => s.a + s.len / 2 > cur).map(s => Object.assign({ d: Math.max(0, s.a - s.len / 2 - cur) }, s)) };
  }

  /* ---------- alertes pendant la navigation (visuelles, et vocales pour les dangers) ---------- */
  const pill = document.createElement('div');
  pill.id = 'tAlert'; pill.hidden = true; $('hud').insertBefore(pill, $('hud').firstChild);
  let pillAct = null;
  function alertTick() {
    if (!state.route) { pill.hidden = true; return; }
    const A = ahead();
    if (!A) { pill.hidden = true; return; }
    const reach = e => CAT[e.e.cat].major || CAT[e.e.cat].voice ? Math.max(2500, state.kmh / 3.6 * 45) : 1200;
    const near = A.events.find(x => x.d <= reach(x));
    for (const x of A.events) {
      if (x.d <= reach(x) && CAT[x.e.cat].voice && !T.said.has(x.e.id)) {
        T.said.add(x.e.id);
        if (!(window.speechSynthesis && speechSynthesis.speaking)) speak(`${evTitle(x.e)} dans ${quantDist(x.d)}`);
      }
    }
    const sec = A.sections.find(s => s.d < 25000);
    const delay = T.route.slow.delayS;
    if (near) {
      pillAct = { type: 'ev', id: near.e.id };
      pill.className = 'ev'; pill.style.setProperty('--c', CAT[near.e.cat].col);
      pill.innerHTML = ic('ev_' + near.e.cat) + `<span><b>${esc(evTitle(near.e))}</b> · ${fmtDist(Math.max(0, near.d))}<small>sur votre itinéraire</small></span>`;
      pill.hidden = false;
    } else if (sec) {
      pillAct = { type: 'slow' };
      const m = Math.round(delay / 60);
      pill.className = 'slow'; pill.style.setProperty('--c', LV_COL[sec.l]);
      pill.innerHTML = ic('traffic') + `<span><b>${LV[sec.l]}</b> dans ${fmtDist(sec.d)}${m >= 2 ? ` · ≈ +${m} min` : ''}<small>${m >= 5 ? 'Touchez pour comparer un autre itinéraire' : 'sur votre itinéraire (estimation)'}</small></span>`;
      pill.hidden = false;
    } else pill.hidden = true;
  }
  pill.addEventListener('click', () => { if (!pillAct) return; if (pillAct.type === 'ev') openEvent(pillAct.id); else openCompare(); });
  setInterval(() => { try { alertTick(); } catch (e) { /* ne doit jamais gêner la navigation */ } }, 1000);

  /* ---------- comparaison d'itinéraires selon le trafic (jamais de changement automatique) ---------- */
  const cmp = document.createElement('div');
  cmp.id = 'tCompare'; cmp.className = 'sheet'; cmp.hidden = true; document.body.appendChild(cmp);
  async function openCompare() {
    if (!state.dest || !state.pos) return;
    if (window.closeSheets) closeSheets('cmp');
    cmp.hidden = false; cmp.innerHTML = head('Itinéraires et trafic') + '<div class="sheetBody"><p class="nvNote">Calcul des itinéraires…</p></div>';
    try {
      const main = await fetchTrip(state.pos, state.dest.coord, true), alts = (fetchTrip.alts || []).slice(0, 2);
      const trips = [main, ...alts], rows = trips.map(t => {
        const coords = decodePoly(t.legs[0].shape), cum = [0];
        for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + dist(coords[i - 1], coords[i]);
        const S = samples(coords, cum), sl = T.flowFc ? slowOn(S, T.flowFc) : { delayS: 0, sections: [] };
        return { t, km: cum[cum.length - 1] / 1000, base: t.summary.time, delay: sl.delayS, tot: t.summary.time + sl.delayS, n: sl.sections.length };
      });
      T.cmp = { rows, main, alts };
      const best = rows.reduce((a, b) => b.tot < a.tot ? b : a, rows[0]), gain = rows[0].tot - best.tot;
      const verdict = best !== rows[0] && gain >= 180 ? `L’itinéraire ${rows.indexOf(best) + 1} fait gagner ≈ ${Math.round(gain / 60)} min d’après le trafic mesuré.`
        : 'Aucun itinéraire alternatif ne fait gagner au moins 3 min d’après le trafic mesuré : vous gardez le meilleur.';
      cmp.innerHTML = head('Itinéraires et trafic') + `<div class="sheetBody"><p class="nvLine">${verdict}</p>` + rows.map((r, i) => `<div class="nvCard ${r === best ? 'sel' : ''}" style="--c:${['#22d3ee', '#f59e0b', '#a78bfa'][i]}">
        <div class="nvHead"><i></i><b>${fmtDur(r.tot)}</b><span>${fmtKm(r.km)}${r.delay >= 60 ? ` · dont ≈ +${Math.round(r.delay / 60)} min de ralentissements` : ' · aucun ralentissement mesuré'}</span></div>
        <div class="tcAct"><span class="nvNote">${i === 0 ? 'Itinéraire actuel' : 'Alternative'} · hors trafic ${fmtDur(r.base)}</span>${i === 0 ? '' : `<button class="nvGo" data-pick="${i}">Choisir</button>`}</div></div>`).join('')
        + '<p class="nvNote">Retards estimés à partir des vitesses mesurées sur le réseau national (autoroutes et routes nationales non concédées) : les autres routes ne sont pas couvertes. Estimation, pas une mesure sur votre trajet.</p></div>';
    } catch (e) { cmp.innerHTML = head('Itinéraires et trafic') + `<div class="sheetBody"><p class="nvNote">Calcul impossible : ${esc(e.message)}</p></div>`; }
  }
  const head = t => `<header class="sheetHead"><h2>${t}</h2><button class="sheetX" data-tclose>${ic('x')}</button></header>`;
  cmp.addEventListener('click', e => {
    if (e.target.closest('[data-tclose]')) { cmp.hidden = true; return; }
    const b = e.target.closest('[data-pick]');
    if (b && T.cmp) { const i = +b.dataset.pick, trips = [T.cmp.main, ...T.cmp.alts], t = trips[i]; fetchTrip.alts = trips.filter(x => x !== t); setRoute(t, true); cmp.hidden = true; T.said.clear(); status('Nouvel itinéraire choisi', 2500); }
  });
  const fmtKm = km => `${km < 10 ? km.toFixed(1).replace('.', ',') : Math.round(km)} km`;

  /* ---------- carte de commandes : activer/désactiver, légende, fraîcheur ---------- */
  const tc = document.createElement('div');
  tc.id = 'trafCard'; tc.hidden = true; document.body.appendChild(tc);
  const sw = (k, label, sub, icon) => `<div class="row"><span><span class="lbl"><i>${ic(icon)}</i>${label}</span><small>${sub}</small></span><button class="sw" data-tk="${k}" role="switch" aria-checked="${on(k)}"></button></div>`;
  function paintCard() {
    if (tc.hidden) return;
    const line = (kind, s) => {
      const st = stOf(kind + ':' + s.id), a = st.updated ? Date.now() - st.updated : null;
      const cls = !st.data ? (st.ok === false ? 'bad' : 'wait') : a > s.maxAge ? 'bad' : a > s.maxAge / 2 ? 'mid' : 'ok';
      const t = !st.data ? (st.ok === false ? 'indisponible' : (s.bbox && !inBbox(s.bbox) ? 'hors zone' : 'chargement…')) : a > s.maxAge ? `trop ancien (${age(a)}) : masqué` : `mis à jour ${age(a)}`;
      return `<div class="fr ${cls}"><i></i><span>${s.name}</span><em>${t}</em></div>`;
    };
    tc.innerHTML = `<header class="sheetHead"><h2>Circulation</h2><button class="sheetX" data-tclose>${ic('x')}</button></header><div class="sheetBody">
      ${sw('tFlow', 'Trafic', 'Vitesses mesurées sur la carte', 'traffic')}${sw('tEv', 'Événements routiers', 'Accidents, travaux, fermetures…', 'warn')}
      ${sw('rd', 'Zones de vigilance', 'Alerte visuelle, sans position précise', 'warn')}${sw('zoneVoice', 'Alerte sonore des zones', 'Message vocal à l’approche', 'volume')}
      <h3>Légende</h3><div class="tleg">${LV.map((n, i) => `<span><i style="background:${LV_COL[i]}"></i>${n}</span>`).join('')}</div>
      <div class="tleg ev">${Object.entries(CAT).map(([k, v]) => `<span><i class="ei" style="--c:${v.col}">${ic('ev_' + k)}</i>${v.t}</span>`).join('')}<span><i class="ei" style="--c:#fb923c">${ic('warn')}</i>Zone de vigilance</span></div>
      <h3>Fraîcheur des données</h3>${SOURCES.flow.map(s => line('flow', s)).join('')}${SOURCES.events.map(s => line('events', s)).join('')}
      <small>Niveaux calculés d’après les vitesses mesurées (autoroutes et routes nationales non concédées, métropole de Bordeaux). Hors de ces réseaux, aucune donnée : l’absence de couleur ne signifie pas « fluide ».</small></div>`;
  }
  tc.addEventListener('click', e => {
    if (e.target.closest('[data-tclose]')) { tc.hidden = true; $('trafBtn').classList.remove('on'); return; }
    const b = e.target.closest('[data-tk]');
    if (!b) return;
    const k = b.dataset.tk, v = b.getAttribute('aria-checked') !== 'true';
    prefs[k] = v; savePrefs(); b.setAttribute('aria-checked', v);
    if (k === 'rd') { RD.on = v; setSw('swRd', v); radarTick(); }
    applyVis();
    if (k === 'tFlow' || k === 'tEv') { for (const kind of ['flow', 'events']) for (const s of SOURCES[kind]) stOf(kind + ':' + s.id).next = 0; lastVer = { flow: '', events: '' }; tick(); rebuild(k === 'tFlow' ? 'flow' : 'events'); }
  });
  $('trafBtn').addEventListener('click', e => {
    e.stopPropagation();
    tc.hidden = !tc.hidden; $('trafBtn').classList.toggle('on', !tc.hidden);
    if (!tc.hidden) { tick(); paintCard(); }
  });
  setInterval(paintCard, 20000);
  window.trafficEventClose = () => { card.hidden = true; };

  setInterval(tick, 20000);
  map.on('moveend', () => { for (const s of SOURCES.flow) if (s.bbox) { const st = stOf('flow:' + s.id); if (!st.data && inBbox(s.bbox)) st.next = 0; } tick(); });   // zone locale : première récupération à l'entrée seulement
  document.addEventListener('visibilitychange', tick);
  window.addEventListener('online', () => { for (const k of Object.keys(T.st)) T.st[k].next = 0; tick(); });
  tick();
  window.NAVIA_TRAFFIC = { T, SOURCES, dedupe, slowOn, samples, openCompare };
})();
