# NAVIA — GPS pour Tesla Model Y (budget 0 €)

Application web 100 % statique (HTML/CSS/JS, aucun build, aucune clé d'API, aucune carte bancaire) conçue pour le navigateur de la Tesla.
Carte 3D, guidage vocal, limitations de vitesse, radars, bornes de recharge, météo en direct, et le panneau **Trajet** (comparateur, énergie VE, simulateur de vitesse, météo sur l'itinéraire, copilote).

Test sans GPS : `?sim=50&from=1.35,43.43` (conduite simulée, clairement activée par l'URL).

## Fonctionnalités

| Fonction | État | Source gratuite |
|---|---|---|
| Carte vectorielle 3D, jour/nuit auto, bâtiments, satellite | Opérationnel | OpenFreeMap (OSM), Esri World Imagery |
| Géolocalisation, recherche d'adresse, autocomplétion, favoris | Opérationnel | API Adresse/IGN, Photon |
| Itinéraire, guidage vocal, recalcul après déviation, ronds-points | Opérationnel | Valhalla (serveur public OSM) |
| Limitations de vitesse, radars fixes, alertes | Opérationnel | OSM via Valhalla, données radars OSM |
| Bornes de recharge (opérateur, puissance, prises) | Opérationnel | IRVE / ODRÉ (France) |
| **Itinéraires alternatifs + comparateur** (rapide / économique / confortable, péage, énergie, recharges, difficulté), tracés colorés sur la carte | Opérationnel | Valhalla `alternates` |
| **Énergie VE** : batterie saisie à la main, batterie estimée à l'arrivée, conso, marge, impacts relief / météo / vitesse, plan de recharge | Opérationnel (estimation) | Modèle `ev.js`, altitudes + météo Open-Meteo, bornes IRVE |
| **Simulateur de vitesse** 110 / 120 / 130 km/h + vitesse perso | Opérationnel (estimation) | Idem |
| **Météo sur le trajet** (T°, pluie, vent, rafales, neige, verglas, orage) à l'heure de passage | Opérationnel | Open-Meteo |
| **Copilote** : bornes rapides (+ restaurant), itinéraire économique, « puis-je arriver avec 20 % ? », compare 110/130, restaurant dans N km | Opérationnel, **local** (règles + données réelles), sans IA externe | Données NAVIA, Overpass (OSM) |
| Barre de progression du trajet, batterie estimée à l'arrivée | Opérationnel | — |

### Limites assumées (rien n'est simulé)

- **Trafic temps réel, incidents, travaux** : aucune source gratuite et fiable n'existe. Les durées sont « hors trafic » et le comparateur affiche *Trafic : n.d.* Pas de fausses couleurs de trafic.
- **Batterie réelle** : le navigateur de la voiture n'y a pas accès. Saisie manuelle (onglet Énergie). Une connexion à l'API Fleet Tesla officielle est possible plus tard, via un backend ; **ne jamais** saisir d'identifiants Tesla dans l'application ni exposer de clé dans le JS.
- **Disponibilité et tarifs des bornes en temps réel** : non fournis par les données ouvertes IRVE.
- **Guidage par voie** : Valhalla ne fournit pas les voies conseillées ; non affiché.
- **Modèle énergétique** : estimation physique (voir en-tête de `ev.js`), calée Model Y Grande Autonomie. Réglez « Calage conso » pour l'ajuster à votre consommation réelle. Ce n'est pas une mesure.
- **IA générative** : non intégrée (pas de service gratuit garanti sans facturation). Le copilote est un moteur d'intentions local. Une IA via un Worker serait une extension optionnelle ; ne jamais mettre de clé dans le navigateur.
- Couverture bornes/radars : France.

## Services externes, quotas et usage responsable

| Service | Usage | À savoir |
|---|---|---|
| OpenFreeMap | tuiles | gratuit, sans clé |
| Valhalla `valhalla1.openstreetmap.de` | routage, limites | serveur communautaire : pas de garantie. Une requête d'itinéraire + une d'attributs par trajet ; alternatives uniquement au départ. Prévoir une instance perso si usage intensif (`VALHALLA` / `VALHALLA_BASE` dans `app.js`) |
| Open-Meteo | météo, altitudes | gratuit non commercial, ~10 000 appels/jour ; position arrondie à 1 km |
| ODRÉ / data.gouv (IRVE) | bornes | ouvert, par tuiles de 0,1° mises en cache |
| Overpass (OSM) | restaurants du copilote | uniquement à la demande, miroir de secours, résultats mis en cache ; peut être saturé (le copilote le dit) |
| Photon / API Adresse / Nominatim policy | recherche | requêtes à la frappe espacées |

Données © contributeurs OpenStreetMap (ODbL), IGN, ODRÉ, Open-Meteo (CC BY 4.0). Attributions affichées sur la carte.

## Architecture

```
index.html   structure + hooks
style.css    thème, verre liquide, panneau NAVIA (fin du fichier)
app.js       carte, GPS, guidage, voix, météo/effets, bornes, radars (existant)
ev.js        modèle énergétique pur + planificateur de recharge (testable)
navia.js     panneau Trajet : comparateur, énergie, vitesse, météo, copilote
tests/       node tests/ev.test.js
```

`app.js` expose 3 points d'extension appelés par le guidage : `naviaRoute`, `naviaTick`, `naviaStop`.

## Développement

```bash
npx http-server . -p 8080 -c-1
node tests/ev.test.js
```

## Déploiement (gratuit)

Site statique : GitHub Pages (Settings → Pages → branche `main`, dossier racine) ou Cloudflare Pages (sans build, dossier racine). HTTPS inclus. Aucune variable d'environnement requise (voir `.env.example`). Ouvrir l'URL dans le navigateur de la Tesla ; l'écran reste allumé via Wake Lock quand il est supporté.

## Sécurité et vie privée

Voir [PRIVACY.md](PRIVACY.md). Aucune donnée personnelle envoyée à un serveur NAVIA : tout reste dans le navigateur (localStorage). Pas d'identifiants Tesla, pas de clé d'API.
