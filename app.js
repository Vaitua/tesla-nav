'use strict';
/* Tesla Nav — navigation 3D gratuite (OpenFreeMap + Valhalla/OSM + Photon).
   Mode simulation : ?sim=50 (vitesse en km/h) et &from=lon,lat */

const $ = id => document.getElementById(id);
const P = new URLSearchParams(location.search);
const SIM = P.has('sim');
if (P.has('lite')) document.body.classList.add('lite');   // ?lite=1 : verre sans flou (si l'écran rame)
const SIM_KMH = Number(P.get('sim')) || 50;
const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
const STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const RAD = Math.PI / 180;

/* ---------- géométrie ---------- */
function dist(a, b) {
  const dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(s));
}
function bearing(a, b) {
  const dl = (b[0] - a[0]) * RAD;
  const y = Math.sin(dl) * Math.cos(b[1] * RAD);
  const x = Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) - Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos(dl);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}
const angDiff = (a, b) => ((b - a + 540) % 360) - 180;
function proj(p, a, b) { // distance (m) du point p au segment ab + position t∈[0,1]
  const kx = Math.cos(p[1] * RAD) * 111320, ky = 110540;
  const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
  return { d: Math.hypot(ax + t * dx, ay + t * dy), t };
}
function decodePoly(str, precision = 6) {
  const f = 10 ** precision, out = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const axis of [0, 1]) {
      let b, shift = 0, res = 0;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 31) << shift; shift += 5; } while (b >= 32);
      const d = (res & 1) ? ~(res >> 1) : (res >> 1);
      if (axis === 0) lat += d; else lng += d;
    }
    out.push([lng / f, lat / f]);
  }
  return out;
}

