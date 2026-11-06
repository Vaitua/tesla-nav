'use strict';
(function () {
/* NAVIA — panneau « Trajet » : comparateur d'itinéraires, énergie (VE), simulateur de vitesse, météo sur le trajet, copilote.
   S'appuie sur app.js (carte, état, routage Valhalla) et ev.js (modèle énergétique). 100 % gratuit, sans clé :
   Valhalla (OSM) · Open-Meteo (météo + altitudes) · IRVE/ODRÉ (bornes, déjà chargées par app.js) · Overpass (restaurants, à la demande).
   Rien n'est simulé : tant qu'une donnée n'est pas arrivée (relief, météo), l'écran l'indique. */

Object.assign(G, {
  route: '<circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M8.5 18H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.5"/>',
  battery: '<rect x="2.5" y="7" width="17" height="10" rx="2.5"/><path d="M22 10.5v3M7 10v4M11 10v4"/>',
  spark: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM18.5 16.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
  send: '<path d="M4 12 20 4l-5 16-3.5-6.5z"/>',
});
fillIcons();

const NV = {
  routes: [], sel: 0, along: 0, tab: 'routes', open: false,
  cache: new Map(),      // trip → { profile, limits, elev, wx, res }
  ev: Object.assign({ soc: 80, cap: 75, reserve: 10, cruise: 120, calib: 1 }, JSON.parse(localStorage.getItem('navia.ev') || '{}')),
  markers: [], log: [], selecting: false,
};
const NV_COLORS = ['#2563ff', '#06b6d4', '#f59e0b', '#a78bfa'];
const saveEv = () => { try { localStorage.setItem('navia.ev', JSON.stringify(NV.ev)); } catch (e) { /* ignoré */ } };
const fmtKm = km => `${km < 10 ? km.toFixed(1).replace('.', ',') : Math.round(km)} km`;
const clock = ms => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const evParams = () => ({ cap: NV.ev.cap, soc: NV.ev.soc, reserve: NV.ev.reserve, calib: NV.ev.calib });

/* ---------- géométrie d'un itinéraire ---------- */
function mkRoute(trip) {
  const leg = trip.legs[0], coords = decodePoly(leg.shape), cum = [0];
  for (let i = 1; i < coords.length; i++) cum[i] = cum[i - 1] + dist(coords[i - 1], coords[i]);
  return { trip, shape: leg.shape, coords, cum, total: cum[cum.length - 1] || 1, time: trip.summary.time, man: leg.maneuvers };
}
function entry(trip) {
  let e = NV.cache.get(trip);
  if (!e) { e = { r: mkRoute(trip), ready: false, limits: null, elev: null, wx: null, res: {}, busy: null }; NV.cache.set(trip, e); }
  return e;
}

/* ---------- données gratuites : limites OSM (Valhalla), altitudes + météo (Open-Meteo) ---------- */
async function getLimits(e) {
  if (e.limits !== null) return e.limits;
  e.limits = false;
  for (const mode of ['edge_walk', 'map_snap']) {
    try {
      const j = await vPost('trace_attributes', { encoded_polyline: e.r.shape, costing: 'auto', shape_match: mode, filters: FILTERS });
      if (j && j.edges && j.edges.length) {
        let acc = 0;
        const segs = j.edges.map(x => { const len = (x.length || 0) * 1000, s = { from: acc, to: acc + len, v: typeof x.speed_limit === 'number' ? x.speed_limit : null }; acc += len; return s; });
        const k = acc ? e.r.total / acc : 1;
        segs.forEach(s => { s.from *= k; s.to *= k; });
        e.limits = segs; break;
      }
    } catch (err) { /* on essaie l'autre mode */ }
  }
  return e.limits;
}
const limitMid = (segs, a) => {
  if (!segs) return null;
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m].from <= a) lo = m; else hi = m - 1; }
  return segs[lo].v;
};
async function getElev(e, pts) {
  if (e.elev !== null) return e.elev;
  e.elev = false;
  try {
    const u = `https://api.open-meteo.com/v1/elevation?latitude=${pts.map(p => p[1].toFixed(4)).join(',')}&longitude=${pts.map(p => p[0].toFixed(4)).join(',')}`;
    const j = await (await fetch(u)).json();
    if (Array.isArray(j.elevation) && j.elevation.length === pts.length) {
      const z = j.elevation, sm = z.map((v, i) => (z[Math.max(0, i - 1)] + v + z[Math.min(z.length - 1, i + 1)]) / 3);   // lissage : le MNT est bruité
      e.elev = sm;
    }
  } catch (err) { /* hors ligne : relief ignoré */ }
  return e.elev;
}
const WX_N = 6;
async function getWx(e) {
  if (e.wx !== null) return e.wx;
  e.wx = false;
  try {
    const pts = Array.from({ length: WX_N }, (_, i) => pointAtAlong(e.r, e.r.total * i / (WX_N - 1)).pos);
    const u = 'https://api.open-meteo.com/v1/forecast?latitude=' + pts.map(p => p[1].toFixed(2)).join(',') + '&longitude=' + pts.map(p => p[0].toFixed(2)).join(',')
      + '&hourly=temperature_2m,precipitation,snowfall,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m&wind_speed_unit=ms&timeformat=unixtime&forecast_days=3';
    let j = await (await fetch(u)).json();
    if (!Array.isArray(j)) j = [j];
    if (j.length === WX_N && j[0].hourly) {
      e.wx = pts.map((pos, i) => ({ pos, frac: i / (WX_N - 1), h: j[i].hourly, t0: Date.now() }));
    }
  } catch (err) { /* météo indisponible : conditions neutres (15 °C, pas de vent) */ }
  return e.wx;
}
function wxAt(w, etaMs) {
  const t = w.h.time, target = etaMs / 1000;
  let k = 0;
  for (let i = 0; i < t.length; i++) if (Math.abs(t[i] - target) < Math.abs(t[k] - target)) k = i;
  const h = w.h;
  return { T: h.temperature_2m[k], precip: h.precipitation[k], snow: h.snowfall[k], code: h.weather_code[k],
    wind: h.wind_speed_10m[k], gust: h.wind_gusts_10m[k], dir: h.wind_direction_10m[k], at: t[k] * 1000 };
}

