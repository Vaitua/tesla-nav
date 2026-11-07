/* OPTIONNEL — proxy Cloudflare Worker (offre gratuite : 100 000 requêtes/jour, sans carte bancaire) pour une source de trafic à clé (ex. TomTom).
   ⚠ NON TESTÉ en conditions réelles (aucune clé disponible pendant le développement) : à valider avant usage, notamment les conditions
   d'utilisation du fournisseur (affichage sur une carte non TomTom, mise en cache, usage dans un véhicule).
   Rôle : la clé reste un secret du Worker (jamais dans le navigateur) ; les tuiles sont mises en cache en périphérie pour économiser le quota.
   Déploiement : wrangler secret put TOMTOM_KEY ; wrangler deploy ; puis window.NAVIA_CONFIG = { tomtomProxy: 'https://<worker>.workers.dev' } (voir docs/TRAFIC.md). */
const ALLOWED_ORIGIN = 'https://vaitua.github.io';
export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url), origin = req.headers.get('Origin') || '';
    if (origin && origin !== ALLOWED_ORIGIN) return new Response('forbidden', { status: 403 });
    const m = u.pathname.match(/^\/flow\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
    if (!m || +m[1] < 6 || +m[1] > 15) return new Response('not found', { status: 404 });
    const cache = caches.default, key = new Request(u.origin + u.pathname);
    let res = await cache.match(key);
    if (!res) {
      const up = await fetch(`https://api.tomtom.com/traffic/map/4/tile/flow/relative/${m[1]}/${m[2]}/${m[3]}.pbf?key=${env.TOMTOM_KEY}`);
      if (!up.ok) return new Response('upstream ' + up.status, { status: up.status === 403 || up.status === 429 ? 429 : 502 });   // quota atteint : le client masque la couche
      res = new Response(up.body, { headers: { 'Content-Type': 'application/x-protobuf', 'Cache-Control': 'public, max-age=120' } });
      ctx.waitUntil(cache.put(key, res.clone()));
    }
    const h = new Headers(res.headers); h.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    return new Response(res.body, { status: 200, headers: h });
  },
};
