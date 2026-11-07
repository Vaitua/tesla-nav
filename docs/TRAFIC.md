# Trafic, événements routiers et zones de vigilance

Étude des sources (vérifiée le 7 novembre 2026), architecture retenue et limites. Budget : **0 €, aucune carte bancaire, aucune clé dans le navigateur.**

## 1. Sources étudiées

« Vérifié » = j'ai lu la page ou téléchargé le flux moi-même. « Non vérifié » = information de recherche non confirmée sur le texte officiel.

| Source | Contenu | Gratuité réelle | Clé / CB | Quotas | Couverture | Fraîcheur constatée | Navigateur direct ? | Décision |
|---|---|---|---|---|---|---|---|---|
| **Bison Futé / DIR, événements** (DATEX II, data.gouv.fr « Événements routiers sur le RRN non concédé ») | accidents, travaux, fermetures, obstacles, animaux, neige, voies neutralisées | Oui, Licence Ouverte 2.0 (réutilisation, y compris commerciale, avec mention de la source) : vérifié | Non / non | aucun publié | **réseau routier national non concédé** (routes nationales, autoroutes non concédées) | fichier agrégé de 2,7 Mo, régénéré environ toutes les heures (vérifié : publication 26 min avant mon test) | **Non** : XML, aucun en-tête CORS, donc pipeline | **Retenue** |
| **Bison Futé / DIR, QTV** (vitesses et débits toutes les 6 min) + fichier de référence avec coordonnées Lambert-93 | vitesse moyenne par station, d'où des niveaux de trafic | Oui, Licence Ouverte 2.0 : vérifié | Non / non | aucun publié | mêmes réseaux (1 397 stations, 764 exploitables avec mesure) | publication toutes les 6 min (vérifié) | **Non** (XML + CORS), donc pipeline | **Retenue** |
| Bison Futé / DIR, TRAFICOLOR (états fluide / ralenti / saturé par agglomération) | état par site, **sans géométrie** dans les fichiers lus | Oui | Non | n.d. | une quinzaine d'agglomérations | 1 à 6 min | Non | Écartée (pas de géométrie exploitable : table de sites introuvable) |
| Bison Futé, concessionnaires (Action b/c, QTV-SCA) | événements et trafic des **autoroutes concédées** | **Non** : accès restreint par identifiants (vérifié) | identifiants à demander | n.d. | autoroutes concédées (A10, A7…) | n.d. | n.d. | **Impossible gratuitement** |
| **Bordeaux Métropole**, « État du trafic en temps réel » | 687 segments géolocalisés FLUIDE / DENSE / EMBOUTEILLE | Oui, Licence Ouverte : vérifié | Non / non | limites Opendatasoft standard | métropole de Bordeaux + rocade | 1 min annoncée (vérifié : mise à jour 8 min avant mon test) | **Oui** (`Access-Control-Allow-Origin: *` vérifié) | **Retenue** (locale, interrogée seulement sur la zone) |
| Autres métropoles (Lyon, Toulouse, Strasbourg, Lille…) | n.d. | n.d. | n.d. | n.d. | n.d. | n.d. | n.d. | Aucun jeu temps réel avec géométrie trouvé sur transport.data.gouv.fr (non vérifié portail par portail) |
| **TomTom Traffic API** | flux (tuiles vectorielles ou raster), incidents | Page tarifaire : offre gratuite **sans carte bancaire**, 200 000 requêtes de tuiles par mois, 2 500 requêtes incidents par mois, 20 000 segments par mois (vérifié sur docs.tomtom.com/pricing). Des sources secondaires parlent de quotas journaliers : contradiction non levée | **Clé requise** | voir ci-contre ; comportement au dépassement (blocage ou facturation) **non vérifié** | monde | temps réel | Non (clé), donc proxy Worker | **Préparée, non activée** (voir §4) |
| **Lufop** | radars / zones | Site inaccessible (HTTP 403) ; **aucune API ni licence connue** | n.d. | n.d. | France | n.d. | n.d. | **Non utilisée** (réutilisation non autorisée tant qu'aucune licence n'est confirmée) |
| **Waze** (alertes, ralentissements) | communautaire | **Non** : les conditions interdisent l'accès automatisé, la constitution d'une base et l'intégration à un autre service sans accord écrit (vérifié) | n.d. | n.d. | monde | temps réel | n.d. | **Interdite** |
| OpenStreetMap `highway=speed_camera` | points d'équipements | ODbL (attribution + partage à l'identique) | Non | n.d. | France | variable | n.d. | Utilisée **uniquement** pour des zones décalées (voir §3) |
| Signalements communautaires | n.d. | nécessite un serveur, une base et de la modération | n.d. | n.d. | n.d. | n.d. | n.d. | **Non implémenté** (pas de solution fiable à 0 €, risque juridique de modération) |

## 2. Architecture retenue

```
 Bison Futé (DATEX II, XML, sans CORS)     Bordeaux Métropole (JSON, CORS ouvert)     [TomTom via Worker, optionnel]
              │ toutes les ~10 min                        │ direct, seulement sur la zone          │
   GitHub Actions : tools/build-traffic.js                │                                        │
   → events.json, flow.json (branche `data`, HTTPS + CORS, cache 5 min)                            │
              └───────────────────────────┬───────────────┴────────────────────────────────────────┘
                              traffic.js (navigateur) : registre de sources → normalisation → priorité → déduplication
                              → couches MapLibre indépendantes (flux, événements, zones) → alertes et comparaison d'itinéraires
```

