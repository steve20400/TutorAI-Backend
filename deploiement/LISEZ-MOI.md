# Héberger TUTELA sur son propre serveur

Ce dossier contient de quoi déménager la plateforme depuis Supabase et Render
vers une machine à soi. Rien ici n'est nécessaire aujourd'hui : c'est écrit
pour le jour où ce sera utile, et pour que ce jour-là on n'improvise pas.

## Ce que ça change dans le code

**Rien.** Aucune adresse n'est écrite en dur, ni dans le site ni dans le
service. Six variables d'environnement suffisent à tout rediriger, et les
22 migrations rejouent le schéma entier sur une base vide.

C'est la seule raison pour laquelle ce déménagement est une journée de travail
et non une réécriture.

## Nginx et Docker ne font pas la même chose

Nginx reçoit les requêtes, gère le HTTPS et distribue selon le nom de domaine.
Docker fait tourner les logiciels.

Supabase n'est pas un programme mais huit : Postgres, GoTrue pour
l'authentification, PostgREST pour l'API, Storage pour les fichiers, Realtime,
un routeur interne, un service d'images, un service de métadonnées. Les
installer un par un demande une semaine, et chaque mise à jour redevient un
chantier. Docker les assemble et les met à jour ensemble.

Donc : **Nginx devant, Docker derrière**.

```
Internet → Nginx (443, TLS)
             ├── api.tutela.cm      → Supabase (Docker, port 8000)
             ├── service.tutela.cm  → le service Tuteurs (Node, port 3001)
             └── tutela.cm          → le site Next.js (port 3000)
```

## L'ordre des opérations

Déménager la base et le service le même jour, c'est se priver de tout point de
comparaison quand quelque chose ne marche plus.

1. **Le service d'abord.** Il est sans état : un redémarrage ne perd rien, et
   un retour en arrière est immédiat. Il continue de parler à Supabase hébergé.
2. **La base ensuite**, quand les sauvegardes tournent et qu'on les a testées
   en restaurant pour de vrai — une sauvegarde jamais restaurée n'est pas une
   sauvegarde, c'est une intention.
3. **Le site en dernier**, ou jamais : Vercel le sert bien et gratuitement.

## Ce qu'il faudra assumer

Ce que Supabase fait aujourd'hui sans qu'on y pense :

- **Les sauvegardes**, toutes les nuits, et surtout leur restauration
- **Les mises à jour de sécurité** de Postgres et des huit services
- **Les certificats TLS** et leur renouvellement
- **La disponibilité** — personne ne redémarre le serveur à trois heures du
  matin
- **Le courrier** — un SMTP avec SPF et DKIM, faute de quoi les messages
  partent en indésirable

Sur un produit où des familles confient leurs enfants, perdre la base c'est
perdre les enregistrements de séances et les pièces qui prouvent qu'une
vérification a eu lieu. C'est-à-dire perdre exactement ce qu'on leur a promis.

**Ne pas déménager avant d'avoir des utilisateurs réels n'a pas de sens ; ne
pas déménager tant que les sauvegardes ne sont pas testées en a beaucoup.**

## Les fichiers

| fichier | ce qu'il fait |
|---|---|
| `docker-compose.yml` | les huit services de Supabase, plus le service Tuteurs |
| `nginx.conf` | le routage et le TLS |
| `.env.exemple` | les variables à remplir |
| `sauvegarde.sh` | la sauvegarde nocturne, base et fichiers |
| `restaurer.sh` | la restauration, à tester AVANT d'en avoir besoin |
| `demenager.md` | la procédure, étape par étape |
