#!/usr/bin/env bash
# Publie les JSON de trafic (dossier $1, défaut out/) sur la branche orpheline `data` du dépôt (un seul commit, remplacé à chaque fois : pas d'historique).
# Utilisé par GitHub Actions (GITHUB_TOKEN) et utilisable à la main : bash tools/publish-data.sh out
set -euo pipefail
src="${1:-out}"; remote="${DATA_REMOTE:-$(git remote get-url origin)}"
tmp="$(mktemp -d)"; cp "$src"/*.json "$tmp"/
cd "$tmp"; git init -q; git checkout -q -b data
git -c user.name="navia-traffic-bot" -c user.email="noreply@users.noreply.github.com" add -A
git -c user.name="navia-traffic-bot" -c user.email="noreply@users.noreply.github.com" commit -q -m "Données trafic $(date -u +%Y-%m-%dT%H:%MZ)"
git push -q -f "$remote" data
echo "publié sur la branche data"
