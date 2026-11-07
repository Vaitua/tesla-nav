'use strict';
/* Conversion des flux ouverts Bison Futé (DATEX II, licence ouverte Etalab 2.0) en JSON normalisé pour NAVIA.
   Fonctions pures : testables hors réseau (voir tests/traffic.test.js). */

/* ---- Lambert-93 (EPSG:2154) → WGS84 : projection conique conforme à 2 parallèles (formule inverse standard) ---- */
const A = 6378137, F = 1 / 298.257222101, E = Math.sqrt(2 * F - F * F);
const LAT0 = 46.5 * Math.PI / 180, LON0 = 3 * Math.PI / 180, PHI1 = 44 * Math.PI / 180, PHI2 = 49 * Math.PI / 180, X0 = 700000, Y0 = 6600000;
const m = p => Math.cos(p) / Math.sqrt(1 - E * E * Math.sin(p) ** 2);
const t = p => Math.tan(Math.PI / 4 - p / 2) / Math.pow((1 - E * Math.sin(p)) / (1 + E * Math.sin(p)), E / 2);
const N = (Math.log(m(PHI1)) - Math.log(m(PHI2))) / (Math.log(t(PHI1)) - Math.log(t(PHI2)));
const G = m(PHI1) / (N * Math.pow(t(PHI1), N));
const R0 = A * G * Math.pow(t(LAT0), N);
function lambert93ToWgs84(x, y) {
  const dx = x - X0, dy = R0 - (y - Y0), r = Math.sign(N) * Math.hypot(dx, dy), gamma = Math.atan2(dx, dy);
  const tt = Math.pow(r / (A * G), 1 / N);
  let phi = Math.PI / 2 - 2 * Math.atan(tt);
  for (let i = 0; i < 8; i++) phi = Math.PI / 2 - 2 * Math.atan(tt * Math.pow((1 - E * Math.sin(phi)) / (1 + E * Math.sin(phi)), E / 2));
  return [+(((gamma / N + LON0) * 180) / Math.PI).toFixed(5), +((phi * 180) / Math.PI).toFixed(5)];   // [lon, lat]
}

/* ---- niveaux de circulation : calculés à partir de la vitesse MESURÉE (la source ne fournit pas de niveau) ---- */
const LEVELS = ['fluide', 'ralenti', 'dense', 'sature'];
function flowLevel(speed, axe) {
  if (!(speed > 0)) return -1;                                         // pas de mesure exploitable
  const hw = /^A\d/.test(axe || '');                                    // autoroutes et rocades : vitesses de référence plus hautes
  const [a, b, c] = hw ? [70, 45, 25] : [45, 30, 15];
  return speed >= a ? 0 : speed >= b ? 1 : speed >= c ? 2 : 3;
}
function parseCsv(txt) {
  const [h, ...rows] = txt.trim().split(/\r?\n/), cols = h.split(';');
  return rows.map(l => {
    const v = l.split(';'), o = {};
    if (v.length === cols.length - 1) v.splice(3, 0, '');                // les lignes du fichier de référence n'ont pas la colonne code_insee_commune : on réaligne
    cols.forEach((c, i) => { o[c] = v[i]; });
    return o;
  });
}
/* refDir.csv + mesures {site: {speed, flow}} → segments [{id, c:[[lon,lat],[lon,lat]], v, q, l, a}] */
function buildFlow(refRows, meas) {
  const out = [];
  for (const r of refRows) {
    const me = meas[r.code_pme];
    if (!me || !r.x_deb || !r.x_fin) continue;
    const l = flowLevel(me.speed, r.axe);
    if (l < 0) continue;
    const a = lambert93ToWgs84(+r.x_deb, +r.y_deb), b = lambert93ToWgs84(+r.x_fin, +r.y_fin);
    if (!(a[1] > 41 && a[1] < 52 && a[0] > -6 && a[0] < 10)) continue;   // hors France métropolitaine : coordonnées douteuses
    out.push({ id: r.code_pme, c: [a, b], v: Math.round(me.speed), q: me.flow == null || isNaN(me.flow) ? null : Math.round(me.flow), l, a: r.axe || '' });
  }
  return out;
}

