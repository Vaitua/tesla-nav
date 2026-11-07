'use strict';
/* Télécharge les flux ouverts Bison Futé (RRN non concédé), les normalise et écrit events.json + flow.json + meta.json.
   Exécuté toutes les ~10 min par GitHub Actions (.github/workflows/traffic.yml) ; résultat publié sur la branche `data`.
   Pourquoi un pipeline : ces flux sont en XML DATEX II, sans en-tête CORS (illisibles depuis un navigateur) et lourds (2,7 Mo + 1,4 Mo).
   Usage : node tools/build-traffic.js <dossier-de-sortie> */
const fs = require('fs'), path = require('path');
const { XMLParser } = require('fast-xml-parser');
const L = require('./lib-traffic');
const BASE = 'https://tipi.bison-fute.gouv.fr/bison-fute-ouvert/publicationsDIR';
const out = process.argv[2] || 'out';
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true });

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'NAVIA-traffic-pipeline (open data reuse; github.com/Vaitua/tesla-nav)' }, signal: AbortSignal.timeout(60000) });
      if (r.ok) return await r.text();
    } catch (e) { /* nouvel essai */ }
    await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }
  throw new Error('indisponible : ' + url);
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const meta = { generatedAt: new Date().toISOString(), sources: {} };
  try {                                                                  // chaque source est indépendante : une panne n'empêche pas l'autre
    const j = xml.parse(await get(BASE + '/Evenementiel-DIR/grt/RRN/content.xml'));
    const pub = j.Envelope.Body.d2LogicalModel.payloadPublication;
    const events = L.buildEvents(pub.situation, Date.now());
    fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify({ updated: pub.publicationTime, fetched: meta.generatedAt,
      source: 'Bison Futé / DIR (réseau routier national non concédé)', licence: 'Licence Ouverte 2.0', events }));
    meta.sources.events = { ok: true, count: events.length, updated: pub.publicationTime };
  } catch (e) { meta.sources.events = { ok: false, error: String(e.message) }; }
  try {
    const [ref, q, date] = await Promise.all([get(BASE + '/QTV-DIR/refDir.csv'), get(BASE + '/QTV-DIR/qtvDir.xml'), get(BASE + '/QTV-DIR/date.txt').catch(() => '')]);
    const pub = xml.parse(q).d2LogicalModel.payloadPublication, meas = {};
    for (const s of L.arr(pub.siteMeasurements)) {
      const id = s.measurementSiteReference['@id'], o = {};
      for (const mv of L.arr(s.measuredValue)) {
        const bd = mv.measuredValue && mv.measuredValue.basicData;
        if (!bd) continue;
        if (bd['@type'] === 'TrafficSpeed') o.speed = Number(bd.averageVehicleSpeed && bd.averageVehicleSpeed.speed);
        if (bd['@type'] === 'TrafficFlow') o.flow = Number(bd.vehicleFlow && bd.vehicleFlow.vehicleFlowRate);
      }
      meas[id] = o;
    }
    const segments = L.buildFlow(L.parseCsv(ref), meas);
    fs.writeFileSync(path.join(out, 'flow.json'), JSON.stringify({ updated: pub.publicationTime, stamp: date.trim(), fetched: meta.generatedAt,
      source: 'Bison Futé / DIR (vitesses mesurées, réseau routier national non concédé)', licence: 'Licence Ouverte 2.0', levels: L.LEVELS, segments }));
    meta.sources.flow = { ok: true, count: segments.length, updated: pub.publicationTime };
  } catch (e) { meta.sources.flow = { ok: false, error: String(e.message) }; }
  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta));
  console.log(JSON.stringify(meta));
  if (!meta.sources.events.ok && !meta.sources.flow.ok) process.exit(1);   // tout a échoué : on ne publie rien (les anciennes données restent en ligne)
})();
