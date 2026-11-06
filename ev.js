'use strict';
/* NAVIA — modèle énergétique d'un véhicule électrique (fonctions pures, testables sous Node : `node tests/ev.test.js`).

   C'est une ESTIMATION physique, pas une mesure. Pour chaque tronçon de route :
     force = roulement (Crr·m·g) + aérodynamique (½·ρ·SCx·(v ± vent)²) + pente (m·g·dh/len)
     énergie batterie = force·longueur / rendement            (si la force est positive)
                      = force·longueur · rendement · récup.   (en descente : une partie est récupérée)
     + auxiliaires (électronique + chauffage/clim selon la température) × durée
   Corrections : froid (batterie moins efficace), arrêts et redémarrages à basse vitesse.
   Valeurs par défaut ≈ Tesla Model Y 2022 Grande Autonomie (75 kWh utiles). Tout est configurable (voir DEFAULTS).
   Sources des ordres de grandeur : fiches constructeur (Cx 0,23, surface frontale ≈ 2,66 m²), cycles WLTP/EPA, essais
   publics à 110 / 130 km/h (≈ 16–17 puis ≈ 21 kWh/100 km sur autoroute par temps doux). */
(function (root) {
  const G = 9.81;
  const DEFAULTS = {
    cap: 75,          // kWh utilisables
    soc: 80,          // % de batterie au départ (saisi par l'utilisateur)
    reserve: 10,      // % de marge de sécurité en dessous desquels on planifie une recharge
    mass: 2050,       // kg (véhicule + occupants + bagages)
    scx: 0.612,       // m² (Cx × surface frontale)
    crr: 0.009,       // coefficient de roulement
    eff: 0.92,        // rendement batterie → roues
    regen: 0.6,       // part de l'énergie de descente récupérée
    aux: 0.7,         // kW d'auxiliaires
    chargeKw: 120,    // puissance moyenne de recharge rapide (10 → 80 %), kW
    chargeTo: 80,     // % visé à chaque recharge
    detourMin: 6,     // minutes perdues par arrêt (sortie, branchement)
    calib: 1.0,       // facteur de calage sur la consommation réellement observée
  };

  const airDensity = T => 1.2 * 293.15 / (273.15 + T);

  /* Énergie (Wh) pour un tronçon.
     len m · v m/s · dh m · T °C · hw m/s (vent de face > 0) */
  function segmentWh(len, v, dh, T, hw, p) {
    if (len <= 0 || v <= 0) return 0;
    const air = v + hw;
    const fAero = 0.5 * airDensity(T) * p.scx * Math.abs(air) * air;
    const f = p.crr * p.mass * G + fAero + p.mass * G * (dh / len);
    const cold = 1 + Math.min(0.2, 0.006 * Math.max(0, 15 - T));
    const kmh = v * 3.6;
    const stopGo = 1 + 0.3 * Math.max(0, (70 - kmh) / 70);
    let wh = (f > 0 ? (f * len / p.eff) * cold * stopGo : (f * len * p.eff * p.regen)) / 3600;   // joules → Wh
    const climate = T < 15 ? Math.min(3, 0.12 * (15 - T)) : T > 25 ? Math.min(1.5, 0.1 * (T - 25)) : 0;
    wh += (p.aux + climate) * 1000 * (len / v) / 3600;
    return wh * p.calib;
  }

  /* Vitesse réellement tenue sur un tronçon dont la limitation est L (km/h) pour une vitesse de croisière donnée.
     Sur route rapide (≥ 100) on roule à la croisière plafonnée par la limite ; sinon à ~90 % de la limite. */
  function driveSpeed(L, cruise, fallback) {
    if (!L) return fallback;
    return L >= 100 ? Math.min(cruise, L) : L * 0.9;
  }

  /* Simule un trajet.
     profile : [{ len m, limit km/h|null, dh m, T °C, wind m/s, windDir ° (d'où vient le vent), brg ° (cap du tronçon) }]
     opts : { cruise km/h, baseTimeS (temps de l'itinéraire hors trafic), avgKmh (vitesse moyenne si limites inconnues), params } */
  function simulate(profile, opts) {
    const p = Object.assign({}, DEFAULTS, opts.params || {});
    const cruise = opts.cruise || 120;
    const fb = opts.avgKmh || 70;
    const wh = [], tS = [];
    let refT = 0, scnT = 0, up = 0, down = 0, total = 0, limitsKnown = 0, totalLen = 0;
    for (const s of profile) {
      const v = driveSpeed(s.limit, cruise, fb) / 3.6, vRef = driveSpeed(s.limit, 130, fb) / 3.6;
      if (s.limit) limitsKnown += s.len;
      totalLen += s.len;
      const hw = (s.wind || 0) * Math.cos((((s.windDir || 0) - (s.brg || 0)) * Math.PI) / 180);
      wh.push(segmentWh(s.len, v, s.dh || 0, s.T == null ? 15 : s.T, hw, p));
      tS.push(s.len / v);
      refT += s.len / vRef; scnT += s.len / v;
      if ((s.dh || 0) > 0) up += s.dh; else down -= s.dh;
      total += s.len;
    }
    const driveS = Math.max(0, (opts.baseTimeS || refT) + (scnT - refT));
    const kWh = wh.reduce((a, b) => a + b, 0) / 1000;
    const r = { km: total / 1000, driveS, kWh, whPerKm: total ? (kWh * 1000) / (total / 1000) : 0, up, down,
      limitsKnown: totalLen ? limitsKnown / totalLen : 0 };
    plan(r, wh, tS, profile, p, opts);
    return r;
  }

  /* Planifie les recharges : on s'arrête dès que la batterie passerait sous la réserve. */
  function plan(r, wh, tS, profile, p, opts) {
    const capWh = p.cap * 1000, reserveWh = (p.reserve / 100) * capWh, chargeToWh = (p.chargeTo / 100) * capWh;
    const remaining = new Array(wh.length + 1).fill(0);      // énergie restante à dépenser après le tronçon i
    for (let i = wh.length - 1; i >= 0; i--) remaining[i] = remaining[i + 1] + wh[i];
    let e = (p.soc / 100) * capWh, along = 0, chargeS = 0;
    const stops = [];
    for (let i = 0; i < wh.length; i++) {
      if (e - wh[i] < reserveWh && stops.length < 8) {
        const need = remaining[i] + reserveWh + 0.05 * capWh;        // juste ce qu'il faut pour finir, +5 %
        const target = Math.min(chargeToWh, Math.max(need, e + 0.1 * capWh));
        const add = Math.max(0, target - e);
        const min = (add / 1000) / p.chargeKw * 60 + p.detourMin;
        stops.push({ atKm: along / 1000, addKWh: add / 1000, minutes: min, socBefore: (e / capWh) * 100, socAfter: (target / capWh) * 100 });
        e = target; chargeS += min * 60;
      }
      e -= wh[i];
      along += profile[i].len;
    }
    r.stops = stops;
    r.socEnd = (e / capWh) * 100;                                   // peut être < 0 si impossible même avec 8 arrêts
    r.chargeS = chargeS;
    r.totalS = r.driveS + chargeS;
    r.feasible = r.socEnd >= p.reserve - 0.01;
    // sans recharge : la batterie à l'arrivée si on ne s'arrête jamais
    r.socNoCharge = p.soc - (r.kWh / p.cap) * 100;
  }

  const api = { DEFAULTS, segmentWh, driveSpeed, simulate, airDensity };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.EVM = api;
})(typeof window !== 'undefined' ? window : globalThis);