/* ---------- formats ---------- */
const fmtDist = m => m < 950 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
function fmtDur(s) {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`;
}
// distance annoncée "arrondie" sur des valeurs fixes (permet de pré-synthétiser les préfixes)
function quantDist(m) {
  const steps = [100, 150, 200, 300, 400, 500, 600, 800, 1000, 1500, 2000, 3000, 5000];
  const v = steps.reduce((a, b) => Math.abs(b - m) < Math.abs(a - m) ? b : a);
  if (v === 1000) return '1 kilomètre';
  return v >= 1500 ? `${v / 1000 === Math.round(v / 1000) ? v / 1000 : String(v / 1000).replace('.', ',')} kilomètres` : `${v} mètres`;
}
const lc = s => s.charAt(0).toLowerCase() + s.slice(1);
function icon(type) {
  if ([9, 18, 20, 23, 37].includes(type)) return '↗';
  if ([10, 2, 5].includes(type)) return '→';
  if (type === 11) return '↘';
  if ([12, 13].includes(type)) return '↩';
  if (type === 14) return '↙';
  if ([15, 3, 6].includes(type)) return '←';
  if ([16, 19, 21, 24, 38].includes(type)) return '↖';
  if ([26, 27].includes(type)) return '⟳';
  if ([4].includes(type)) return '⚑';
  return '↑';
}

/* ---------- état ---------- */
const state = {
  pos: null, ref: null, t: 0, kmh: 0, heading: 0,
  route: null, dest: null, off: 0, rerouting: false, lastRR: 0,
  curMan: -1, said: {}, hold: 0, pick: null,
  zoomOffset: 0, autoZoom: true, nextMan: null,
  alongFix: null, limit: null, hist: [], limBusy: false, limT: 0, assign: null,
};
try {
  state.zoomOffset = Number(localStorage.getItem('zoomOffset')) || 0;
  state.autoZoom = localStorage.getItem('autoZoom') !== '0';
  state.muted = localStorage.getItem('muted') === '1';
} catch (e) { /* stockage indisponible */ }
let simTimer = null;

function status(msg, ms) {
  $('status').textContent = msg || '';
  if (msg && ms) setTimeout(() => { if ($('status').textContent === msg) $('status').textContent = ''; }, ms);
}
/* ---------- préférences (calques, voix) ---------- */
let prefs = {};
try { prefs = JSON.parse(localStorage.getItem('prefs') || '{}') || {}; } catch (e) { prefs = {}; }
function savePrefs() { try { localStorage.setItem('prefs', JSON.stringify(prefs)); } catch (e) { /* ignoré */ } }

/* ---------- voix de navigation ----------
   2 moteurs : "système" (la meilleure voix française du navigateur, choisie automatiquement)
   et "HD" (voix neuronale Piper exécutée dans le navigateur, chargée à la demande).
   Les annonces sont découpées ("Dans 300 mètres," + consigne) et les consignes à venir sont
   pré-synthétisées en avance : la voix HD parle sans délai. */
const HD_LIB = 'https://esm.sh/@diffusionstudio/vits-web@1.0.3';
const HD_VOICES = ['fr_FR-siwis-medium', 'fr_FR-upmc-medium', 'fr_FR-siwis-low'];
const VOICE = { mode: prefs.hd ? 'hd' : 'system', hd: null, hdId: null, loading: false, cache: new Map(), chain: null, token: 0, audio: null };

function frVoices() {
  const score = v => {
    const n = v.name; let s = 0;
    if (/natural|neural|online/i.test(n)) s += 50;
    if (/premium|enhanced|siri/i.test(n)) s += 40;
    if (/google/i.test(n)) s += 30;
    if (/am[ée]lie|thomas|audrey|denise|henri|vivienne|r[ée]my|[ée]loise|julie|hortense|paul/i.test(n)) s += 15;
    if (/fr[-_]FR/i.test(v.lang)) s += 10;
    if (!v.localService) s += 5;
    if (/compact|espeak|festival|robot/i.test(n)) s -= 30;
    return s;
  };
  try { return speechSynthesis.getVoices().filter(v => /^fr/i.test(v.lang)).sort((a, b) => score(b) - score(a)); }
  catch (e) { return []; }
}
function currentSysVoice() {
  const list = frVoices();
  return list.find(v => v.name === prefs.sysVoice) || list[0] || null;
}
function speakSystem(parts) {
  try {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(parts.join(' '));
    const v = currentSysVoice();
    if (v) u.voice = v;
    u.lang = v ? v.lang : 'fr-FR'; u.rate = 1.02; u.pitch = 1;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (e) { /* voix indisponible */ }
}
function stopSpeech() {
  VOICE.token++;
  try { speechSynthesis.cancel(); } catch (e) { /* ignoré */ }
  if (VOICE.audio) { try { VOICE.audio.pause(); } catch (e) { /* ignoré */ } }
}
function hdSynth(text) {
  let p = VOICE.cache.get(text);
  if (p) return p;
  const run = () => VOICE.hd.predict({ text, voiceId: VOICE.hdId }).then(b => URL.createObjectURL(b));
  p = (VOICE.chain || Promise.resolve()).catch(() => {}).then(run);   // une synthèse à la fois
  VOICE.chain = p; VOICE.cache.set(text, p);
  p.catch(() => VOICE.cache.delete(text));
  if (VOICE.cache.size > 80) VOICE.cache.delete(VOICE.cache.keys().next().value);
  return p;
}
function prefetchVoice(texts) {
  if (VOICE.mode !== 'hd' || !VOICE.hd) return;
  for (const t of texts) if (t) hdSynth(t).catch(() => {});
}
function playUrl(url) {
  return new Promise(res => {
    const a = VOICE.audio || (VOICE.audio = new Audio());
    a.onended = a.onerror = () => res();
    a.src = url;
    a.play().catch(() => res());
  });
}
async function speakHd(parts) {
  const token = ++VOICE.token;
  try {
    for (const part of parts) {
      const wait = new Promise(r => setTimeout(() => r(null), 2500));       // trop long ? on bascule sur la voix système
      const url = await Promise.race([hdSynth(part), wait]);
      if (token !== VOICE.token) return;
      if (!url) { speakSystem(parts.slice(parts.indexOf(part))); return; }
      await playUrl(url);
      if (token !== VOICE.token) return;
    }
  } catch (e) { speakSystem(parts); }
}
function speak(parts) {
  if (state.muted) return;
  parts = [].concat(parts).filter(Boolean);
  if (!parts.length) return;
  stopSpeech();
  if (VOICE.mode === 'hd' && VOICE.hd) speakHd(parts); else speakSystem(parts);
}
function setHdStatus(t) { const el = document.getElementById('hdStatus'); if (el) el.textContent = t; }
async function loadHd() {
  if (VOICE.hd || VOICE.loading) return;
  VOICE.loading = true; setHdStatus('Chargement de la voix…');
  try {
    const mod = await import(HD_LIB);
    let lastErr = null;
    for (const id of HD_VOICES) {
      try {
        await mod.download(id, p => { if (p && p.total) setHdStatus(`Téléchargement ${Math.round(p.loaded * 100 / p.total)} %`); });
        VOICE.hdId = id; break;
      } catch (e) { lastErr = e; }
    }
    if (!VOICE.hdId) throw lastErr || new Error('aucune voix');
    VOICE.hd = mod;
    setHdStatus('Prête ✓ (voix neuronale)');
    prefetchVoice(['Dans 100 mètres,', 'Dans 200 mètres,', 'Dans 300 mètres,', 'Dans 500 mètres,', 'Dans 1 kilomètre,']);
  } catch (e) {
    VOICE.mode = 'system'; prefs.hd = false; savePrefs();
    setHdStatus('Indisponible — voix système utilisée');
    const sw = document.getElementById('swHd'); if (sw) sw.setAttribute('aria-checked', 'false');
  } finally { VOICE.loading = false; }
}

/* ---------- carte ---------- */
const map = new maplibregl.Map({
  container: 'map', style: { version: 8, sources: {}, layers: [] }, center: [2.3212, 48.8656], zoom: 16, pitch: 62,
  maxPitch: 80, attributionControl: { compact: true },
});
// Le style OpenFreeMap "liberty" est repeint à la volée avec notre propre palette (voir THEMES)
map.setStyle(STYLE, { diff: false, transformStyle: (prev, next) => themeStyle(next) });
const carEl = document.createElement('div');
carEl.className = 'car';
carEl.innerHTML = '<svg viewBox="0 0 60 60" width="60" height="60"><polygon points="30,4 54,54 30,42 6,54" fill="#3b82f6" stroke="#fff" stroke-width="5" stroke-linejoin="round"/></svg>';
// pitchAlignment 'viewport' : la flèche reste bien lisible malgré l'inclinaison 3D de la carte
const carMarker = new maplibregl.Marker({ element: carEl, rotationAlignment: 'map', pitchAlignment: 'viewport' });
let destMarker = null;

/* ---------- thèmes jour / nuit de la carte ---------- */
const THEMES = {
  day: {
    // Jour : fond bleuté très clair, parcs menthe, eau azur, routes blanches, autoroutes lavande, bâtiments blancs teintés de bleu
    land: '#f1f4fa', res: '#eaeff8', park: '#bfead0', wood: '#aee2c3', water: '#9bd0ff', hospital: '#ffe1e6', aero: '#e2e7f1',
    b0: '#f8faff', b1: '#b4c5e6', b2d: '#e1e9f6',
    minor: '#ffffff', minorCase: '#dce3ef', sec: '#ffffff', secCase: '#c9d3e4',
    pri: '#ffffff', priCase: '#b6c3da', mw: '#d6ddff', mwCase: '#8fa0ee',
    path: '#e3e8f1', pathCase: '#d3dbe8', rail: '#cbd2df', bound: '#c9c2ee',
    text: '#26324a', halo: 'rgba(255,255,255,.96)', textWater: '#2f78c4',
    routeLine: '#2563ff', routeCasing: '#ffffff', sky: '#e4ecf8',
  },
  night: {
    // Nuit : bleu nuit profond, bâtiments indigo, autoroutes indigo lumineux, tracé cyan néon
    land: '#0d1426', res: '#101a33', park: '#0e2d33', wood: '#0b2830', water: '#0a2a52', hospital: '#2a1a33', aero: '#151e38',
    b0: '#1b2749', b1: '#3d4f94', b2d: '#172140',
    minor: '#212c4e', minorCase: '#080d1b', sec: '#2b3961', secCase: '#080d1b',
    pri: '#37477a', priCase: '#080d1b', mw: '#4a5ae0', mwCase: '#161c5c',
    path: '#1a2342', pathCase: '#0a1020', rail: '#1d2644', bound: '#2d3870',
    text: '#d9e2ff', halo: 'rgba(8,13,27,.92)', textWater: '#6db8ff',
    routeLine: '#22d3ee', routeCasing: '#052c44', sky: '#080c1a',
  },
};
const HIDE = new Set(['natural_earth', 'poi_r20', 'poi_r7', 'poi_r1', 'highway-shield-non-us', 'highway-shield-us-interstate', 'road_shield_us', 'poi_transit', 'road_one_way_arrow',
  'road_one_way_arrow_opposite', 'road_area_pattern', 'landuse_track', 'landuse_pitch']);

function themePaint(l, t) {
  const id = l.id, p = {};
  if (l.type === 'background') p['background-color'] = t.land;
  else if (l.type === 'fill-extrusion') {
    p['fill-extrusion-color'] = ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 0], 0, t.b0, 150, t.b1];
    p['fill-extrusion-opacity'] = 0.96;
    p['fill-extrusion-vertical-gradient'] = true;
  } else if (l.type === 'fill') {
    let c = null;
    if (/^park|^landcover_(grass|wetland)/.test(id)) c = t.park;
    else if (id === 'landcover_wood') c = t.wood;
    else if (id === 'water') c = t.water;
    else if (/^landuse_(residential|cemetery|school)|^landcover_(sand|ice)/.test(id)) c = t.res;
    else if (id === 'landuse_hospital') c = t.hospital;
    else if (/^aeroway/.test(id)) c = t.aero;
    else if (id === 'building') c = t.b2d;
    if (c) p['fill-color'] = c;
  } else if (l.type === 'line') {
    if (/^waterway/.test(id)) p['line-color'] = t.water;
    else if (/rail/.test(id)) p['line-color'] = t.rail;
    else if (/^boundary/.test(id)) p['line-color'] = t.bound;
    else if (id === 'park_outline') p['line-color'] = t.park;
    else if (/^(tunnel|road|bridge)_/.test(id)) {
      const k = /motorway/.test(id) ? 'mw' : /trunk_primary/.test(id) ? 'pri'
        : /secondary_tertiary|link|street/.test(id) ? 'sec' : /path/.test(id) ? 'path' : 'minor';
      p['line-color'] = /casing/.test(id) ? t[k + 'Case'] : t[k];
    }
  } else if (l.type === 'symbol') {
    p['text-color'] = /water/.test(id) ? t.textWater : t.text;
    p['text-halo-color'] = t.halo;
  }
  return p;
}
function themeStyle(style) {
  const t = THEMES[document.body.classList.contains('night') ? 'night' : 'day'];
  for (const l of style.layers) {
    l.paint = { ...(l.paint || {}), ...themePaint(l, t) };
    if (HIDE.has(l.id)) l.layout = { ...(l.layout || {}), visibility: 'none' };
    // routes aux extrémités arrondies : rendu plus doux
    if (l.type === 'line' && /^(tunnel|road|bridge)_/.test(l.id) && !/rail/.test(l.id)) {
      l.layout = { ...(l.layout || {}), 'line-cap': 'round', 'line-join': 'round' };
    }
  }
  // Lumière douce et diffuse : évite les bâtiments 3D gris et sombres
  style.light = { anchor: 'viewport', color: '#ffffff', intensity: 0.28, position: [1.2, 200, 40] };
  return style;
}
function applyTheme(night) {
  const t = THEMES[night ? 'night' : 'day'];
  document.getElementById('map').style.background = t.sky;
  document.documentElement.style.setProperty('--sky', t.sky);
  try {
    const st = map.getStyle();
    if (!st || !st.layers.length) return;
    for (const l of st.layers) {
      if (l.id.startsWith('route-')) continue;
      const p = themePaint(l, t);
      for (const k in p) map.setPaintProperty(l.id, k, p[k]);
    }
    if (map.getLayer('route-line')) {
      map.setPaintProperty('route-line', 'line-color', t.routeLine);
      map.setPaintProperty('route-casing', 'line-color', t.routeCasing);
    }
  } catch (e) { /* style pas encore chargé : themeStyle s'en charge */ }
}

map.on('style.load', () => {
  const t = THEMES[document.body.classList.contains('night') ? 'night' : 'day'];
  if (map.getSource('route')) return;
  map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  const w = ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 14, 19, 26];
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': t.routeCasing, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 7, 16, 19, 19, 33] } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': t.routeLine, 'line-width': w } });
});

/* Manœuvres "complexes" : bretelles, sorties, insertions, ronds-points, demi-tours, virages serrés */
const COMPLEX = new Set([11, 12, 13, 14, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 37, 38]);

function camTarget() {
  const k = state.kmh;
  let zoom = k < 25 ? 17.3 : k < 55 ? 16.6 : k < 85 ? 15.8 : 15;
  let pitch = 62;
  const n = state.nextMan;
  if (state.autoZoom && state.route && n && COMPLEX.has(n.type)) {
    // Plus on approche, plus on zoome (rond-points/bretelles : à partir de ~500 m)
    const reach = Math.max(350, Math.min(600, (k / 3.6) * 16));
    if (n.d < reach) {
      const f = 1 - n.d / reach;                       // 0 au loin → 1 sur la manœuvre
      zoom = Math.max(zoom, zoom + (17.6 - zoom) * Math.min(1, f * 1.6));
      pitch = 62 - 14 * Math.min(1, f * 1.6);          // vue un peu plus "du dessus" pour lire la géométrie
    }
  }
  zoom = Math.max(11, Math.min(20, zoom + state.zoomOffset));
  return { zoom, pitch };
}

/* ---------- animation fluide (60 i/s) ----------
   Le GPS ne donne qu'une position par seconde : on extrapole entre deux fixes
   (le long de l'itinéraire quand il y en a un) et on lisse position, cap, zoom et inclinaison. */
function moveAlong(pos, brg, m) {
  const r = brg * RAD;
  return [pos[0] + (m * Math.sin(r)) / (111320 * Math.cos(pos[1] * RAD)), pos[1] + (m * Math.cos(r)) / 110540];
}
function rawPointAt(r, a) {
  a = Math.max(0, Math.min(r.total, a));
  let lo = 0, hi = r.cum.length - 2;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (r.cum[mid] <= a) lo = mid; else hi = mid - 1; }
  const A = r.coords[lo], B = r.coords[lo + 1] || A, len = r.cum[lo + 1] - r.cum[lo] || 1;
  const t = Math.max(0, Math.min(1, (a - r.cum[lo]) / len));
  return { pos: [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t], A, B };
}
function pointAtAlong(r, a) {
  const p = rawPointAt(r, a), ahead = rawPointAt(r, a + 12).pos;
  const brg = dist(p.pos, ahead) > 1 ? bearing(p.pos, ahead) : bearing(p.A, p.B);
  return { pos: p.pos, brg };
}
function targetPose(now) {
  const dt = Math.min(2.5, (now - state.t) / 1000);
  const v = state.kmh < 2 ? 0 : state.kmh / 3.6;
  const r = state.route;
  if (r && state.alongFix != null) return pointAtAlong(r, state.alongFix + v * dt);
  return { pos: v ? moveAlong(state.pos, state.heading, v * dt) : state.pos, brg: state.heading };
}

const disp = { pos: null, cam: null, bearing: 0, camBearing: 0, zoom: 16, pitch: 62, last: 0, held: false };
const lerp = (a, b, k) => a + (b - a) * k;

function frame(ts) {
  requestAnimationFrame(frame);
  if (!state.pos || !map.loaded()) return;
  const dt = Math.min(0.1, (ts - (disp.last || ts)) / 1000);
  disp.last = ts;
  const now = Date.now(), tp = targetPose(now);

  if (!disp.pos || dist(disp.pos, tp.pos) > 150) {           // premier affichage ou grand saut : on recale
    disp.pos = tp.pos; disp.cam = tp.pos; disp.bearing = disp.camBearing = tp.brg;
    const t0 = camTarget(); disp.zoom = t0.zoom; disp.pitch = t0.pitch;
  }
  const kp = 1 - Math.exp(-dt * 10);
  disp.pos = [lerp(disp.pos[0], tp.pos[0], kp), lerp(disp.pos[1], tp.pos[1], kp)];
  disp.bearing = (disp.bearing + angDiff(disp.bearing, tp.brg) * (1 - Math.exp(-dt * 3.5)) + 360) % 360;
  carMarker.setLngLat(disp.pos).setRotation(disp.bearing);
  if (!carMarker._map) carMarker.addTo(map);

  if (now < state.hold) { disp.held = true; return; }          // aperçu de l'itinéraire : on ne touche pas à la caméra
  if (disp.held) {                                              // reprise en douceur depuis la vue d'ensemble
    const c = map.getCenter();
    disp.cam = [c.lng, c.lat]; disp.zoom = map.getZoom(); disp.pitch = map.getPitch(); disp.camBearing = map.getBearing();
    disp.held = false;
  }
  const ct = camTarget();
  disp.zoom = lerp(disp.zoom, ct.zoom, 1 - Math.exp(-dt * 2.2));
  disp.pitch = lerp(disp.pitch, ct.pitch, 1 - Math.exp(-dt * 2.2));
  disp.camBearing = (disp.camBearing + angDiff(disp.camBearing, disp.bearing) * (1 - Math.exp(-dt * 4)) + 360) % 360;
  const kc = 1 - Math.exp(-dt * 7);
  disp.cam = [lerp(disp.cam[0], disp.pos[0], kc), lerp(disp.cam[1], disp.pos[1], kc)];
  map.jumpTo({
    center: disp.cam, bearing: disp.camBearing, zoom: disp.zoom, pitch: disp.pitch,
    padding: { top: Math.round(window.innerHeight * 0.38), bottom: 0, left: 0, right: 0 },
  });
}

/* ---------- position (GPS ou simulation) ---------- */
function onFix(pos, speedMs, hdg) {
  const now = Date.now();
  if (state.pos && speedMs == null) speedMs = dist(state.pos, pos) / Math.max(0.2, (now - state.t) / 1000);
  if (!state.ref || dist(state.ref, pos) > 6) {
    if (state.ref && (hdg == null || isNaN(hdg))) hdg = bearing(state.ref, pos);
    state.ref = pos;
  }
  const kmh = (speedMs || 0) * 3.6;
  state.kmh = state.t ? state.kmh * 0.4 + kmh * 0.6 : kmh;
  if (hdg != null && !isNaN(hdg) && kmh > 3) {
    state.heading = (state.heading + angDiff(state.heading, hdg) * 0.6 + 360) % 360;
  }
  const firstFix = !state.t;
  state.pos = pos; state.t = now;
  if (firstFix) applyNight();       // premier point GPS : on recalcule jour/nuit pour la vraie position

  $('spd').textContent = state.kmh < 2 ? 0 : Math.round(state.kmh);
  document.body.classList.toggle('moving', state.kmh > 8);
  if (!state.hist.length || dist(state.hist[state.hist.length - 1], pos) > 20) {
    state.hist.push(pos);
    if (state.hist.length > 6) state.hist.shift();
  }
  navUpdate();
  freeLimit();
  setLimit(state.limit);   // met à jour le dépassement
  weatherTick();
}

function startGPS() {
  if (SIM) {
    const from = (P.get('from') || '2.3212,48.8656').split(',').map(Number);
    onFix(from, 0, null);
    return;
  }
  if (!navigator.geolocation) { status('Géolocalisation indisponible'); return; }
  status('En attente du GPS…');
  navigator.geolocation.watchPosition(
    g => { status(''); onFix([g.coords.longitude, g.coords.latitude], g.coords.speed, g.coords.heading); },
    e => status('GPS : ' + e.message),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
}

/* ---------- itinéraire ---------- */
async function fetchTrip(from, to) {
  const start = { lat: from[1], lon: from[0] };
  if (state.kmh > 8) { start.heading = Math.round(state.heading); start.heading_tolerance = 45; }
  const req = { locations: [start, { lat: to[1], lon: to[0] }], costing: 'auto',
    directions_options: { language: 'fr-FR', units: 'kilometers' } };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(VALHALLA + '?json=' + encodeURIComponent(JSON.stringify(req)), { signal: ctl.signal });
    if (!res.ok) throw new Error('routage ' + res.status);
    const j = await res.json();
    if (!j.trip) throw new Error('aucun itinéraire');
    return j.trip;
  } finally { clearTimeout(timer); }
}

function setRoute(trip, fit) {
  const leg = trip.legs[0];
  const coords = decodePoly(leg.shape);
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + dist(coords[i - 1], coords[i]);
  state.route = { coords, cum, man: leg.maneuvers, total: cum[cum.length - 1], time: trip.summary.time, idx: 0 };
  state.curMan = -1; state.said = {}; state.off = 0; state.alongFix = null;
  loadRouteLimits(state.route, leg.shape);
  map.getSource('route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords } });
  $('banner').hidden = false; $('trip').hidden = false;
  if (fit) {
    const b = coords.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    map.fitBounds(b, { padding: 120, pitch: 0, bearing: 0, duration: 1200 });
    state.hold = Date.now() + 3500;
  }
}

async function startNav(dest) {
  if (!state.pos) { status('Position GPS inconnue', 3000); return; }
  $('results').innerHTML = ''; $('q').value = dest.name || ''; $('q').blur(); hidePick();
  state.dest = dest;
  if (destMarker) destMarker.remove();
  const el = document.createElement('div'); el.className = 'dest'; el.textContent = '📍';
  destMarker = new maplibregl.Marker({ element: el }).setLngLat(dest.coord).addTo(map);
  status('Calcul de l’itinéraire…');
  try {
    setRoute(await fetchTrip(state.pos, dest.coord), true);
    status('');
    if (SIM) startSim();
  } catch (e) { status('Itinéraire impossible : ' + e.message, 4000); }
}

function stopNav() {
  state.route = null; state.dest = null; state.curMan = -1; state.nextMan = null; state.alongFix = null;
  if (simTimer) { clearInterval(simTimer); simTimer = null; }
  if (map.getSource('route')) map.getSource('route').setData({ type: 'FeatureCollection', features: [] });
  if (destMarker) { destMarker.remove(); destMarker = null; }
  $('banner').hidden = true; $('trip').hidden = true;
  stopSpeech();
}

async function reroute() {
  const now = Date.now();
  if (state.rerouting || now - state.lastRR < 8000 || !state.dest) return;
  state.rerouting = true; state.lastRR = now; status('Recalcul…');
  try {
    setRoute(await fetchTrip(state.pos, state.dest.coord), false);
    speak('Nouvel itinéraire'); status('');
  } catch (e) { status('Recalcul impossible', 3000); }
  finally { state.rerouting = false; state.off = 0; }
}

function progress(p) {
  const r = state.route;
  let best = { d: 1e9, i: 0, t: 0 };
  const scan = (a, b) => {
    for (let i = a; i <= b; i++) {
      const q = proj(p, r.coords[i], r.coords[i + 1]);
      if (q.d < best.d) best = { d: q.d, i, t: q.t };
    }
  };
  const last = r.coords.length - 2;
  scan(Math.max(0, r.idx - 10), Math.min(last, r.idx + 400));
  if (best.d > 40) { best = { d: 1e9, i: 0, t: 0 }; scan(0, last); }
  r.idx = best.i;
  best.along = r.cum[best.i] + best.t * (r.cum[best.i + 1] - r.cum[best.i]);
  return best;
}

function navUpdate() {
  const r = state.route;
  if (!r || !state.pos) return;
  const pr = progress(state.pos);
  state.alongFix = pr.d < 35 ? pr.along : null;
  if (r.limits) state.limit = limitAt(r, pr.along);
  if (pr.d > 45) { if (++state.off >= 3) reroute(); } else state.off = 0;

  let cur = 0;
  for (let k = 0; k < r.man.length; k++) if (r.man[k].begin_shape_index <= pr.i) cur = k;
  const next = r.man[cur + 1];
  const remain = r.total - pr.along;
  if (!next || remain < 25) { speak('Vous êtes arrivé à destination.'); status('Arrivé 🏁', 5000); stopNav(); return; }

  const d = r.cum[next.begin_shape_index] - pr.along;
  state.nextMan = { d, type: next.type };
  $('manIcon').textContent = icon(next.type);
  $('manDist').textContent = fmtDist(d);
  $('manText').textContent = next.instruction;

  const remS = r.time * (remain / r.total);
  const eta = new Date(Date.now() + remS * 1000);
  $('eta').textContent = eta.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  $('remTime').textContent = fmtDur(remS);
  $('remDist').textContent = fmtDist(remain);

  if (state.curMan !== cur) {
    state.curMan = cur;
    const m = r.man[cur];
    if (cur === 0) speak(m.instruction);
    else if (m.verbal_post_transition_instruction && m.length > 0.4) speak(m.verbal_post_transition_instruction);
    prefetchVoice(r.man.slice(cur + 1, cur + 4).map(x => x.instruction));   // voix HD : consignes prêtes à l'avance
  }
  const thr = Math.min(1000, Math.max(150, (state.kmh / 3.6) * 18));
  if (d < thr && !state.said[cur + 1]) {
    state.said[cur + 1] = 1;
    speak(d > 100 ? [`Dans ${quantDist(d)},`, next.instruction] : next.instruction);
  }
}

/* ---------- limitation de vitesse (données OSM via Valhalla trace_attributes) ---------- */
const VALHALLA_BASE = 'https://valhalla1.openstreetmap.de/';
async function vPost(path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    // text/plain = requête "simple" CORS, sans préflight
    const res = await fetch(VALHALLA_BASE + path, { method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(body), signal: ctl.signal });
    if (!res.ok) throw new Error(path + ' ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}
const FILTERS = { attributes: ['edge.speed_limit', 'edge.length'], action: 'include' };

async function loadRouteLimits(r, shape) {
  let j = null;
  for (const mode of ['edge_walk', 'map_snap']) {
    try {
      j = await vPost('trace_attributes', { encoded_polyline: shape, costing: 'auto', shape_match: mode, filters: FILTERS });
      if (j && j.edges && j.edges.length) break;
    } catch (e) { j = null; }
  }
  if (!j || !j.edges || state.route !== r) return;
  let acc = 0;
  const segs = j.edges.map(e => {
    const len = (e.length || 0) * 1000, s = { from: acc, to: acc + len, v: typeof e.speed_limit === 'number' ? e.speed_limit : null };
    acc += len; return s;
  });
  const k = acc ? r.total / acc : 1;     // recale sur la longueur de l'itinéraire
  segs.forEach(s => { s.from *= k; s.to *= k; });
  r.limits = segs; r.limIdx = 0;
}
function limitAt(r, along) {
  const L = r.limits;
  let i = Math.min(r.limIdx || 0, L.length - 1);
  while (i > 0 && L[i].from > along) i--;
  while (i < L.length - 1 && L[i].to <= along) i++;
  r.limIdx = i;
  return L[i].v;
}
/* Hors navigation : on recale les dernières positions sur le réseau routier toutes les ~12 s */
async function freeLimit() {
  if (state.route || state.limBusy || state.kmh < 15 || state.hist.length < 3) return;
  if (Date.now() - state.limT < 12000) return;
  state.limBusy = true; state.limT = Date.now();
  try {
    const j = await vPost('trace_attributes', {
      shape: state.hist.map(p => ({ lat: p[1], lon: p[0] })), costing: 'auto', shape_match: 'map_snap',
      filters: FILTERS });
    const e = j.edges && j.edges[j.edges.length - 1];
    state.limit = e && typeof e.speed_limit === 'number' ? e.speed_limit : null;
    setLimit(state.limit);
  } catch (e) { /* on garde la dernière valeur */ }
  finally { state.limBusy = false; }
}
function setLimit(v) {
  $('limit').hidden = !v;
  if (v) $('limitNum').textContent = v;
  document.body.classList.toggle('over', !!v && state.kmh > v + 1);
}

/* ---------- simulation ---------- */
function startSim() {
  if (simTimer) clearInterval(simTimer);
  let along = 0, seg = 0;
  simTimer = setInterval(() => {
    const r = state.route;
    if (!r) return;
    along += SIM_KMH / 3.6;
    seg = Math.min(seg, r.coords.length - 2);
    while (seg < r.coords.length - 2 && r.cum[seg + 1] < along) seg++;
    const a = r.coords[seg], b = r.coords[seg + 1];
    const len = r.cum[seg + 1] - r.cum[seg] || 1;
    const t = Math.max(0, Math.min(1, (along - r.cum[seg]) / len));
    onFix([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], SIM_KMH / 3.6, bearing(a, b));
  }, 1000);
}

/* ---------- recherche ---------- */
let qTimer;
$('q').addEventListener('input', () => {
  clearTimeout(qTimer);
  const v = $('q').value.trim();
  if (v.length < 3) { $('results').innerHTML = ''; return; }
  qTimer = setTimeout(() => geocode(v), 450);
});
/* Adresses françaises : Géoplateforme IGN (Base Adresse Nationale, très complète, y compris les lotissements récents)
   + Photon/OSM pour les lieux (commerces, monuments, étranger). On fusionne les deux. */
async function searchBan(v) {
  const u = new URL('https://data.geopf.fr/geocodage/search');
  u.searchParams.set('q', v); u.searchParams.set('limit', '5');
  if (state.pos) { u.searchParams.set('lon', state.pos[0]); u.searchParams.set('lat', state.pos[1]); }
  const j = await (await fetch(u)).json();
  return (j.features || []).map(f => {
    const p = f.properties;
    return { title: p.name || p.label, sub: [p.postcode, p.city].filter(Boolean).join(' '), coord: f.geometry.coordinates };
  });
}
async function searchPhoton(v) {
  const u = new URL('https://photon.komoot.io/api/');
  u.searchParams.set('q', v); u.searchParams.set('limit', '5'); u.searchParams.set('lang', 'fr');
  if (state.pos) { u.searchParams.set('lon', state.pos[0]); u.searchParams.set('lat', state.pos[1]); }
  const j = await (await fetch(u)).json();
  return (j.features || []).map(f => {
    const p = f.properties;
    const title = p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || 'Lieu';
    const sub = [p.housenumber && p.name ? p.housenumber : '', p.street, p.postcode, p.city, p.country]
      .filter(Boolean).filter(x => x !== title).join(', ');
    return { title, sub, coord: f.geometry.coordinates };
  });
}
let geoSeq = 0;
async function geocode(v) {
  const seq = ++geoSeq;
  const [a, b] = await Promise.allSettled([searchBan(v), searchPhoton(v)]);
  if (seq !== geoSeq) return;                       // une recherche plus récente a pris le relais
  const list = [...(a.status === 'fulfilled' ? a.value : [])];
  for (const r of (b.status === 'fulfilled' ? b.value : [])) {
    if (!list.some(x => dist(x.coord, r.coord) < 40)) list.push(r);     // dédoublonne (même endroit à 40 m près)
  }
  const ul = $('results'); ul.innerHTML = '';
  if (!list.length) { status(a.status === 'rejected' && b.status === 'rejected' ? 'Recherche indisponible' : 'Aucun résultat', 2500); return; }
  for (const r of list.slice(0, 7)) {
    const li = document.createElement('li');
    li.innerHTML = `${esc(r.title)}<small>${esc(r.sub)}</small>`;
    li.addEventListener('click', () => placeChosen({ name: r.title, coord: r.coord }));
    ul.appendChild(li);
  }
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- choix d'un point sur la carte (à l'arrêt seulement) ---------- */
let pickMarker = null;
function hidePick() { $('pick').hidden = true; if (pickMarker) { pickMarker.remove(); pickMarker = null; } state.pick = null; }
map.on('click', e => {
  if (state.kmh > 8) return;
  if (!$('panel').hidden) { $('panel').hidden = true; return; }          // un tap sur la carte referme le panneau
  if (map.getLayer('chargers') && map.queryRenderedFeatures(e.point, { layers: ['chargers'] }).length) return;   // géré par la fiche borne
  state.pick = { name: 'Point choisi', coord: [e.lngLat.lng, e.lngLat.lat] };
  if (pickMarker) pickMarker.remove();
  pickMarker = new maplibregl.Marker({ color: '#ef4444' }).setLngLat(e.lngLat).addTo(map);
  $('pick').hidden = false;
});
$('go').addEventListener('click', async () => {
  if (!state.pick) return;
  const d = { ...state.pick };
  if (state.assign) d.name = await reverseName(d.coord);   // donne un vrai nom au favori
  placeChosen(d);
});
$('cancelPick').addEventListener('click', hidePick);
$('stop').addEventListener('click', stopNav);

/* ---------- favoris (accès rapide) ----------
   Touche un favori vide pour l'enregistrer : cherche l'adresse (ou touche la carte) puis valide.
   Touche un favori rempli pour y aller ; appui long (0,7 s) pour le modifier. Stocké dans le navigateur. */
const FAV_SLOTS = [
  { id: 'home', icon: '🏠', label: 'Domicile' },
  { id: 'work', icon: '💼', label: 'Travail' },
  { id: 'fav', icon: '⭐', label: 'Favori' },
];
let favs = {};
try { favs = JSON.parse(localStorage.getItem('favs') || '{}') || {}; } catch (e) { favs = {}; }
function saveFavs() {
  try { localStorage.setItem('favs', JSON.stringify(favs)); }
  catch (e) { status('Stockage indisponible : favoris non conservés', 4000); }
}
const shorten = (s, n = 14) => s.length > n ? s.slice(0, n - 1) + '…' : s;

function renderFavs() {
  const box = $('favs');
  box.innerHTML = '';
  for (const s of FAV_SLOTS) {
    const f = favs[s.id];
    const b = document.createElement('button');
    b.className = (f ? '' : 'empty') + (state.assign === s.id ? ' assigning' : '');
    const label = s.id === 'fav' && f ? shorten(f.name) : s.label;
    b.innerHTML = `<span>${s.icon}</span>${f ? '' : '+ '}${esc(label)}`;
    let timer = null, long = false;
    b.addEventListener('pointerdown', () => {
      long = false; clearTimeout(timer);
      if (f) timer = setTimeout(() => { long = true; beginAssign(s.id); }, 700);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, () => clearTimeout(timer)));
    b.addEventListener('click', () => {
      if (long) { long = false; return; }
      if (state.assign === s.id) endAssign();
      else if (!f) beginAssign(s.id);
      else { endAssign(); startNav(f); }
    });
    box.appendChild(b);
  }
}
function refreshAssignUi() {
  const s = FAV_SLOTS.find(x => x.id === state.assign);
  $('q').placeholder = s ? `Adresse de « ${s.label} »…` : 'Où allez-vous ?';
  $('go').textContent = s ? 'Enregistrer' : 'Y aller';
  renderFavs();
}
function beginAssign(id) {
  state.assign = id; refreshAssignUi();
  const s = FAV_SLOTS.find(x => x.id === id);
  status(`Cherche l’adresse « ${s.label} » puis touche le résultat`, 3500);
  $('q').focus();
}
function endAssign() { state.assign = null; refreshAssignUi(); }
function placeChosen(dest) {
  if (!state.assign) { startNav(dest); return; }
  const s = FAV_SLOTS.find(x => x.id === state.assign);
  favs[s.id] = { name: dest.name || s.label, coord: dest.coord };
  saveFavs();
  $('results').innerHTML = ''; $('q').value = ''; $('q').blur(); hidePick();
  endAssign();
  status(`${s.icon} ${s.label} enregistré ✓`, 2500);
}
async function reverseName(c) {
  try {   // adresse officielle d'abord (Géoplateforme), puis OSM
    const j = await (await fetch(`https://data.geopf.fr/geocodage/reverse?lon=${c[0]}&lat=${c[1]}&limit=1`)).json();
    const p = j.features && j.features[0] && j.features[0].properties;
    if (p && (p.name || p.label)) return p.name || p.label;
  } catch (e) { /* on essaie Photon */ }
  try {
    const j = await (await fetch(`https://photon.komoot.io/reverse?lon=${c[0]}&lat=${c[1]}&lang=fr`)).json();
    const p = j.features && j.features[0] && j.features[0].properties;
    if (p) return p.name || [p.housenumber, p.street].filter(Boolean).join(' ') || p.city || 'Point choisi';
  } catch (e) { /* hors ligne */ }
  return 'Point choisi';
}
renderFavs();

