# Déménager, étape par étape

Compter une journée, un samedi de préférence : le trafic est nul et le lundi
laisse le temps de revenir en arrière.

## Avant de commencer

Sur le serveur : Docker, Docker Compose, Nginx, et un certificat par
sous-domaine (`certbot --nginx -d api.tutela.cm -d service.tutela.cm -d tutela.cm`).

Les trois sous-domaines doivent déjà pointer vers l'adresse IP du serveur :
la propagation DNS prend quelques heures, et l'attendre le jour J est la
meilleure façon de perdre la journée.

## 1. Installer Supabase

```bash
git clone --depth 1 https://github.com/supabase/supabase
cp -r supabase/docker /opt/tutela/supabase
cd /opt/tutela/supabase
cp .env.example .env      # puis remplir avec deploiement/.env.exemple
docker compose up -d
```

Vérifier que les huit services tournent : `docker compose ps`.
Un seul en erreur suffit à faire échouer tout le reste plus tard, de façon
difficile à relier à sa cause.

## 2. Rejouer le schéma

Les 22 migrations, **dans l'ordre**. Chacune suppose que la précédente a eu
lieu : la 012 corrige une politique posée en 010, la 019 lit une colonne
ajoutée en 018.

```bash
for f in WEB/supabase/migrations/*.sql; do
  echo "→ $f"
  psql "$NOUVELLE_BASE" -v ON_ERROR_STOP=1 -f "$f" || break
done
```

`ON_ERROR_STOP=1` est important : sans lui, psql continue après une erreur et
laisse une base à moitié construite, ce qui se découvre des semaines plus tard.

## 3. Vérifier AVANT de copier les données

```bash
psql "$NOUVELLE_BASE" -f WEB/supabase/tests/rls.sql
```

52 vérifications attendues, zéro échec. Les faire tourner sur une base vide
prouve que les politiques sont en place — et c'est le seul moment où l'on peut
encore corriger sans avoir de données à reprendre.

## 4. Copier les données

```bash
# Depuis Supabase hébergé
pg_dump "$ANCIENNE_BASE" --format=custom --no-owner > tutela.dump

# Vers la nouvelle
pg_restore --dbname="$NOUVELLE_BASE" --no-owner --data-only tutela.dump
```

`--data-only` : le schéma vient des migrations, pas du dump. Mélanger les deux
donne une base dont personne ne sait plus d'où vient la structure.

Les fichiers du bucket `pieces` se copient depuis le tableau de bord Supabase,
ou avec leur CLI.

## 5. Basculer

Changer les variables, puis redémarrer :

| où | variable | nouvelle valeur |
|---|---|---|
| service | `SUPABASE_URL` | `https://api.tutela.cm` |
| service | `SUPABASE_CLE_PUBLIABLE` | `ANON_KEY` du nouveau `.env` |
| site | `NEXT_PUBLIC_SUPABASE_URL` | `https://api.tutela.cm` |
| site | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | la même `ANON_KEY` |
| site | `API_URL` | `https://service.tutela.cm` |

## 6. Vérifier pour de bon

Dans cet ordre, et en s'arrêtant au premier qui échoue :

1. Se connecter avec un compte connu
2. Ouvrir l'espace d'administration, voir la carte et les chiffres
3. Ouvrir un dossier de répétiteur, consulter une pièce
4. Ouvrir une famille, vérifier que les séances sont comptées
5. Relancer `rls.sql` sur la base **avec** ses données

## Le retour en arrière

Tant que l'ancienne base existe, revenir consiste à remettre les anciennes
variables. **Ne pas supprimer le projet Supabase avant deux semaines de
fonctionnement normal** — c'est le seul filet, et il ne coûte rien à garder.

## Ce qui ne se déménage pas

**Les comptes d'authentification** sont dans `auth.users`, un schéma géré par
GoTrue. Le dump les emporte, mais les jetons en cours deviennent invalides :
tout le monde devra se reconnecter. Prévenir avant, plutôt que de laisser
croire à une panne.

**Les mots de passe** suivent, ils sont hachés dans la table. Personne n'a à
en changer.