/* ---- événements DATEX II → catégories NAVIA ---- */
const arr = x => x == null ? [] : Array.isArray(x) ? x : [x];
const txtOf = c => {
  const v = c && c.comment && c.comment.values && c.comment.values.value;
  return v == null ? '' : String(typeof v === 'object' ? v['#text'] : v).replace(/\s+/g, ' ').trim();
};
function categorize(rec) {
  const type = String(rec['@type'] || '').replace(/^.*:/, '');
  const mg = String(rec.roadOrCarriagewayOrLaneManagementType || '');
  if (type === 'Accident') return 'accident';
  if (type === 'AbnormalTraffic') return 'bouchon';
  if (type === 'MaintenanceWorks' || type === 'ConstructionWorks') return 'travaux';
  if (type === 'AnimalPresenceObstruction' || type === 'WeatherRelatedRoadConditions' || type === 'NonWeatherRelatedRoadConditions' || type === 'EnvironmentalObstruction') return 'danger';
  if (/Obstruction$/.test(type)) return 'obstacle';
  if (type === 'RoadOrCarriagewayOrLaneManagement' && /roadClosed|closedPermanently|carriagewayClosures/.test(mg)) return 'fermeture';
  if (type === 'RoadOrCarriagewayOrLaneManagement' && /laneClosures|singleAlternate|contraflow|narrowLanes/.test(mg)) return 'voie';
  return null;                                                          // consignes, déviations, limitations : pas de danger en soi
}
const SEV = { lowest: 0, low: 1, medium: 2, high: 3, highest: 4 };
function pointOf(loc) {
  const p = loc && loc.tpegPointLocation && loc.tpegPointLocation.point && loc.tpegPointLocation.point.pointCoordinates;
  if (p) return { a: [+p.longitude, +p.latitude] };
  const l = loc && loc.tpegLinearLocation;
  if (l && l.from && l.to) {
    const f = l.from.pointCoordinates, t2 = l.to.pointCoordinates;
    if (f && t2) return { a: [+f.longitude, +f.latitude], b: [+t2.longitude, +t2.latitude] };
  }
  return null;
}
function roadOf(loc) {
  const pt = loc && loc.tpegPointLocation && loc.tpegPointLocation.point;
  const ln = loc && loc.tpegLinearLocation && loc.tpegLinearLocation.to;
  const names = arr((pt && pt.name) || (ln && ln.name));
  const link = names.find(n => n.tpegOtherPointDescriptorType === 'linkName'), town = names.find(n => n.tpegOtherPointDescriptorType === 'townName');
  const g = n => { const v = n && n.descriptor && n.descriptor.values && n.descriptor.values.value; return v == null ? '' : (typeof v === 'object' ? v['#text'] : v); };
  return { road: g(link), town: g(town) };
}
const SUB_FIELDS = ['roadOrCarriagewayOrLaneManagementType', 'accidentType', 'obstructionType', 'roadMaintenanceType', 'environmentalObstructionType',
  'animalPresenceType', 'weatherRelatedRoadConditionType', 'abnormalTrafficType'];
/* nowMs : date de référence (injectable pour les tests). Ne garde que les événements en cours. */
function buildEvents(situations, nowMs) {
  const out = [], seen = new Set();
  for (const s of arr(situations)) {
    for (const rec of arr(s.situationRecord)) {
      const cat = categorize(rec);
      if (!cat) continue;
      const loc = rec.groupOfLocations, pt = pointOf(loc);
      if (!pt) continue;
      const v = (rec.validity && rec.validity.validityTimeSpecification) || {}, st = Date.parse(v.overallStartTime), en = Date.parse(v.overallEndTime);
      if (st && st > nowMs + 30 * 60000) continue;                      // pas encore commencé (> 30 min) : ce n'est pas un événement en cours
      if (en && en < nowMs) continue;                                   // terminé
      if (rec.validity && rec.validity.validityStatus === 'suspended') continue;
      const comments = arr(rec.generalPublicComment);
      const desc = comments.filter(c => c.commentType === 'description').map(txtOf).filter(Boolean).join(' · ');
      const where = comments.filter(c => c.commentType === 'locationDescriptor').map(txtOf).filter(Boolean)[0] || '';
      const { road, town } = roadOf(loc);
      const src = (rec.source && rec.source.sourceIdentification) || 'DIR';
      const id = String(rec['@id'] || s['@id']);
      if (seen.has(id)) continue;
      seen.add(id);
      const lanes = rec.impact && rec.impact.numberOfLanesRestricted;
      const subKey = SUB_FIELDS.find(k => rec[k]);
      out.push({ id, cat, sev: SEV[s.overallSeverity] == null ? 1 : SEV[s.overallSeverity], t: String(rec['@type']).replace(/^.*:/, ''), sub: subKey ? String(rec[subKey]) : '',
        a: pt.a, b: pt.b || null, road, town, where: where.slice(0, 160), text: desc.slice(0, 280),
        from: st ? new Date(st).toISOString() : null, to: en ? new Date(en).toISOString() : null,
        upd: rec.situationRecordVersionTime || null, src: String(src).replace(/^Direction interdépartementale des routes\//, '').slice(0, 60), lanes: lanes == null ? null : Number(lanes) });
    }
  }
  return out;
}
module.exports = { lambert93ToWgs84, flowLevel, parseCsv, buildFlow, buildEvents, categorize, LEVELS, arr };