/* ---------- météo en direct (Open-Meteo : gratuit, sans clé) ----------
   Pluie → gouttes qui se posent sur l'écran puis glissent ; neige → flocons ; brouillard/nuages → voile.
   Test : ?weather=drizzle|rain|heavy|storm|snow|fog|cloud|clear */
const WMO = {
  0: ['☀️', 'none', 0], 1: ['🌤️', 'none', 0], 2: ['⛅', 'cloud', 0], 3: ['☁️', 'cloud', 0], 45: ['🌫️', 'fog', 1], 48: ['🌫️', 'fog', 1],
  51: ['🌦️', 'rain', .2], 53: ['🌦️', 'rain', .35], 55: ['🌧️', 'rain', .5], 56: ['🌧️', 'rain', .35], 57: ['🌧️', 'rain', .5],
  61: ['🌧️', 'rain', .45], 63: ['🌧️', 'rain', .7], 65: ['🌧️', 'rain', 1], 66: ['🌧️', 'rain', .6], 67: ['🌧️', 'rain', .9],
  71: ['❄️', 'snow', .3], 73: ['❄️', 'snow', .6], 75: ['❄️', 'snow', 1], 77: ['❄️', 'snow', .3],
  80: ['🌦️', 'rain', .5], 81: ['🌧️', 'rain', .75], 82: ['🌧️', 'rain', 1], 85: ['❄️', 'snow', .5], 86: ['❄️', 'snow', .9],
  95: ['⛈️', 'rain', 1], 96: ['⛈️', 'rain', 1], 99: ['⛈️', 'rain', 1],
};
const WX = { kind: 'none', intensity: 0, lastFetch: 0, lastPos: null };
const WX_TEST = { clear: 0, cloud: 3, drizzle: 51, rain: 63, heavy: 65, storm: 95, snow: 73, fog: 45 };

