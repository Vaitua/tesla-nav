'use strict';
// Tests du modèle énergétique : node tests/ev.test.js
const assert = require('assert');
const { simulate, DEFAULTS } = require('../ev.js');

const flat = (km, limit, extra) => Array.from({ length: km }, () => Object.assign({ len: 1000, limit, dh: 0, T: 15, wind: 0, windDir: 0, brg: 0 }, extra));
const per100 = r => r.whPerKm / 10;
const run = (prof, cruise, params) => simulate(prof, { cruise, baseTimeS: prof.length * 1000 / (130 / 3.6), params });

// ordres de grandeur autoroute, temps doux, plat
const c110 = per100(run(flat(200, 130), 110)), c130 = per100(run(flat(200, 130), 130));
assert(c110 > 14 && c110 < 19, '110 km/h hors plage : ' + c110);
assert(c130 > 19 && c130 < 24, '130 km/h hors plage : ' + c130);
assert(c130 > c110, 'plus vite doit consommer plus');

// durée : 130 plus rapide que 110
assert(run(flat(200, 130), 130).driveS < run(flat(200, 130), 110).driveS);

// relief : monter consomme plus, descendre récupère
const up = per100(run(flat(100, 130, { dh: 10 }), 120)), dn = per100(run(flat(100, 130, { dh: -10 }), 120));
assert(up > c110 && dn < c110);

// froid et vent de face augmentent la consommation
assert(per100(run(flat(100, 130, { T: -5 }), 120)) > per100(run(flat(100, 130), 120)));
assert(per100(run(flat(100, 130, { wind: 10, windDir: 0, brg: 0 }), 120)) > per100(run(flat(100, 130), 120)));
assert(per100(run(flat(100, 130, { wind: 10, windDir: 180, brg: 0 }), 120)) < per100(run(flat(100, 130), 120)));

// recharge : 600 km avec 80 % → au moins un arrêt, jamais sous la réserve
const long = run(flat(600, 130), 130);
assert(long.stops.length >= 1 && long.stops.length <= 3, 'arrêts : ' + long.stops.length);
assert(long.socEnd >= DEFAULTS.reserve - 0.5 && long.feasible);
assert(long.totalS > long.driveS);

// trajet court : aucun arrêt
const short = run(flat(50, 130), 120);
assert.strictEqual(short.stops.length, 0);
assert(short.socEnd < 80 && short.socEnd > 60);

// limites inconnues : retombe sur la vitesse moyenne, sans NaN
const unk = simulate(flat(30, null), { cruise: 120, avgKmh: 60, baseTimeS: 1800 });
assert(Number.isFinite(unk.kWh) && unk.kWh > 0 && unk.limitsKnown === 0);

console.log('ev.js : tous les tests passent (110 → %s, 130 → %s kWh/100 km)', c110.toFixed(1), c130.toFixed(1));