/* ---------- construction du profil (tronçons) à partir des données disponibles ---------- */
async function ensureData(e) {
  if (e.busy) return e.busy;
  e.busy = (async () => {
    const n = Math.max(12, Math.min(99, Math.ceil(e.r.total / 1500)));
    const pts = Array.from({ length: n + 1 }, (_, i) => pointAtAlong(e.r, e.r.total * i / n).pos);
    await Promise.all([getLimits(e), getElev(e, pts), getWx(e)]);
    e.n = n; e.pts = pts; e.res = {}; e.ready = true;
  })();
  try { await e.busy; } finally { e.busy = null; }
  return e;
}
function profileOf(e, withWx, withRelief) {
  const n = e.n || 24;
  const prof = [], len = e.r.total / n, avgKmh = (e.r.total / 1000) / (e.r.time / 3600);
  for (let i = 0; i < n; i++) {
    const a = len * (i + 0.5), p = pointAtAlong(e.r, a);
    const s = { len, limit: limitMid(e.limits, a), brg: p.brg, dh: withRelief && e.elev ? e.elev[i + 1] - e.elev[i] : 0, T: 15, wind: 0, windDir: 0 };
    if (withWx && e.wx) {
      let w = e.wx[0];
      for (const q of e.wx) if (Math.abs(q.frac - a / e.r.total) < Math.abs(w.frac - a / e.r.total)) w = q;
      const eta = w.t0 + e.r.time * 1000 * (a / e.r.total), c = wxAt(w, eta);
      s.T = c.T; s.wind = c.wind; s.windDir = c.dir;
    }
    prof.push(s);
  }
  return { prof, avgKmh };
}
function simRoute(e, cruise, o) {
  o = o || {};
  const withWx = o.wx !== false, withRelief = o.relief !== false;
  const { prof, avgKmh } = profileOf(e, withWx, withRelief);
  return EVM.simulate(prof, { cruise, avgKmh, baseTimeS: e.r.time, params: Object.assign(evParams(), o.params || {}) });
}
const resFor = (e, cruise) => e.res[cruise + '|' + NV.ev.soc + '|' + NV.ev.cap + '|' + NV.ev.reserve + '|' + NV.ev.calib]
  || (e.res[cruise + '|' + NV.ev.soc + '|' + NV.ev.cap + '|' + NV.ev.reserve + '|' + NV.ev.calib] = simRoute(e, cruise));

/* ---------- cartographie : itinéraires alternatifs + marqueurs ---------- */
function ensureMapLayers() {
  if (!map.isStyleLoaded() || map.getSource('nv-alts')) return;
  map.addSource('nv-alts', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'nv-alts', type: 'line', source: 'nv-alts', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'c'], 'line-width': 7, 'line-opacity': 0.75 } }, map.getLayer('route-casing') ? 'route-casing' : undefined);
}
function drawAlts() {
  ensureMapLayers();
  const src = map.getSource('nv-alts');
  if (!src) return;
  src.setData({ type: 'FeatureCollection', features: NV.routes.map((t, i) => i === NV.sel ? null : ({ type: 'Feature', properties: { c: NV_COLORS[i % 4] },
    geometry: { type: 'LineString', coordinates: entry(t).r.coords } })).filter(Boolean) });
}
function clearMarkers() { NV.markers.forEach(m => m.remove()); NV.markers = []; }
function addMarker(pos, html, cls) {
  const el = document.createElement('div'); el.className = 'nvm ' + (cls || ''); el.innerHTML = html;
  NV.markers.push(new maplibregl.Marker({ element: el }).setLngLat(pos).addTo(map));
}
function drawStopMarkers(e, res) {
  clearMarkers();
  if (!res) return;
  for (const s of res.stops) addMarker(pointAtAlong(e.r, s.atKm * 1000).pos, ic('zap') + `<b>${Math.round(s.atKm)} km</b>`, 'stop');
  if (e.wx) for (const w of e.wx.slice(1, -1)) { const c = wxAt(w, w.t0 + e.r.time * 1000 * w.frac); addMarker(w.pos, ic((WMO[c.code] || ['w_cloud'])[0]) + `<b>${Math.round(c.T)}°</b>`, 'wxm'); }
}

