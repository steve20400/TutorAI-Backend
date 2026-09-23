#!/usr/bin/env bash
#
# Restauration. À ESSAYER avant d'en avoir besoin.
#
#   ./restaurer.sh /var/sauvegardes/tutela/2026-09-23_02h00
#
# Le bon moment pour découvrir qu'une sauvegarde ne se restaure pas est un
# mardi après-midi, pas la nuit où le disque a lâché. Lancer ce script une
# fois par trimestre sur une machine d'essai fait la différence entre avoir
# des sauvegardes et croire en avoir.

set -euo pipefail

DOSSIER="${1:-}"

if [[ -z "$DOSSIER" || ! -d "$DOSSIER" ]]; then
  echo "Usage : $0 <dossier-de-sauvegarde>"
  echo
  echo "Sauvegardes disponibles :"
  ls -1 "${DESTINATION:-/var/sauvegardes/tutela}" 2>/dev/null | sed 's/^/  /' || echo "  aucune"
  exit 1
fi

echo "⚠  Cette opération REMPLACE la base actuelle par celle de $DOSSIER"
echo "   Tout ce qui a été écrit depuis cette sauvegarde sera perdu."
read -r -p "   Taper RESTAURER pour confirmer : " reponse
[[ "$reponse" == "RESTAURER" ]] || { echo "Annulé."; exit 1; }

# Le service s'arrête pendant la restauration : le laisser tourner, c'est
# écrire dans une base qu'on est en train de remplacer.
echo "Arrêt du service…"
docker compose stop service 2>/dev/null || true

echo "Restauration de la base…"
docker compose exec -T db pg_restore \
  --username=postgres \
  --dbname=postgres \
  --clean \
  --if-exists \
  --no-owner \
  < "$DOSSIER/base.dump"

echo "Restauration des fichiers…"
docker compose exec -T storage tar xzf - -C / < "$DOSSIER/fichiers.tar.gz"

echo "Redémarrage…"
docker compose start service

echo
echo "Fait. À vérifier maintenant, dans cet ordre :"
echo "  1. Se connecter avec un compte connu"
echo "  2. Ouvrir un dossier de répétiteur et consulter une pièce"
echo "  3. Lancer supabase/tests/rls.sql — 52 vérifications attendues"
echo
echo "Si les trois passent, la restauration est bonne. Si la troisième échoue,"
echo "les politiques n'ont pas suivi : les données sont là mais plus personne"
echo "n'est protégé, ce qui est pire qu'une base vide."
