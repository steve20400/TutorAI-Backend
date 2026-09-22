import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import WebSocketNode from "ws"
import type { FastifyReply, FastifyRequest } from "fastify"
import { config } from "./config.js"

/**
 * `WebSocket` global, pour les versions de Node qui n'en ont pas.
 *
 * `@supabase/supabase-js` charge son module temps réel au démarrage, même
 * quand on ne s'en sert pas — et ce module exige un `WebSocket` global, que
 * Node ne fournit qu'à partir de la 22. Sans cette ligne, TOUTES les routes
 * répondent 500 avec « Node.js detected but native WebSocket », une erreur qui
 * ne dit rien du vrai problème.
 *
 * Ce n'est pas une précaution théorique : le `package.json` déclare
 * `"node": ">=20"`, et Node 20 est précisément dans ce cas. Le service serait
 * tombé au premier déploiement, sur chaque appel.
 */
if (typeof globalThis.WebSocket === "undefined") {
  ;(globalThis as { WebSocket?: unknown }).WebSocket = WebSocketNode
}

/**
 * Un client par requête, et jamais un de plus. Les WeakMap se vident d'elles-
 * mêmes quand la requête est collectée : rien à nettoyer, aucune fuite.
 */
const clientsParRequete = new WeakMap<FastifyRequest, SupabaseClient>()
const utilisateursParRequete = new WeakMap<FastifyRequest, string>()

/**
 * Client Supabase agissant **au nom de l'appelant**, jamais au nom du service.
 *
 * C'est le cœur de l'architecture, et la raison pour laquelle ce back-end peut
 * vivre dans un dépôt séparé sans affaiblir la sécurité : il ne décide de
 * rien. Il transporte l'identité de l'appelant jusqu'à Postgres, qui seul
 * décide de ce que cette personne a le droit de voir.
 *
 * La clé utilisée est la clé publiable. Le jour où quelqu'un la remplacerait
 * par la clé secrète pour « débloquer » une requête, toutes les protections
 * des élèves sauteraient d'un coup, et en silence.
 */
export function supabasePour(requete: FastifyRequest): SupabaseClient {
  const deja = clientsParRequete.get(requete)
  if (deja) return deja

  const autorisation = requete.headers.authorization

  const client = createClient(config.supabase.url, config.supabase.clePubliable, {
    global: { headers: autorisation ? { Authorization: autorisation } : {} },
    // Un serveur sans navigateur : rien à stocker, rien à rafraîchir.
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })

  clientsParRequete.set(requete, client)
  return client
}

/**
 * À placer en `preHandler` sur toute route réservée.
 *
 * On ne se contente pas de vérifier qu'un en-tête existe : on demande à
 * Supabase qui est cet utilisateur. Un jeton expiré ou fabriqué échoue ici,
 * pas trois requêtes plus loin.
 */
export async function exigerSession(
  requete: FastifyRequest,
  reponse: FastifyReply,
): Promise<void> {
  const { data, error } = await supabasePour(requete).auth.getUser()

  if (error || !data.user) {
    return reponse.code(401).send({
      erreur: "non_authentifie",
      message: "Connecte-toi pour accéder à cette ressource.",
    })
  }

  utilisateursParRequete.set(requete, data.user.id)
}

/**
 * Identifiant de la personne connectée.
 *
 * Lève si `exigerSession` n'a pas tourné avant : c'est une erreur de câblage
 * du développeur, pas une situation d'exécution. Mieux vaut un plantage franc
 * au premier essai qu'une route qu'on croit protégée et qui ne l'est pas.
 */
export function utilisateurDe(requete: FastifyRequest): string {
  const id = utilisateursParRequete.get(requete)
  if (!id) {
    throw new Error(
      "utilisateurDe() appelé sans exigerSession en preHandler — la route n'est pas protégée.",
    )
  }
  return id
}
