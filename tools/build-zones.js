'use strict';
/* Construit zones.json (zones de vigilance) à partir d'une liste de points OpenStreetMap (ODbL) : node tools/build-zones.js <points.json> <zones.json>
   Entrée : {"p":[[lon,lat,vitesse_max,0],…]} — fichier de travail, NON publié.
   Sortie : zones circulaires dont le centre est volontairement décalé (déterministe) : la position d'un équipement ne peut pas être lue
   sur la carte ni dans les données publiées (art. R413-15 du code de la route : pas d'information sur la localisation des appareils de contrôle).
   Rayon : 1 000 m (limitation ≤ 70 km/h) ou 2 000 m (autres cas), soit des zones de 2 km / 4 km. Ces longueurs reprennent la pratique du secteur
   rapportée par la presse ; elles ne sont PAS vérifiées sur le texte réglementaire (voir docs/TRAFIC.md). */
const fs = require('fs');
const [,, inp, out] = process.argv;
const src = JSON.parse(fs.readFileSync(inp, 'utf8'));
const KM = 111320;
const hash = (a, b) => { let h = 2166136261; for (const c of `${a.toFixed(5)},${b.toFixed(5)}`) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
const cell = new Map(), zones = [];
for (const [lon, lat, ms] of src.p) {
  const key = Math.round(lon * 250) + ',' + Math.round(lat * 250);               // fusion des points à moins de ~400 m
  if (cell.has(key)) { const z = cell.get(key); z.ms = Math.max(z.ms, ms || 0); continue; }
  const z = { lon, lat, ms: ms || 0 }; cell.set(key, z); zones.push(z);
}
const res = zones.map(z => {
  const R = z.ms > 0 && z.ms <= 70 ? 1000 : 2000, h1 = hash(z.lon, z.lat), h2 = hash(z.lat, z.lon);
  const ang = h1 * 6.283185, d = R * (0.2 + 0.4 * h2);                             // décalage de 20 à 60 % du rayon
  const lat = z.lat + (d * Math.cos(ang)) / KM, lon = z.lon + (d * Math.sin(ang)) / (KM * Math.cos(z.lat * Math.PI / 180));
  return [+lon.toFixed(4), +lat.toFixed(4), R];
});
fs.writeFileSync(out, JSON.stringify({ src: 'OpenStreetMap (ODbL) — zones de vigilance, centres décalés', date: src.date || new Date().toISOString().slice(0, 10), z: res }));
console.log(src.p.length, 'points →', res.length, 'zones', (fs.statSync(out).size / 1024).toFixed(0), 'Ko');
