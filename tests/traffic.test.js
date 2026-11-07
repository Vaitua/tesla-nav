'use strict';
// Tests de la conversion des flux Bison Futé : node tests/traffic.test.js (aucun réseau)
const assert = require('assert');
const L = require('../tools/lib-traffic');

// Lambert-93 → WGS84 : points de contrôle connus (tolérance ~15 m)
const near = (got, want, tol) => assert(Math.abs(got[0] - want[0]) < tol && Math.abs(got[1] - want[1]) < tol, JSON.stringify(got) + ' ≠ ' + JSON.stringify(want));
near(L.lambert93ToWgs84(652400, 6862000), [2.3513, 48.8563], 0.0002);          // Paris
near(L.lambert93ToWgs84(700000, 6600000), [3, 46.5], 0.0001);                   // origine de la projection
near(L.lambert93ToWgs84(569981.6, 6938140.0), [1.2047, 49.5293], 0.0003);       // A28 (relevé du fichier réel)

// niveaux : autoroute et route ordinaire n'ont pas les mêmes seuils ; pas de mesure = ignoré
assert.strictEqual(L.flowLevel(110, 'A28'), 0);
assert.strictEqual(L.flowLevel(60, 'A28'), 1);
assert.strictEqual(L.flowLevel(60, 'N20'), 0);
assert.strictEqual(L.flowLevel(30, 'A64'), 2);
assert.strictEqual(L.flowLevel(7, 'A64'), 3);
assert.strictEqual(L.flowLevel(0, 'A64'), -1);
assert.strictEqual(L.flowLevel(NaN, 'A64'), -1);

// fichier de référence : les lignes n'ont pas la colonne code_insee_commune (réalignement) ; ligne vide ignorée
const csv = 'code_pme;source;source_2;code_insee_commune;axe;pr_debut;abscisse_debut;pr_fin;abscisse_fin;sens_gestionnaire;sens_cardinal;sens_migratoire;sens_giratoire;longueur;nb_voies;x_deb;y_deb;x_fin;y_fin;code_traficolor\n'
  + 'MUM76.h1;DIRNO;237676517;A28;76PR91D;800;76PR94D;840;1;NORD_SUD;Y;;3035;0;569981.6;6938140.0;568217.6;6935783.5;RO76\n'
  + 'A0027010102;DIRN;;;;0;;;;;;;0;0;;;;;\n';
const rows = L.parseCsv(csv);
assert.strictEqual(rows[0].axe, 'A28'); assert.strictEqual(rows[0].x_deb, '569981.6');
const seg = L.buildFlow(rows, { 'MUM76.h1': { speed: 109, flow: 150 }, A0027010102: { speed: 90, flow: 10 } });
assert.strictEqual(seg.length, 1);                                               // le site sans coordonnées est écarté
assert.strictEqual(seg[0].l, 0); assert.strictEqual(seg[0].v, 109); assert.strictEqual(seg[0].c.length, 2);

// événements : structure DATEX II réelle (extrait simplifié)
const rec = (type, extra) => Object.assign({ '@type': 'ns2:' + type, '@id': 'r-' + type + Math.random(), source: { sourceIdentification: 'Direction interdépartementale des routes/DIR Centre-Est' },
  validity: { validityStatus: 'definedByValidityTimeSpec', validityTimeSpecification: { overallStartTime: '2026-11-07T04:00:00+01:00' } },
  generalPublicComment: [{ comment: { values: { value: { '#text': 'Accident face à face', '@lang': 'fr' } } }, commentType: 'description' }],
  groupOfLocations: { tpegPointLocation: { point: { pointCoordinates: { latitude: 45.5, longitude: 6.08 }, name: [{ descriptor: { values: { value: { '#text': 'D1006' } } }, tpegOtherPointDescriptorType: 'linkName' }] } } } }, extra);
const NOW = Date.parse('2026-11-07T09:00:00+01:00');
const ev = L.buildEvents([
  { '@id': 's1', overallSeverity: 'medium', situationRecord: rec('Accident', { accidentType: 'accident' }) },
  { '@id': 's2', overallSeverity: 'low', situationRecord: [rec('MaintenanceWorks'), rec('SpeedManagement')] },                                  // limitation de vitesse : ignorée
  { '@id': 's3', overallSeverity: 'low', situationRecord: rec('Accident', { validity: { validityTimeSpecification: { overallStartTime: '2026-11-07T04:00:00+01:00', overallEndTime: '2026-11-07T06:00:00+01:00' } } }) },   // terminé
  { '@id': 's4', overallSeverity: 'low', situationRecord: rec('MaintenanceWorks', { validity: { validityTimeSpecification: { overallStartTime: '2026-12-03T08:30:00+01:00' } } }) },  // futur
  { '@id': 's5', overallSeverity: 'high', situationRecord: rec('RoadOrCarriagewayOrLaneManagement', { roadOrCarriagewayOrLaneManagementType: 'roadClosed' }) },
  { '@id': 's6', overallSeverity: 'low', situationRecord: rec('AnimalPresenceObstruction', { animalPresenceType: 'animalsOnTheRoad' }) },
  { '@id': 's7', overallSeverity: 'low', situationRecord: rec('Accident', { groupOfLocations: {} }) },                                              // sans position : ignoré
], NOW);
const cats = ev.map(e => e.cat).sort();
assert.deepStrictEqual(cats, ['accident', 'danger', 'fermeture', 'travaux']);
const acc = ev.find(e => e.cat === 'accident');
assert.deepStrictEqual(acc.a, [6.08, 45.5]); assert.strictEqual(acc.road, 'D1006'); assert.strictEqual(acc.src, 'DIR Centre-Est'); assert.strictEqual(acc.sev, 2);
assert.strictEqual(ev.find(e => e.cat === 'danger').sub, 'animalsOnTheRoad');

console.log('traffic : tous les tests passent (%d événements retenus, 1 segment de trafic)', ev.length);