/* ---------- hooks appelés par app.js ---------- */
window.naviaRoute = function (trip) {
  const alts = fetchTrip.alts || [];
  if (!NV.selecting) { NV.routes = [trip, ...alts.slice(0, 2)]; NV.sel = 0; }
  else NV.sel = Math.max(0, NV.routes.indexOf(trip));
  fetchTrip.alts = [];
  drawAlts(); clearMarkers();
  const e = entry(trip);
  $('tripBat').hidden = true;
  ensureData(e).then(() => { if (NV.routes[NV.sel] === trip) { updateTripBat(); if (NV.open) render(); } });
};
window.naviaTick = function (along, remS) {
  NV.along = along;
  const r = state.route;
  $('progBar').style.width = Math.min(100, (along / r.total) * 100).toFixed(1) + '%';
};
window.naviaStop = function () {
  NV.routes = []; NV.sel = 0; NV.cache = new Map(); clearMarkers();
  const s = map.getSource('nv-alts'); if (s) s.setData({ type: 'FeatureCollection', features: [] });
  $('progBar').style.width = '0'; $('tripBat').hidden = true;
  if (NV.open) render();
};
function updateTripBat() {
  const t = NV.routes[NV.sel]; if (!t) return;
  const res = resFor(entry(t), NV.ev.cruise);
  $('batEnd').textContent = '≈' + Math.max(0, Math.round(res.socEnd)) + ' %';
  $('tripBat').hidden = false;
}
map.on('style.load', () => { ensureMapLayers(); drawAlts(); });

/* ---------- interface ---------- */
const root = document.createElement('div');
root.id = 'navia'; root.hidden = true;
document.body.appendChild(root);
const TABS = [['routes', 'route', 'Itinéraires'], ['ev', 'battery', 'Énergie'], ['speed', 'gauge', 'Vitesse'], ['wx', 'w_part', 'Météo'], ['ai', 'spark', 'Copilote']];

function ensureAll() {
  for (const t of NV.routes) { const e = entry(t); if (!e.ready) ensureData(e).then(() => { if (NV.open) render(); updateTripBat(); }); }
}
function setOpen(v) {
  NV.open = v; root.hidden = !v;
  if (v) { render(); ensureAll(); }
}
$('naviaBtn').addEventListener('click', ev => {
  ev.stopPropagation();
  try { setOpen(!NV.open); status(''); }
  catch (err) { root.hidden = true; NV.open = false; logError('NAVIA : ' + err.message); status('NAVIA : ' + err.message, 8000); }   // erreur visible à l'écran
});
const curEntry = () => NV.routes[NV.sel] ? entry(NV.routes[NV.sel]) : null;

function shell(body) {
  return `<div class="nvTabs">${TABS.map(([k, i, l]) => `<button data-tab="${k}" class="${NV.tab === k ? 'on' : ''}">${ic(i)}<span>${l}</span></button>`).join('')}
    <button data-act="close" class="nvX" title="Fermer">${ic('x')}</button></div><div class="nvBody">${body}</div>`;
}
function noRoute(msg) {
  return `<p class="nvNote">${msg || 'Choisissez d’abord une destination (loupe) : NAVIA calcule alors les itinéraires, l’énergie et la météo du trajet.'}</p>`;
}
const stepper = (key, label, val, unit, step) => `<div class="nvStep"><span>${label}</span><button data-step="${key}:${-step}">${ic('minus')}</button><b>${val}${unit}</b><button data-step="${key}:${step}">${ic('plus')}</button></div>`;

