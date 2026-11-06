# Mesures de fluidité (banc reproductible)

Outils : [perf-harness.js](perf-harness.js) (mesures dans la page) et [perf-run.js](perf-run.js) (pilote un Chromium/Edge via `puppeteer-core`, gratuit, installé hors dépôt).

```bash
npm i puppeteer-core            # dans un dossier hors dépôt
NODE_PATH=<dossier>/node_modules BASE=http://localhost:8080 SCEN=follow,zoom,rotate node tests/perf-run.js ma-serie
# proxys de matériel faible : SOFT=1 (GPU logiciel, limite liée au GPU)  CPU=4 (processeur ralenti ×4, limite liée au fil principal)
```

Mesuré : intervalle réel entre images (FPS, p95), temps JS d'un rendu MapLibre, temps JS de la boucle d'animation de l'app, tâches longues (> 50 ms), mémoire JS après ramasse-miettes, nombre de tuiles. Le temps GPU n'est pas mesurable directement : il apparaît dans la cadence.

## Limites honnêtes
- **Ces mesures ne viennent pas de la Tesla.** Machine de test : GTX 1660 SUPER, 180 i/s plafonnés par l'écran virtuel. Les proxys SOFT et CPU×N encadrent un matériel faible mais ne le reproduisent pas ; l'objectif « 60 i/s / 30 i/s minimum » n'est donc **pas démontré sur la voiture**. La page Réglages affiche la cadence réellement mesurée en roulant et le palier de qualité : c'est la mesure à relever sur la Tesla.
- Le bruit entre séries est de ±25 % : toutes les comparaisons ci-dessous sont des médianes de 3 séries alternées (avant/après).

## État de référence (avant), machine de test, 1180×740
| Scénario | FPS | Remarque |
|---|---|---|
| Suivi GPS en navigation | 180 | rendu JS ≈ 2,3 ms/image, aucune tâche longue |
| Immobile, sans navigation | 180 | **0 rendu** : la carte ne se redessine pas au repos |
| Glisser / zoom / rotation + inclinaison | 180 / 179 / 168 | p95 11 ms en rotation |
| CPU ×4 : suivi / glisser / zoom / rotation | 80 / 97 / 69 / 45 | rotation : 14 tâches longues, 936 ms bloquées |
| GPU logiciel : suivi / zoom / rotation | 13 / 20 / 17 | limite liée au GPU |
| Mémoire (tas JS après GC, 2 min de navigation) | 155 – 275 Mo | proportionnelle aux tuiles chargées (40 à 167), pas de fuite (nœuds DOM stables) |

Goulots identifiés par expériences isolées (GPU logiciel) : les bâtiments 3D coûtent 2,2× (13,9 → 30,7 i/s en les masquant) ; l'opacité 0,96 des extrusions force un double passage de dessin (opaque : +29 %) ; le flou CSS et les étiquettes pèsent peu en GPU, les étiquettes pèsent côté CPU. Profil à 1× : le fil principal est dominé par la soumission des appels de dessin (≈ 116 couches × 100 à 160 tuiles), pas par un calcul isolé.

## Après optimisation (médianes de 3 séries alternées)
| Scénario | Avant | Après |
|---|---|---|
| GPU logiciel : suivi GPS, FPS (p95) | 13,6 (83 ms) | **19,9** (56 ms) |
| GPU logiciel : zoom | 12,9 (156 ms) | **22,9** (83 ms) |
| GPU logiciel : rotation + inclinaison | 15,1 (145 ms) | **29,4** (67 ms) |
| GPU logiciel : tâches longues en zoom / rotation | 713 / 927 ms | 185 / 353 ms |
| CPU ×6 (suivi / zoom / rotation) | 41 / 17,7 / 31,4 | 40,7 / 17,6 / 31,4 : **inchangé** |
| Mémoire (tas après GC) | 155 – 275 Mo | 169 – 271 Mo : **inchangée** |

Ce qui a changé : bâtiments opaques (un passage de dessin au lieu de deux), `crossSourceCollisions` désactivé, qualité adaptative par paliers ([quality.js](../quality.js)), un seul recalage du marqueur par image, rejet des positions GPS impossibles (> 324 km/h), reprise après veille / perte de réseau / contexte WebGL perdu.

Ce qui n'a **pas** changé : le coût côté processeur (soumission des appels de dessin) reste identique, et la mémoire aussi. Pistes restantes, non faites car elles modifieraient le rendu : fusionner des couches de routes, limiter l'horizon des tuiles.

Les 116 couches, bâtiments 3D, bornes, radars, ronds-points, itinéraire et météo sont tous présents après optimisation (contrôle automatique : même nombre de couches, aucune erreur de page).