function setWeather(code, isDay, temp) {
  const [icon, kind, intensity] = WMO[code] || ['☁️', 'cloud', 0];
  $('wIcon').textContent = (code <= 1 && !isDay) ? '🌙' : icon;
  $('wTemp').textContent = `${temp}°`;
  $('weather').hidden = false;
  WX.kind = kind; WX.intensity = intensity;
  for (const c of [...document.body.classList]) if (c.startsWith('wx-')) document.body.classList.remove(c);
  if (kind !== 'none') document.body.classList.add('wx-' + kind);
}
async function fetchWeather() {
  if (!state.pos) return;
  // position arrondie à ~1 km : suffisant pour la météo, et on n'envoie rien de plus précis
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${state.pos[1].toFixed(2)}&longitude=${state.pos[0].toFixed(2)}`
    + '&current=temperature_2m,weather_code,is_day&timezone=auto';
  try {
    const c = (await (await fetch(u)).json()).current;
    if (c) setWeather(c.weather_code, c.is_day === 1, Math.round(c.temperature_2m));
  } catch (e) { /* hors ligne : on garde l'affichage précédent */ }
}
function weatherTick() {
  if (P.has('weather') || !state.pos) return;
  const now = Date.now();
  if (now - WX.lastFetch > 600000 || (WX.lastPos && dist(WX.lastPos, state.pos) > 20000)) {
    WX.lastFetch = now; WX.lastPos = state.pos; fetchWeather();
  }
}
if (P.has('weather') && P.get('weather') in WX_TEST) setWeather(WX_TEST[P.get('weather')], true, 12);

/* Canvas : gouttes sur la vitre + neige */
const wxCv = $('wx'), wxCtx = wxCv.getContext('2d');
let wxDrops = [], wxFlakes = [], wxLast = 0;
function wxResize() {
  const d = Math.min(window.devicePixelRatio || 1, 1.5);
  wxCv.width = Math.round(innerWidth * d); wxCv.height = Math.round(innerHeight * d);
  wxCtx.setTransform(d, 0, 0, d, 0, 0);
}
window.addEventListener('resize', wxResize);
wxResize();

function newDrop(ts) {
  const r = 2.6 + Math.random() ** 2 * 6;
  return { x: Math.random() * innerWidth, y: Math.random() * innerHeight, r, rmax: r + Math.random() * 6, born: ts,
    life: 7 + Math.random() * 12, sliding: false, vy: 0, vmax: 60 + Math.random() * 120, trail: [], seed: Math.random() * 100 };
}
function drawDrop(d, a) {
  const { x, y, r } = d, rx = r * 0.92, ry = r * 1.08, c = wxCtx;
  c.save(); c.globalAlpha = a;
  if (d.trail.length > 1) {                                   // sillage humide
    c.beginPath(); c.moveTo(d.trail[0][0], d.trail[0][1]);
    for (const t of d.trail) c.lineTo(t[0], t[1]);
    c.lineTo(x, y); c.lineWidth = r * 0.7; c.lineCap = 'round'; c.strokeStyle = 'rgba(255,255,255,.11)'; c.stroke();
  }
  // ombre portée : fait "décoller" la goutte du fond, même sur une carte claire
  c.shadowColor = 'rgba(10,30,70,.38)'; c.shadowBlur = 3 + r * .5; c.shadowOffsetY = 1 + r * .18;
  const g = c.createRadialGradient(x - rx * .3, y - ry * .35, rx * .1, x, y, ry * 1.1);
  g.addColorStop(0, 'rgba(255,255,255,.28)'); g.addColorStop(.6, 'rgba(140,175,220,.20)'); g.addColorStop(1, 'rgba(60,100,160,.34)');
  c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, 6.283); c.fillStyle = g; c.fill();
  c.shadowColor = 'transparent';
  c.lineWidth = 1.2; c.strokeStyle = 'rgba(255,255,255,.7)'; c.stroke();
  c.beginPath(); c.ellipse(x + rx * .08, y + ry * .12, rx * .82, ry * .82, 0, 0.1, 1.9);   // bord sombre côté bas (réfraction)
  c.strokeStyle = 'rgba(0,25,60,.42)'; c.lineWidth = Math.max(1.2, r * .26); c.lineCap = 'round'; c.stroke();
  c.beginPath(); c.ellipse(x - rx * .38, y - ry * .42, Math.max(.9, r * .24), Math.max(.7, r * .17), -.6, 0, 6.283);   // reflet
  c.fillStyle = 'rgba(255,255,255,.95)'; c.fill();
  c.restore();
}
function stepRain(dt, ts) {
  const target = WX.kind === 'rain' ? Math.round(8 + WX.intensity * 70) : 0;
  if (wxDrops.length < target) {
    const n = Math.min(3, Math.ceil((target - wxDrops.length) * dt * 0.8));
    for (let i = 0; i < n; i++) wxDrops.push(newDrop(ts));
  }
  for (let i = wxDrops.length - 1; i >= 0; i--) {
    const d = wxDrops[i], age = (ts - d.born) / 1000;
    if (WX.kind !== 'rain') d.life = Math.min(d.life, age + 1.5);          // la pluie s'arrête : tout s'efface
    const ttl = d.life - age;
    if (ttl <= 0 || d.y > innerHeight + 20) { wxDrops.splice(i, 1); continue; }
    let a = Math.min(1, age / 0.4);
    if (ttl < 1.5) a = Math.min(a, ttl / 1.5);
    if (!d.sliding) {
      d.r = Math.min(d.rmax, d.r + dt * 0.15);                              // la goutte grossit en recueillant l'eau
      if (d.r >= 6 && Math.random() < dt * 0.35 * (WX.intensity + 0.3)) { d.sliding = true; d.vy = 20; }
    } else {
      d.vy = Math.min(d.vmax, d.vy + dt * 90);
      d.trail.push([d.x, d.y]); if (d.trail.length > 30) d.trail.shift();
      d.y += d.vy * dt; d.x += Math.sin(ts / 400 + d.seed) * 0.15;
      d.r = Math.max(2.2, d.r - dt * 0.5);
      if (d.r <= 2.3 && Math.random() < dt * 2) { d.sliding = false; d.vy = 0; }
    }
    drawDrop(d, a);
  }
}
function stepSnow(dt, ts) {
  const target = WX.kind === 'snow' ? Math.round(40 + WX.intensity * 160) : 0;
  const W = innerWidth, H = innerHeight;
  if (WX.kind === 'snow' && wxFlakes.length === 0) {
    for (let i = 0; i < target; i++) wxFlakes.push({ x: Math.random() * W, y: Math.random() * H, r: 1.2 + Math.random() * 2.8, vy: 25 + Math.random() * 50, ph: Math.random() * 6.28, sw: 10 + Math.random() * 25 });
  }
  if (wxFlakes.length < target) {
    const n = Math.min(4, Math.ceil((target - wxFlakes.length) * dt * 0.5));
    for (let i = 0; i < n; i++) wxFlakes.push({ x: Math.random() * W, y: -6, r: 1.2 + Math.random() * 2.8, vy: 25 + Math.random() * 50, ph: Math.random() * 6.28, sw: 10 + Math.random() * 25 });
  }
  wxCtx.fillStyle = 'rgba(255,255,255,.88)';
  for (let i = wxFlakes.length - 1; i >= 0; i--) {
    const f = wxFlakes[i];
    f.y += f.vy * dt; f.x += Math.sin(ts / 1000 + f.ph) * f.sw * dt;
    if (f.y > H + 6) { if (WX.kind === 'snow') { f.y = -6; f.x = Math.random() * W; } else wxFlakes.splice(i, 1); continue; }
    wxCtx.beginPath(); wxCtx.arc(f.x, f.y, f.r, 0, 6.283); wxCtx.fill();
  }
}
function wxLoop(ts) {
  requestAnimationFrame(wxLoop);
  const dt = Math.min(0.05, (ts - (wxLast || ts)) / 1000);
  wxLast = ts;
  const active = WX.kind === 'rain' || WX.kind === 'snow' || wxDrops.length || wxFlakes.length;
  if (!active) return;
  wxCtx.clearRect(0, 0, innerWidth, innerHeight);
  if (WX.kind === 'rain' || wxDrops.length) stepRain(dt, ts);
  if (WX.kind === 'snow' || wxFlakes.length) stepSnow(dt, ts);
}
requestAnimationFrame(wxLoop);

/* ---------- bornes de recharge ----------
   Source : registre national officiel des IRVE (data.gouv.fr, via ODRÉ / Opendatasoft), gratuit et sans clé.
   Chargé par "dalles" de 0,1° autour de la voiture, devant elle et le long de l'itinéraire. France uniquement. */
const ODRE = 'https://odre.opendatasoft.com/api/explore/v2.1/catalog/datasets/bornes-irve/records';
const TILE = 0.1;
const CH = { on: prefs.ch !== false, tiles: new Map(), feats: new Map(), running: 0 };
const CH_COLORS = { tesla: '#e31937', ultra: '#8b5cf6', fast: '#10b981', mid: '#3b82f6', slow: '#94a3b8' };
const truthy = v => String(v).toLowerCase() === 'true';

function chargerCat(op, kw) {
  if (/tesla/i.test(op || '')) return 'tesla';
  return kw >= 150 ? 'ultra' : kw >= 50 ? 'fast' : kw >= 22 ? 'mid' : 'slow';
}
async function fetchChargerTile(i, j) {
  const key = i + ',' + j;
  CH.tiles.set(key, { st: 'loading' });
  try {
    const rows = [];
    for (let off = 0; off < 3000; off += 100) {
      const u = new URL(ODRE);
      u.searchParams.set('select', 'id_station_itinerance as id, nom_station as name, nom_operateur as op, consolidated_latitude as lat, '
        + 'consolidated_longitude as lon, prise_type_combo_ccs as ccs, prise_type_2 as t2, prise_type_chademo as chd, '
        + 'max(puissance_nominale) as kw, count(*) as n');
      const f = x => (x * TILE).toFixed(4);
      u.searchParams.set('where', `consolidated_latitude>=${f(j)} and consolidated_latitude<${f(j + 1)} `
        + `and consolidated_longitude>=${f(i)} and consolidated_longitude<${f(i + 1)}`);
      u.searchParams.set('group_by', 'id_station_itinerance,nom_station,nom_operateur,consolidated_latitude,consolidated_longitude,'
        + 'prise_type_combo_ccs,prise_type_2,prise_type_chademo');
      u.searchParams.set('limit', '100'); u.searchParams.set('offset', String(off));
      const r = await fetch(u);
      if (!r.ok) throw new Error('IRVE ' + r.status);
      const jn = await r.json();
      rows.push(...(jn.results || []));
      if ((jn.results || []).length < 100) break;
    }
    const by = new Map();   // une borne = une station : on fusionne les lignes par type de prise
    for (const x of rows) {
      if (x.lat == null || x.lon == null) continue;
      const s = by.get(x.id) || { id: x.id, name: x.name, op: x.op, lat: x.lat, lon: x.lon, kw: 0, n: 0, ccs: false, t2: false, chd: false };
      s.kw = Math.max(s.kw, Number(x.kw) || 0); s.n += x.n || 0;
      s.ccs = s.ccs || truthy(x.ccs); s.t2 = s.t2 || truthy(x.t2); s.chd = s.chd || truthy(x.chd);
      by.set(x.id, s);
    }
    for (const s of by.values()) {
      CH.feats.set(s.id, { type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: {
        id: s.id, name: s.name, op: s.op, kw: s.kw, n: s.n, ccs: s.ccs, t2: s.t2, chd: s.chd,
        cat: chargerCat(s.op + ' ' + s.name, s.kw), lbl: s.kw >= 7 ? String(Math.round(s.kw)) : '' } });
    }
    CH.tiles.set(key, { st: 'done' });
    const src = map.getSource('chargers');
    if (src) src.setData({ type: 'FeatureCollection', features: [...CH.feats.values()] });
  } catch (e) {
    CH.tiles.set(key, { st: 'error', t: Date.now() });     // on réessaiera dans une minute
  }
}
function wantTiles() {
  const out = [], seen = new Set();
  const add = (lon, lat, spread) => {
    const ci = Math.floor(lon / TILE), cj = Math.floor(lat / TILE);
    for (let di = -spread; di <= spread; di++) for (let dj = -spread; dj <= spread; dj++) {
      const k = (ci + di) + ',' + (cj + dj);
      if (!seen.has(k)) { seen.add(k); out.push([ci + di, cj + dj, Math.abs(di) + Math.abs(dj)]); }
    }
  };
  const c = map.getCenter();
  add(c.lng, c.lat, 1);                                                    // autour de la vue
  if (state.pos && state.kmh > 20) { const a = moveAlong(state.pos, state.heading, 8000); add(a[0], a[1], 0); }   // devant
  const r = state.route;
  if (r && state.alongFix != null) for (const km of [4000, 9000, 16000]) {                                       // le long du trajet
    if (state.alongFix + km < r.total) { const p = pointAtAlong(r, state.alongFix + km).pos; add(p[0], p[1], 0); }
  }
  return out;
}
function ensureChargers() {
  if (!CH.on || !map.getSource('chargers') || map.getZoom() < 10.5) return;
  for (const [i, j] of wantTiles()) {
    if (CH.running >= 2) break;
    const t = CH.tiles.get(i + ',' + j);
    if (t && (t.st !== 'error' || Date.now() - t.t < 60000)) continue;
    CH.running++;
    fetchChargerTile(i, j).finally(() => { CH.running--; });
  }
}
setInterval(ensureChargers, 2000);
map.on('moveend', ensureChargers);

function boltIcon(color) {
  const s = 72, c = document.createElement('canvas');
  c.width = c.height = s;
  const x = c.getContext('2d');
  x.shadowColor = 'rgba(0,0,0,.35)'; x.shadowBlur = 6; x.shadowOffsetY = 2;
  x.fillStyle = '#fff'; x.beginPath(); x.arc(s / 2, s / 2, 28, 0, 6.283); x.fill();
  x.shadowColor = 'transparent';
  x.fillStyle = color; x.beginPath(); x.arc(s / 2, s / 2, 23, 0, 6.283); x.fill();
  x.fillStyle = '#fff'; x.beginPath();
  x.moveTo(40, 12); x.lineTo(22, 40); x.lineTo(34, 40); x.lineTo(30, 60); x.lineTo(50, 30); x.lineTo(38, 30); x.closePath(); x.fill();
  return x.getImageData(0, 0, s, s);
}
function initOverlays() {
  if (!map.getLayer('highway-name-major') || map.getSource('chargers')) return;   // style réel pas encore là / déjà fait
  for (const [cat, col] of Object.entries(CH_COLORS)) if (!map.hasImage('ch-' + cat)) map.addImage('ch-' + cat, boltIcon(col), { pixelRatio: 2 });
  map.addSource('chargers', { type: 'geojson', data: { type: 'FeatureCollection', features: [...CH.feats.values()] } });
  const font = map.getLayoutProperty('highway-name-major', 'text-font') || ['Noto Sans Regular'];
  map.addLayer({ id: 'chargers', type: 'symbol', source: 'chargers', minzoom: 10.5,
    layout: {
      visibility: CH.on ? 'visible' : 'none',
      'icon-image': ['concat', 'ch-', ['get', 'cat']],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 10.5, 0.5, 14, 0.78, 17, 1.1],
      'icon-padding': 3, 'symbol-sort-key': ['-', 0, ['get', 'kw']],
      'text-field': ['step', ['zoom'], '', 14.2, ['get', 'lbl']], 'text-font': font, 'text-size': 13,
      'text-offset': [0, 1.45], 'text-anchor': 'top', 'text-optional': true,
    },
    paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(15,23,42,.9)', 'text-halo-width': 1.6 } },
    map.getLayer('route-casing') ? 'route-casing' : undefined);
  map.on('click', 'chargers', e => {
    if (state.kmh > 8 || !e.features.length) return;
    showStation(e.features[0].properties, e.features[0].geometry.coordinates.slice());
  });
  map.on('mouseenter', 'chargers', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'chargers', () => { map.getCanvas().style.cursor = ''; });
  if (prefs.sat) applySat(true);
  ensureChargers();
}
map.on('style.load', initOverlays);

let stationDest = null;
function showStation(p, coord) {
  hidePick();
  const isId = /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(p.name || '');   // certains noms sont des identifiants techniques (UUID)
  const name = !p.name || isId ? (p.op || 'Borne de recharge') : p.name;
  const plugs = [p.ccs === true || p.ccs === 'true' ? 'CCS' : '', p.t2 === true || p.t2 === 'true' ? 'Type 2' : '', p.chd === true || p.chd === 'true' ? 'CHAdeMO' : ''].filter(Boolean).join(' · ');
  $('stName').textContent = name;
  $('stDetail').textContent = [p.op && p.op !== name ? p.op : '', p.kw ? `${Math.round(p.kw)} kW max` : '', p.n ? `${p.n} prise${p.n > 1 ? 's' : ''}` : '', plugs].filter(Boolean).join(' · ');
  stationDest = { name, coord };
  $('station').hidden = false;
}
$('stGo').addEventListener('click', () => { $('station').hidden = true; if (stationDest) startNav(stationDest); });
$('stClose').addEventListener('click', () => { $('station').hidden = true; });

/* ---------- vue satellite (imagerie Esri World Imagery, sans clé) ---------- */
const SAT = { on: false, orig: new Map() };
function applySat(on) {
  SAT.on = on;
  const st = map.getStyle();
  if (!st || !st.layers.length) return;
  if (on && !map.getSource('sat')) {
    map.addSource('sat', { type: 'raster', tileSize: 256, maxzoom: 19,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      attribution: 'Imagerie © Esri, Maxar, Earthstar Geographics' });
    const first = st.layers.find(l => l.type !== 'background');
    map.addLayer({ id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-fade-duration': 150 } }, first && first.id);
  }
  if (map.getLayer('sat')) map.setLayoutProperty('sat', 'visibility', on ? 'visible' : 'none');
  const SKIP = id => id === 'sat' || id.startsWith('route-') || id === 'chargers';
  for (const l of map.getStyle().layers) {
    if (SKIP(l.id)) continue;
    if (l.type === 'fill' || l.type === 'fill-extrusion') {            // eau, parcs, bâtiments : l'imagerie les montre déjà
      map.setLayoutProperty(l.id, 'visibility', on ? 'none' : (HIDE.has(l.id) ? 'none' : 'visible'));
    } else if (l.type === 'line' && /^(tunnel|road|bridge)_/.test(l.id) && !/rail/.test(l.id)) {
      if (!SAT.orig.has(l.id)) SAT.orig.set(l.id, map.getPaintProperty(l.id, 'line-opacity'));
      if (/casing/.test(l.id)) map.setLayoutProperty(l.id, 'visibility', on ? 'none' : 'visible');
      else if (on) {
        map.setPaintProperty(l.id, 'line-color', '#ffffff');
        map.setPaintProperty(l.id, 'line-opacity', /motorway|trunk_primary/.test(l.id) ? 0.9 : 0.55);
      } else map.setPaintProperty(l.id, 'line-opacity', SAT.orig.get(l.id) === undefined ? 1 : SAT.orig.get(l.id));
    } else if (l.type === 'symbol' && on) {
      map.setPaintProperty(l.id, 'text-color', '#ffffff');
      map.setPaintProperty(l.id, 'text-halo-color', 'rgba(0,0,0,.72)');
    }
  }
  if (!on) applyTheme(document.body.classList.contains('night'));        // restaure routes et textes du thème
  else {
    document.getElementById('map').style.background = '#0e131c';
    document.documentElement.style.setProperty('--sky', '#0e131c');
  }
}

/* ---------- panneau calques / voix ---------- */
function setSw(id, on) { $(id).setAttribute('aria-checked', on ? 'true' : 'false'); }
function refreshVoiceName() {
  const v = currentSysVoice();
  $('voiceName').textContent = v ? v.name.replace(/^Microsoft |^Google /, '') : 'voix par défaut';
}
$('layersBtn').addEventListener('click', e => { e.stopPropagation(); $('panel').hidden = !$('panel').hidden; refreshVoiceName(); });
function toggleSat() {                       // utilisé par l'interrupteur du panneau ET par le bouton de la barre d'outils
  const on = !prefs.sat;
  prefs.sat = on; savePrefs(); applySat(on);
  setSw('swSat', on); $('satBtn').classList.toggle('on', on);
  status(on ? 'Vue satellite' : 'Vue carte', 1200);
}
$('swSat').addEventListener('click', toggleSat);
$('satBtn').addEventListener('click', toggleSat);
$('swCh').addEventListener('click', () => {
  CH.on = $('swCh').getAttribute('aria-checked') !== 'true';
  setSw('swCh', CH.on); prefs.ch = CH.on; savePrefs();
  if (map.getLayer('chargers')) map.setLayoutProperty('chargers', 'visibility', CH.on ? 'visible' : 'none');
  if (CH.on) ensureChargers(); else $('station').hidden = true;
});
$('swHd').addEventListener('click', () => {
  const on = $('swHd').getAttribute('aria-checked') !== 'true';
  setSw('swHd', on); prefs.hd = on; savePrefs();
  VOICE.mode = on ? 'hd' : 'system';
  if (on) loadHd().then(() => { if (VOICE.hd) speak(['Dans 300 mètres,', 'tournez à droite sur la rue des Lilas.']); });
  else setHdStatus('Neuronale, hors ligne après 1er chargement');
});
$('voiceNext').addEventListener('click', () => {
  const list = frVoices();
  if (!list.length) { status('Aucune voix française sur cet appareil', 3000); return; }
  const i = list.findIndex(v => v.name === (currentSysVoice() || {}).name);
  prefs.sysVoice = list[(i + 1) % list.length].name; savePrefs();
  refreshVoiceName(); speakSystem(['Dans 300 mètres,', 'tournez à droite.']);
});
$('voiceTest').addEventListener('click', () => speak(['Dans 300 mètres,', 'tournez à droite sur la rue des Lilas.']));
try { speechSynthesis.addEventListener('voiceschanged', refreshVoiceName); } catch (e) { /* ignoré */ }
setSw('swSat', !!prefs.sat); $('satBtn').classList.toggle('on', !!prefs.sat); setSw('swCh', CH.on); setSw('swHd', !!prefs.hd);
refreshVoiceName();
if (prefs.hd) loadHd();

/* ---------- zoom manuel + zoom auto ---------- */
function saveZoomPrefs() {
  try {
    localStorage.setItem('zoomOffset', String(state.zoomOffset));
    localStorage.setItem('autoZoom', state.autoZoom ? '1' : '0');
  } catch (e) { /* ignoré */ }
}
function changeZoom(delta) {
  state.zoomOffset = Math.max(-3, Math.min(3, Math.round((state.zoomOffset + delta) * 2) / 2));
  saveZoomPrefs();
  status(`Zoom ${state.zoomOffset > 0 ? '+' : ''}${state.zoomOffset}`, 1200);
  state.hold = 0;
}
function refreshAutoBtn() {
  $('autoZoom').classList.toggle('on', state.autoZoom);
  $('autoZoom').title = state.autoZoom ? 'Zoom auto aux intersections : activé' : 'Zoom auto aux intersections : désactivé';
}
$('zoomIn').addEventListener('click', () => changeZoom(0.5));
$('zoomOut').addEventListener('click', () => changeZoom(-0.5));
$('autoZoom').addEventListener('click', () => {
  state.autoZoom = !state.autoZoom; saveZoomPrefs(); refreshAutoBtn();
  status(state.autoZoom ? 'Zoom auto : activé' : 'Zoom auto : désactivé', 1500);
});
refreshAutoBtn();

/* ---------- jour / nuit automatique ----------
   Calculé à partir de la position du soleil (latitude, longitude, heure) : aucun réseau ni réglage.
   Bascule en nuit juste après le coucher du soleil et revient en jour peu après le lever (avec hystérésis,
   pour éviter les allers-retours). Test : ?theme=night ou ?theme=day force le thème. */
function sunElevation(lat, lon, date) {          // hauteur du soleil au-dessus de l'horizon, en degrés
  const rad = Math.PI / 180;
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;      // jours depuis J2000
  const g = (357.529 + 0.98560028 * d) % 360;
  const q = (280.459 + 0.98564736 * d) % 360;
  const L = (q + 1.915 * Math.sin(g * rad) + 0.020 * Math.sin(2 * g * rad)) % 360;
  const e = 23.439 - 0.00000036 * d;
  const ra = Math.atan2(Math.cos(e * rad) * Math.sin(L * rad), Math.cos(L * rad));
  const dec = Math.asin(Math.sin(e * rad) * Math.sin(L * rad));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const H = (((gmst * 15 + lon) % 360) * rad) - ra;
  return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(H)) / rad;
}
let isNight = null;
function wantNight() {
  const forced = P.get('theme');
  if (forced === 'night' || forced === 'day') return forced === 'night';
  let pos = state.pos;
  if (!pos) { const c = map.getCenter(); pos = [c.lng, c.lat]; }
  const el = sunElevation(pos[1], pos[0], new Date());
  if (isNight === null) return el < -1;
  return isNight ? el < 1 : el < -1;                // hystérésis : nuit sous -1°, jour au-dessus de +1°
}
function applyNight() {
  const on = wantNight();
  if (on === isNight) return;
  isNight = on;
  document.body.classList.toggle('night', on);
  applyTheme(on);
  if (SAT.on) applySat(true);      // le satellite garde ses couleurs de routes et de textes
}

/* ---------- voix : couper / rétablir ---------- */
function refreshMute() {
  $('mute').textContent = state.muted ? '🔇' : '🔊';
  $('mute').classList.toggle('off', state.muted);
  $('mute').title = state.muted ? 'Voix coupée' : 'Voix activée';
  $('menuBtn').classList.toggle('dot', !!state.muted);   // pastille rouge sur ☰ : la voix est coupée
}
$('mute').addEventListener('click', () => {
  state.muted = !state.muted;
  try { localStorage.setItem('muted', state.muted ? '1' : '0'); } catch (e) { /* ignoré */ }
  if (state.muted) stopSpeech();
  refreshMute();
  status(state.muted ? 'Voix coupée' : 'Voix activée', 1500);
});
refreshMute();
applyNight();
setInterval(applyNight, 60000);

/* ---------- menu repliable (bouton ☰) ----------
   Au repos, seul le bouton ☰ est visible. Il déploie la barre d'outils, qui se replie seule après 7 s. */
let menuTimer = null;
function setMenu(open) {
  $('toolbar').classList.toggle('collapsed', !open);
  $('menuBtn').textContent = open ? '✕' : '☰';
  clearTimeout(menuTimer);
  if (open) menuTimer = setTimeout(() => { if ($('panel').hidden) setMenu(false); else menuTimer = setTimeout(() => setMenu(false), 7000); }, 7000);
}
$('menuBtn').addEventListener('click', () => setMenu($('toolbar').classList.contains('collapsed')));
$('tools').addEventListener('click', () => { if (!$('toolbar').classList.contains('collapsed')) setMenu(true); });   // chaque action relance le délai
setMenu(false);

/* ---------- démarrage ---------- */
try { navigator.wakeLock && navigator.wakeLock.request('screen').catch(() => {}); } catch (e) { /* ignoré */ }
requestAnimationFrame(frame);
startGPS();
