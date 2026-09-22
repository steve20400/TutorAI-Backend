# TUTELA — service Tuteurs (API)

API du service **Tuteurs** de la plateforme éducative camerounaise. Elle sert
l'application web (`TutorAI`), et plus tard l'application mobile ainsi que
l'application globale qui réunit les trois services.

```
Carte et logement   ─┐
Transparence écoles ─┼─→  application globale
Tuteurs (ce dépôt)  ─┘
```

## La règle qui tient tout

**Ce service ne décide de rien.**

Le client s'authentifie directement auprès de Supabase, reçoit un jeton, et
l'envoie ici dans l'en-tête `Authorization: Bearer …`. Le service retransmet ce
jeton à Postgres, qui applique ses politiques RLS. Les règles de protection des
élèves — un parent ne voit que son enfant, un répétiteur non vérifié
n'apparaît dans aucun annuaire — sont écrites **une seule fois**, dans
`supabase/schema.sql` du dépôt web, et testées dans `supabase/tests/rls.sql`.

Conséquence directe : ce dépôt n'utilise **que la clé publiable**. Il ne doit
jamais détenir la clé secrète. Le jour où quelqu'un la met dans
`SUPABASE_CLE_PUBLIABLE` pour « débloquer » une requête, toutes les
protections sautent d'un coup et en silence.

## Démarrer

```bash
cp .env.example .env     # puis remplir SUPABASE_CLE_PUBLIABLE
npm install
npm run dev
```

- API : http://localhost:3001
- Documentation OpenAPI : http://localhost:3001/documentation
- Sonde de vie : http://localhost:3001/sante

## Conventions, communes aux trois services

| | |
|---|---|
| Authentification | `Authorization: Bearer <jeton Supabase>` |
| Version | préfixe d'URL `/v1` |
| Erreurs | `{ "erreur": "code_machine", "message": "phrase lisible" }` |
| Pagination | `?page=1&parPage=20` — réponse `{ donnees, pagination }` |
| Dates | ISO 8601 en UTC |
| Langue | français, y compris dans le code |

Le contrat d'API n'est pas recopié dans le dépôt web : il est publié en
OpenAPI par ce service, et le client web en est généré. Un endpoint qui change
fait échouer la compilation du web.

## Déploiement

Render, service web Node.

| | |
|---|---|
| Build | `npm install && npm run build` |
| Start | `npm start` |
| Santé | `/sante` |

L'offre gratuite de Render met le service en veille après inactivité : c'est
acceptable tant qu'il n'y a que des requêtes HTTP, inacceptable dès que le
WebSocket arrivera.

## À venir

- WebSocket pour la messagerie parents ↔ répétiteurs
- Signalisation WebRTC et délivrance des jetons LiveKit
- Ouvrier d'enregistrement : rétention, chiffrement, suppression programmée