function viewRoutes() {
  if (!NV.routes.length) return noRoute();
  const rows = NV.routes.map((t, i) => { const e = entry(t); return { t, i, e, res: resFor(e, NV.ev.cruise), man: e.r.man.length, km: e.r.total / 1000, s: e.r.time }; });
  const best = (f) => rows.reduce((a, b) => f(b) < f(a) ? b : a, rows[0]).i;
  const fastest = best(r => r.s), eco = best(r => r.res.kWh), calm = best(r => r.man / r.km);
  const tags = i => [i === fastest ? 'Le plus rapide' : '', i === eco ? 'Le plus économique' : '', i === calm ? 'Le plus confortable' : ''].filter(Boolean);
  const note = rows.length === 1 ? '<p class="nvNote">Le serveur de routage n’a proposé qu’un itinéraire pour ce trajet.</p>' : '';
  const ready = rows.every(r => r.e.limits !== null) ;
  return note + rows.map(r => {
    const diff = r.man / r.km, level = diff < 0.5 ? 'Facile' : diff < 1.2 ? 'Moyen' : 'Chargé';
    const eta = clock(Date.now() + r.s * 1000), toll = r.t.summary.has_toll ? 'Oui' : 'Non';
    return `<div class="nvCard ${r.i === NV.sel ? 'sel' : ''}" data-route="${r.i}" style="--c:${NV_COLORS[r.i % 4]}">
      <div class="nvHead"><i></i><b>${fmtDur(r.s)}</b><span>${fmtKm(r.km)} · arrivée ${eta}</span></div>
      <div class="nvTags">${tags(r.i).map(x => `<em>${x}</em>`).join('') || '<em class="mut">Alternative</em>'}</div>
      <div class="nvGrid"><span>Péage<b>${toll}</b></span><span>Énergie<b>${r.res.kWh.toFixed(0)} kWh</b></span><span>Recharges<b>${r.res.stops.length}</b></span>
      <span>Difficulté<b>${level}</b></span><span>Trafic<b class="mut">n.d.</b></span></div></div>`;
  }).join('') + `<p class="nvNote">Durées hors trafic en temps réel (aucune source de trafic gratuite et fiable). Énergie = estimation à ${NV.ev.cruise} km/h${ready ? '' : ' (limites de vitesse en cours de chargement)'}.</p>`;
}

function viewEv() {
  const e = curEntry();
  const ctl = stepper('soc', 'Batterie actuelle', NV.ev.soc, ' %', 5) + stepper('reserve', 'Marge de sécurité', NV.ev.reserve, ' %', 5)
    + stepper('cap', 'Capacité utile', NV.ev.cap, ' kWh', 5) + stepper('calib', 'Calage conso', Math.round(NV.ev.calib * 100), ' %', 5)
    + stepper('cruise', 'Vitesse de croisière', NV.ev.cruise, ' km/h', 10);
  const hint = '<p class="nvNote">Le navigateur de la voiture n’a pas accès à la batterie : saisissez le niveau lu sur l’écran. Le « calage » ajuste le modèle à votre consommation réelle (100 % = modèle Model Y).</p>';
  if (!e) return ctl + noRoute() + hint;
  const loading = e.limits === null || e.elev === null || e.wx === null;
  const res = resFor(e, NV.ev.cruise);
  const base = simRoute(e, NV.ev.cruise, { wx: false, relief: false });
  const noWx = simRoute(e, NV.ev.cruise, { wx: false }), noRel = simRoute(e, NV.ev.cruise, { relief: false });
  const pct = x => (x >= 0 ? '+' : '') + x.toFixed(1).replace('.', ',') + ' kWh';
  const slow = simRoute(e, 110), spd = res.kWh - slow.kWh;
  const margin = res.stops.length ? 'recharge nécessaire' : (res.socEnd - NV.ev.reserve).toFixed(0) + ' % au-dessus de la marge';
  const stops = res.stops.map((s, i) => {
    const c = nearestCharger(pointAtAlong(e.r, s.atKm * 1000).pos, 15000, 50);
    return `<div class="nvStop"><b>Recharge ${i + 1} · km ${Math.round(s.atKm)}</b><span>${Math.round(s.socBefore)} → ${Math.round(s.socAfter)} % · ≈ ${Math.round(s.minutes)} min</span>
      <small>${c ? esc(c.name) + ' · ' + Math.round(c.kw) + ' kW · à ' + fmtKm(c.d / 1000) : 'Aucune borne rapide trouvée dans les zones déjà chargées'}</small></div>`;
  }).join('');
  return ctl + `<div class="nvBig"><div><small>Batterie à l’arrivée (estimée)</small><b class="${res.socEnd < NV.ev.reserve ? 'bad' : ''}">≈ ${Math.round(res.socEnd)} %</b></div>
    <div><small>Énergie du trajet</small><b>${res.kWh.toFixed(0)} kWh</b></div><div><small>Conso moyenne</small><b>${(res.whPerKm / 10).toFixed(1).replace('.', ',')}<u> kWh/100</u></b></div></div>
    <p class="nvLine">Marge : <b>${margin}</b> · durée totale ${fmtDur(res.totalS)}${res.stops.length ? ' (dont ' + fmtDur(res.chargeS) + ' de recharge)' : ''}</p>
    ${stops}
    <div class="nvImpacts"><small>Impacts sur l’énergie (modèle)</small>
      <span>Relief <b>${e.elev ? pct(res.kWh - noRel.kWh) + ' (+' + Math.round(res.up) + ' m / −' + Math.round(res.down) + ' m)' : 'altitudes indisponibles'}</b></span>
      <span>Météo <b>${e.wx ? pct(res.kWh - noWx.kWh) : 'météo indisponible'}</b></span>
      <span>Vitesse (vs 110) <b>${NV.ev.cruise > 110 ? pct(spd) : '—'}</b></span></div>
    ${loading ? '<p class="nvNote">Chargement du relief et de la météo… les valeurs seront affinées.</p>' : ''}${hint}`;
}

