#!/usr/bin/env bash
#
# Sauvegarde nocturne : la base et les fichiers.
#
# À lancer par cron, chaque nuit :
#   0 2 * * * /opt/tutela/deploiement/sauvegarde.sh >> /var/log/tutela-sauvegarde.log 2>&1
#
# Ce qu'on sauvegarde n'est pas « des données » : ce sont les enregistrements
# de séances entre un adulte et un enfant, et les pièces d'identité qui
# prouvent qu'une vérification a eu lieu. Les perdre, c'est perdre exactement
# ce qu'on a promis aux familles.
#
# Une sauvegarde jamais restaurée n'est pas une sauvegarde, c'est une
# intention. Voir restaurer.sh, et l'essayer AVANT d'en avoir besoin.

set -euo pipefail

DESTINATION="${DESTINATION:-/var/sauvegardes/tutela}"
JOURS_CONSERVES="${JOURS_CONSERVES:-30}"
HORODATAGE="$(date +%Y-%m-%d_%Hh%M)"
DOSSIER="$DESTINATION/$HORODATAGE"

mkdir -p "$DOSSIER"

echo "[$(date)] Sauvegarde vers $DOSSIER"

# ── La base ─────────────────────────────────────────────────────────────────
# `--clean` pour que la restauration reparte d'une base propre, sans mélanger
# l'ancien et le nouveau. Le format personnalisé permet de restaurer une seule
# table si besoin, ce qu'un fichier SQL brut ne permet pas.
docker compose exec -T db pg_dump \
  --username=postgres \
  --format=custom \
  --clean \
  --if-exists \
  postgres > "$DOSSIER/base.dump"

echo "  base : $(du -h "$DOSSIER/base.dump" | cut -f1)"

# ── Les fichiers ────────────────────────────────────────────────────────────
# Les pièces justificatives et les enregistrements. Sans eux, une base
# restaurée renverrait des liens vers des fichiers qui n'existent plus — et
# une pièce manquante ne se voit qu'au moment où on la cherche.
docker compose exec -T storage tar czf - /var/lib/storage \
  > "$DOSSIER/fichiers.tar.gz" 2>/dev/null

echo "  fichiers : $(du -h "$DOSSIER/fichiers.tar.gz" | cut -f1)"

# ── Vérification immédiate ──────────────────────────────────────────────────
# Une archive illisible se découvre normalement le jour de la panne. On le
# découvre ici, une minute après l'avoir écrite.
if ! docker compose exec -T db pg_restore --list < "$DOSSIER/base.dump" > /dev/null 2>&1; then
  echo "  ⚠ L'archive de la base est ILLISIBLE — sauvegarde inutilisable"
  exit 1
fi
echo "  archive vérifiée : lisible"

# ── Rotation ────────────────────────────────────────────────────────────────
find "$DESTINATION" -maxdepth 1 -type d -mtime "+$JOURS_CONSERVES" -exec rm -rf {} +

echo "[$(date)] Terminé. $(ls -1 "$DESTINATION" | wc -l) sauvegardes conservées."
echo
echo "  Rappel : une copie hors du serveur reste nécessaire. Un disque qui"
echo "  meurt emporte la base ET ses sauvegardes s'ils sont au même endroit."