- **Pourquoi un pipeline** : les flux Bison Futé sont en XML (2,7 Mo + 1,4 Mo), sans CORS, et leur conversion (Lambert-93, niveaux, filtrage des événements terminés) n'a pas sa place dans une voiture. Le résultat fait environ 90 + 70 Ko. Coût : 0 € (dépôt public, GitHub Actions gratuit).
- **Fréquences** : événements 5 min, flux 6 min, Bordeaux 3 min ; uniquement page visible et réseau disponible ; jamais au déplacement de la carte ; le cache HTTP du navigateur (5 min) est respecté. En cas d'erreur : 2, 4, 8… 30 min. Le trafic de Bordeaux n'est demandé que lorsque la carte est sur la métropole.
- **Priorité et déduplication** : priorité 1 Bison Futé, 2 Bordeaux ; les segments « DIRA » de Bordeaux (déjà dans Bison Futé) sont ignorés ; deux événements de même catégorie à moins de 150 m sont fusionnés, la source prioritaire l'emporte.
- **Fraîcheur** : l'âge affiché est celui de la **publication de la source**, pas du téléchargement. Trafic de plus de 30 min (Bordeaux : 15 min) : **masqué**. Événements de plus de 3 h : masqués. La carte « Circulation » indique l'état de chaque source (vert, orange ou rouge).
- **Secours** : si une source tombe, les autres continuent ; si toutes tombent, la carte, le guidage et la météo fonctionnent normalement. Si le workflow s'arrête, les données vieillissent et disparaissent de l'affichage au lieu d'être présentées comme actuelles.

### Niveaux de circulation (calculés, pas fournis)
La source ne fournit que des **vitesses moyennes** mesurées. Seuils : autoroutes et rocades (axe « A… ») fluide ≥ 70 km/h, ralenti 45–70, dense 25–45, saturé < 25 ; autres routes 45 / 30 / 15. Ce sont des seuils propres à NAVIA, sans limitation de vitesse connue par tronçon : à affiner. Les deux sens de circulation partagent la même géométrie (les sens des stations ne sont pas fiables dans les fichiers) : le tronçon le plus dégradé est dessiné au-dessus. Les tronçons sont des cordes entre deux points de mesure (médiane d'environ 1 km), pas la géométrie exacte de la route.

## 3. Zones de vigilance et réglementation

- **Vérifié** (Légifrance) : l'article R413-15 du code de la route vise aussi « les dispositifs ou produits visant à avertir ou informer de la localisation » des appareils de contrôle (alinéa V) ; amende de 5ᵉ classe, saisie, retrait de 6 points, suspension possible du permis.
- **Non vérifié** : le régime des « zones de danger » (arrêté de 2012) et les longueurs minimales de zone. J'ai retenu des zones de 2 km (limitation ≤ 70 km/h) ou de 4 km, valeurs rapportées par la presse en 2025 : **à confirmer sur le texte officiel**.
- **Ce que fait NAVIA** : aucune icône d'équipement, aucune mention de « radar », aucune position précise. Les données publiées ([zones.json](../zones.json)) sont des cercles dont le **centre est décalé** de 20 à 60 % du rayon (déterministe, voir [tools/build-zones.js](../tools/build-zones.js)) ; alerte générique « Zone de danger » à l'approche (visuelle, vocale désactivable). Le fichier de points exacts n'est plus dans le dépôt, mais il reste dans l'historique Git : le purger demanderait de réécrire l'historique.
- Ce n'est **pas un avis juridique** : l'utilisateur reste responsable de la conformité de son usage.
- Les événements ponctuels (accident, obstacle, animaux, neige, travaux) sont des informations de sécurité routière publiées par l'État, sans lien avec les appareils de contrôle.

## 4. TomTom (optionnel, non activé)
[worker/traffic-proxy.js](../worker/traffic-proxy.js) montre comment garder la clé côté serveur et mettre les tuiles en cache (compte Cloudflare gratuit + clé TomTom gratuite, sans carte bancaire d'après la page tarifaire). **Je ne l'ai pas testé** (aucune clé) et je n'ai pas pu lire les conditions d'utilisation (affichage sur une carte non TomTom, cache, usage en véhicule) : ne l'activer qu'après lecture. Le registre de sources de `traffic.js` est prêt à recevoir une source de plus ; la couche TomTom elle-même n'est pas branchée.

## 5. Limites à connaître
- **Autoroutes concédées** (la majorité des autoroutes françaises) : ni événements ni trafic gratuits.
- **Villes** : seule la métropole de Bordeaux a un trafic détaillé ; ailleurs, seuls les axes nationaux mesurés.
- **Événements** : au plus une heure de retard ; certains sont des mesures d'exploitation (alternats, basculements) plutôt que des dangers.
- **Retard sur l'itinéraire** : estimation (vitesse mesurée contre vitesse de référence de 90 ou 50 km/h) sur les seuls tronçons mesurés ; jamais présentée comme une mesure.
- **Changement d'itinéraire** : jamais automatique ; l'alternative n'est proposée que si le gain estimé atteint 3 min.

## 6. Exploitation
- Pipeline : `npm install && npm run build:traffic` (écrit `out/`), puis `bash tools/publish-data.sh out` (publie la branche `data`).
- Planification : `.github/workflows/traffic.yml` (toutes les 10 min). GitHub peut retarder les exécutions planifiées et les désactive après 60 jours sans activité du dépôt.
- Essai local : ajouter `?tbase=/out/` à l'adresse pour lire `out/` au lieu de la branche `data`.
- Tests : `node tests/traffic.test.js`.