function viewSpeed() {
  const e = curEntry();
  if (!e) return noRoute();
  const sc = [110, 120, 130, NV.ev.cruise].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
  const rs = sc.map(v => ({ v, r: resFor(e, v) })), fastest = Math.min(...rs.map(x => x.r.totalS)), thrifty = Math.min(...rs.map(x => x.r.kWh));
  const lim = rs[0].r.limitsKnown;
  return `<table class="nvTbl"><tr><th></th>${rs.map(x => `<th>${x.v} km/h</th>`).join('')}</tr>
    <tr><td>Durée de conduite</td>${rs.map(x => `<td>${fmtDur(x.r.driveS)}</td>`).join('')}</tr>
    <tr><td>Consommation</td>${rs.map(x => `<td class="${x.r.kWh === thrifty ? 'hl' : ''}">${(x.r.whPerKm / 10).toFixed(1).replace('.', ',')} kWh/100</td>`).join('')}</tr>
    <tr><td>Énergie</td>${rs.map(x => `<td>${x.r.kWh.toFixed(0)} kWh</td>`).join('')}</tr>
    <tr><td>Batterie à l’arrivée</td>${rs.map(x => `<td>≈ ${Math.round(x.r.socEnd)} %</td>`).join('')}</tr>
    <tr><td>Arrêts de recharge</td>${rs.map(x => `<td>${x.r.stops.length}</td>`).join('')}</tr>
    <tr><td>Durée totale</td>${rs.map(x => `<td class="${x.r.totalS === fastest ? 'hl' : ''}">${fmtDur(x.r.totalS)}</td>`).join('')}</tr></table>
    <p class="nvNote">Batterie de départ ${NV.ev.soc} %, marge ${NV.ev.reserve} %, recharge à ≈ ${EVM.DEFAULTS.chargeKw} kW moyens jusqu’à ${EVM.DEFAULTS.chargeTo} %. ${lim < 0.3 ? 'Limitations de vitesse OSM indisponibles pour cet itinéraire : les scénarios sont peu différenciés.' : 'La vitesse est plafonnée par la limitation de chaque tronçon : un scénario ≥ 130 km/h n’est donc pas plus rapide hors autoroute.'} Estimations du modèle, pas des mesures.</p>`;
}

function wxRisk(c) {
  const out = [];
  if (c.code >= 95) out.push('orage');
  if (c.snow > 0 || (c.code >= 71 && c.code <= 77) || c.code === 85 || c.code === 86) out.push('neige');
  if (c.T <= 1 && (c.precip > 0 || c.code === 56 || c.code === 57 || c.code === 66 || c.code === 67)) out.push('risque de verglas');
  if (c.gust >= 20) out.push('rafales fortes');
  if (c.precip >= 4) out.push('pluie forte');
  if (c.code === 45 || c.code === 48) out.push('brouillard');
  return out;
}
function viewWx() {
  const e = curEntry();
  if (!e) return noRoute();
  if (e.wx === null) return '<p class="nvNote">Chargement de la météo du trajet…</p>';
  if (!e.wx) return '<p class="nvNote">Météo indisponible (Open-Meteo injoignable). La carte et le guidage restent utilisables.</p>';
  const rows = e.wx.map((w, i) => {
    const eta = w.t0 + e.r.time * 1000 * w.frac, c = wxAt(w, eta), risk = wxRisk(c);
    const lbl = i === 0 ? 'Départ' : i === e.wx.length - 1 ? 'Arrivée' : `km ${Math.round(e.r.total * w.frac / 1000)}`;
    return `<div class="nvWx"><b>${lbl}</b><span>${clock(eta)}</span>${ic((WMO[c.code] || ['w_cloud'])[0])}<b>${Math.round(c.T)}°</b>
      <span>${c.precip > 0 ? c.precip.toFixed(1).replace('.', ',') + ' mm' : 'sec'}</span><span>${Math.round(c.wind * 3.6)} km/h <small>rafales ${Math.round(c.gust * 3.6)}</small></span>
      <span class="${risk.length ? 'warn' : 'mut'}">${risk.join(', ') || 'RAS'}</span></div>`;
  }).join('');
  const res = resFor(e, NV.ev.cruise), neutral = simRoute(e, NV.ev.cruise, { wx: false });
  const d = res.kWh - neutral.kWh;
  return rows + `<p class="nvLine">Effet de la météo sur la consommation : <b>${d >= 0 ? '+' : ''}${d.toFixed(1).replace('.', ',')} kWh</b> (${(d / Math.max(1, neutral.kWh) * 100).toFixed(0)} %), vent et température inclus.
    Effet sur la durée : non modélisé (pas d’estimation fiable gratuite).</p><p class="nvNote">Prévisions Open-Meteo à l’heure estimée de passage. Les icônes sont aussi posées sur la carte.</p>`;
}

/* ---------- bornes (données IRVE déjà chargées par app.js) ---------- */
function nearestCharger(pos, maxM, minKw) {
  let best = null;
  for (const f of CH.feats.values()) {
    const p = f.properties; if ((p.kw || 0) < minKw) continue;
    const d = dist(pos, f.geometry.coordinates);
    if (d < maxM && (!best || d < best.d)) best = { d, name: p.name && !/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(p.name) ? p.name : (p.op || 'Borne'), kw: p.kw, coord: f.geometry.coordinates, op: p.op };
  }
  return best;
}
function chargersNearRoute(e, minKw, maxOff) {
  const r = e.r, step = Math.max(1, Math.round(r.coords.length / 300)), pts = [];
  for (let i = 0; i < r.coords.length; i += step) pts.push({ c: r.coords[i], a: r.cum[i] });
  const out = [];
  for (const f of CH.feats.values()) {
    const p = f.properties; if ((p.kw || 0) < minKw) continue;
    let bd = 1e9, ba = 0;
    for (const q of pts) { const d = dist(q.c, f.geometry.coordinates); if (d < bd) { bd = d; ba = q.a; } }
    if (bd <= maxOff && ba >= NV.along - 200) out.push({ p, coord: f.geometry.coordinates, off: bd, along: ba });
  }
  return out;
}

/* ---------- copilote : comprend la demande, répond avec les données réelles de NAVIA ---------- */
const overpassCache = new Map();
async function restaurantsNear(list, radius) {   // list : [{coord}] → Map index → restos
  const key = list.map(x => x.coord.map(v => v.toFixed(3)).join(',')).join(';') + radius;
  if (overpassCache.has(key)) return overpassCache.get(key);
  const q = '[out:json][timeout:15];(' + list.map(x => `nwr["amenity"~"^(restaurant|fast_food|cafe)$"]["name"](around:${radius},${x.coord[1]},${x.coord[0]});`).join('') + ');out center 80;';
  let j = null;
  for (const host of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {   // miroirs publics : on évite d'insister
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 12000);
    try { const r = await fetch(host + '?data=' + encodeURIComponent(q), { signal: ctl.signal }); if (r.ok) { j = await r.json(); break; } } catch (err) { /* miroir suivant */ } finally { clearTimeout(timer); }
  }
  if (!j) throw new Error('Overpass indisponible');
  const els = (j.elements || []).map(el => ({ name: el.tags.name, kind: el.tags.amenity, coord: [el.lon || el.center.lon, el.lat || el.center.lat] }));
  overpassCache.set(key, els);
  return els;
}
function goBtn(name, coord) { return `<button class="nvGo" data-go="${esc(name)}|${coord[0]}|${coord[1]}">Y aller</button>`; }
async function ask(text) {
  const q = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const e = curEntry(), num = (q.match(/(\d+)\s*(?:%|pour ?cent)/) || [])[1];
  if (/(110|120|130).*(110|120|130)|compar.*vitesse/.test(q)) {
    if (!e) return 'Lancez d’abord un itinéraire pour que je compare les vitesses.';
    await ensureData(e);
    const found = [...q.matchAll(/\b(9\d|1[0-3]\d)\b/g)].map(m => +m[1]); const sc = (found.length >= 2 ? found : [110, 130]).slice(0, 3);
    return 'Sur votre trajet actuel :<br>' + sc.map(v => { const r = resFor(e, v); return `<b>${v} km/h</b> : ${fmtDur(r.driveS)} de route, ${(r.whPerKm / 10).toFixed(1).replace('.', ',')} kWh/100, arrivée ≈ ${Math.round(r.socEnd)} %, ${r.stops.length} recharge(s), total ${fmtDur(r.totalS)}`; }).join('<br>');
  }
  if (/economique|econom|consomm|moins cher/.test(q) && /itineraire|route|trajet/.test(q)) {
    if (!e) return 'Aucun itinéraire en cours. Choisissez une destination.';
    await Promise.all(NV.routes.map(t => ensureData(entry(t))));
    const rs = NV.routes.map((t, i) => ({ i, r: resFor(entry(t), NV.ev.cruise), s: entry(t).r.time })).sort((a, b) => a.r.kWh - b.r.kWh);
    const b = rs[0], w = rs[rs.length - 1];
    return rs.length === 1 ? `Un seul itinéraire disponible : ${rs[0].r.kWh.toFixed(0)} kWh estimés à ${NV.ev.cruise} km/h.`
      : `L’itinéraire n°${b.i + 1} est le plus économique : ${b.r.kWh.toFixed(0)} kWh (${w.i !== b.i ? (w.r.kWh - b.r.kWh).toFixed(1).replace('.', ',') + ' kWh de moins que l’itinéraire ' + (w.i + 1) : ''}), ${fmtDur(b.s)}. <button class="nvGo" data-route="${b.i}">Le choisir</button>`;
  }
  if (num && /arriver|arrive|destination|batterie/.test(q)) {
    if (!e) return 'Lancez d’abord un itinéraire pour que je calcule la batterie à l’arrivée.';
    await ensureData(e);
    const target = +num, r = resFor(e, NV.ev.cruise), noStop = r.socNoCharge;
    if (noStop >= target) return `Oui : à ${NV.ev.cruise} km/h avec ${NV.ev.soc} % au départ, il vous resterait environ <b>${Math.round(noStop)} %</b> sans recharger (marge de ${Math.round(noStop - target)} points sur ${target} %).`;
    const alt = [110, 100, 90].map(v => ({ v, r: resFor(e, v) })).find(x => x.r.socNoCharge >= target);
    return `Non, pas sans recharger : environ <b>${Math.round(noStop)} %</b> à l’arrivée à ${NV.ev.cruise} km/h.` + (alt ? ` À ${alt.v} km/h il resterait ≈ ${Math.round(alt.r.socNoCharge)} %.` : ' Même à 90 km/h ce serait insuffisant.') + (r.stops.length ? ` Plan de recharge : ${r.stops.length} arrêt(s), durée totale ${fmtDur(r.totalS)}.` : '');
  }
  const km = (q.match(/dans\s+(\d+)\s*(?:km|kilometre)/) || [])[1];
  if (/dejeuner|manger|restaurant|resto|diner|cafe/.test(q) && !/recharge|borne|station|superchargeur/.test(q)) {
    if (!e || !km) return e ? 'Précisez la distance, par exemple « un endroit pour déjeuner dans 100 kilomètres ».' : 'Il me faut un itinéraire en cours pour chercher un restaurant plus loin sur la route.';
    const a = Math.min(e.r.total, NV.along + (+km) * 1000), c = pointAtAlong(e.r, a).pos;
    const els = await restaurantsNear([{ coord: c }], 4000);
    if (!els.length) return `Aucun restaurant référencé sur OpenStreetMap autour du km ${Math.round(a / 1000)}.`;
    const top = els.map(x => ({ ...x, d: dist(c, x.coord) })).sort((x, y) => x.d - y.d).slice(0, 5);
    return `Autour du point situé à ${Math.round((a - NV.along) / 1000)} km sur votre route :<br>` + top.map(x => `${esc(x.name)} <small>(${x.kind === 'restaurant' ? 'restaurant' : x.kind === 'cafe' ? 'café' : 'restauration rapide'}, ${fmtKm(x.d / 1000)})</small> ${goBtn(x.name, x.coord)}`).join('<br>') + '<br><small>Données OpenStreetMap : horaires non vérifiés.</small>';
  }
  if (/recharge|borne|station|superchargeur|supercharger/.test(q)) {
    const wantResto = /restaurant|manger|resto|dejeuner|cafe/.test(q);
    const minKw = /rapide|supercharg|ultra/.test(q) || wantResto ? 100 : 50;
    let cands = e ? chargersNearRoute(e, minKw, 4000).map(c => ({ ...c, rank: c.along - NV.along + c.off * 3 })).filter(c => c.along >= NV.along)
      : state.pos ? [...CH.feats.values()].filter(f => (f.properties.kw || 0) >= minKw).map(f => ({ p: f.properties, coord: f.geometry.coordinates, off: dist(state.pos, f.geometry.coordinates), rank: dist(state.pos, f.geometry.coordinates) })) : [];
    if (!cands.length) return 'Aucune borne ≥ ' + minKw + ' kW trouvée dans les zones déjà chargées de la carte. Déplacez-vous ou zoomez pour charger les bornes, puis réessayez.';
    cands.sort((a, b) => a.rank - b.rank); cands = cands.slice(0, wantResto ? 12 : 4);
    let restos = [];
    if (wantResto) { try { restos = await restaurantsNear(cands, 350); } catch (err) { return 'Le service de restaurants (Overpass) ne répond pas ; je ne peux pas vérifier les restaurants à proximité pour l’instant.'; } }
    const rows = cands.map(c => ({ ...c, rest: restos.filter(x => dist(x.coord, c.coord) <= 350) })).filter(c => !wantResto || c.rest.length).slice(0, 4);
    if (!rows.length) return 'Aucune borne rapide avec restaurant à moins de 350 m parmi les bornes proches de votre route.';
    return (wantResto ? 'Bornes rapides avec restaurant à proximité :' : 'Bornes les plus proches :') + '<br>' + rows.map(c => {
      const nm = c.p.name && !/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(c.p.name) ? c.p.name : (c.p.op || 'Borne');
      const trip = e ? `à ${fmtKm((c.along - NV.along) / 1000)} sur la route (détour ≈ ${fmtKm(c.off * 2 / 1000)}), ≈ ${Math.round(((c.along - NV.along) / 1000) / ((e.r.total / 1000) / (e.r.time / 3600)) * 60 + c.off * 2 / 1000)} min` : `à ${fmtKm(c.off / 1000)}`;
      return `<b>${esc(nm)}</b> · ${Math.round(c.p.kw)} kW · ${trip}${c.rest.length ? '<br><small>' + c.rest.slice(0, 3).map(x => esc(x.name)).join(', ') + '</small>' : ''} ${goBtn(nm, c.coord)}`;
    }).join('<br>') + '<br><small>Disponibilité en temps réel et tarifs : non disponibles gratuitement.</small>';
  }
  return 'Je sais répondre à : bornes rapides (avec restaurant), itinéraire le plus économique, « puis-je arriver avec 20 % ? », comparaison de vitesses (110 / 130), restaurant « dans 100 km ». Touchez une suggestion ci-dessus.';
}
const CHIPS = ['Borne rapide avec restaurant', 'Itinéraire le plus économique', 'Puis-je arriver avec 20 % ?', 'Compare 110 et 130 km/h', 'Déjeuner dans 100 km'];
function viewAi() {
  return `<div class="nvChips">${CHIPS.map(c => `<button data-chip="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <div class="nvLog">${NV.log.map(m => `<div class="${m.me ? 'me' : 'bot'}">${m.me ? esc(m.t) : m.t}</div>`).join('') || '<p class="nvNote">Copilote local : il répond avec vos vrais itinéraires, bornes et prévisions. Aucune donnée n’est envoyée à un service d’IA.</p>'}</div>
    <form class="nvForm"><input id="nvQ" type="text" placeholder="Posez une question…" autocomplete="off"><button type="submit">${ic('send')}</button></form>`;
}
async function sendQ(text) {
  text = text.trim(); if (!text) return;
  NV.log.push({ me: true, t: text }); NV.log.push({ t: '…' }); render();
  let a; try { a = await ask(text); } catch (err) { a = 'Une erreur est survenue (' + esc(err.message) + '). Réessayez.'; }
  NV.log[NV.log.length - 1] = { t: a }; NV.log = NV.log.slice(-10); render();
  const lg = root.querySelector('.nvLog'); if (lg) lg.scrollTop = lg.scrollHeight;
}

function render() {
  if (!NV.open) return;
  const keep = root.querySelector('.nvBody'), top = keep ? keep.scrollTop : 0;
  const view = { routes: viewRoutes, ev: viewEv, speed: viewSpeed, wx: viewWx, ai: viewAi }[NV.tab];
  let html; try { html = view(); } catch (err) { html = '<p class="nvNote">Données en cours de chargement…</p>'; }
  root.innerHTML = shell(html);
  const b = root.querySelector('.nvBody'); if (b) b.scrollTop = top;
  if (NV.tab === 'wx' || NV.tab === 'ev') { const e = curEntry(); if (e && e.ready) { try { drawStopMarkers(e, resFor(e, NV.ev.cruise)); } catch (err) { /* ignoré */ } } }
  else clearMarkers();
}
root.addEventListener('click', ev => {
  const t = ev.target.closest('button, [data-route]'); if (!t) return;
  if (t.dataset.tab) { NV.tab = t.dataset.tab; render(); if (t.dataset.tab === 'wx' || t.dataset.tab === 'ev' || t.dataset.tab === 'speed') { ensureAll(); } return; }
  if (t.dataset.act === 'close') return setOpen(false);
  if (t.dataset.step) {
    const [k, d] = t.dataset.step.split(':'), lim = { soc: [0, 100], reserve: [0, 50], cap: [40, 120], calib: [0.7, 1.5], cruise: [90, 130] }[k];
    const step = Number(d) * (k === 'calib' ? 0.01 : 1);
    NV.ev[k] = Math.round(Math.max(lim[0], Math.min(lim[1], NV.ev[k] + step)) * 100) / 100; saveEv();
    const e = curEntry(); if (e) e.res = {}; updateTripBat(); return render();
  }
  if (t.dataset.chip) return sendQ(t.dataset.chip);
  if (t.dataset.go) { const [name, lon, lat] = t.dataset.go.split('|'); setOpen(false); return startNav({ name, coord: [Number(lon), Number(lat)] }); }
  if (t.dataset.route != null) {
    const i = Number(t.dataset.route), trip = NV.routes[i];
    if (trip && i !== NV.sel) { NV.selecting = true; try { setRoute(trip, true); } finally { NV.selecting = false; } render(); }
  }
});
root.addEventListener('submit', ev => { ev.preventDefault(); const i = $('nvQ'); const v = i.value; i.value = ''; sendQ(v); });

})();
