import type { FastifyInstance, FastifyRequest } from "fastify"

import { configurationDuTuteur } from "../../ia/configuration.js"
import { ErreurIA, parler, type Message } from "../../ia/index.js"
import { PROMPT_TUTEUR } from "../../tuteur/prompt.js"
import { supabasePour } from "../../supabase.js"

/**
 * Essayer le tuteur sans compte.
 *
 * Quelqu'un entend parler de TUTELA et veut voir. On lui ouvre la porte sans
 * rien lui demander — et c'est le seul endroit de la plateforme où un visiteur
 * anonyme fait dépenser de l'argent.
 *
 * Rien de la conversation n'est gardé : elle vit dans son navigateur, il la
 * renvoie à chaque message, et elle disparaît avec l'onglet. C'est dit sur
 * l'écran avant qu'il ne commence, pas après vingt minutes de travail perdu.
 *
 * Ce qui est gardé, c'est uniquement le compteur de jetons — sans lui, une
 * seule personne viderait un crédit en une nuit.
 */

/** Plafond de sortie par réponse. */
const JETONS_PAR_REPONSE = 1200

/**
 * L'historique vient du navigateur, donc de quelqu'un qu'on ne connaît pas.
 * Sans borne, il suffirait d'en envoyer un énorme pour faire payer cher un
 * seul appel.
 */
const HISTORIQUE_MAX = 30
const CARACTERES_MAX = 12_000

/** L'adresse telle que Render la transmet, à défaut celle de la connexion. */
function adresseDe(requete: FastifyRequest): string {
  const transmise = requete.headers["x-forwarded-for"]
  if (typeof transmise === "string" && transmise.length > 0) {
    return transmise.split(",")[0]!.trim()
  }
  return requete.ip
}

export async function routesEssai(app: FastifyInstance): Promise<void> {
  app.post(
    "/essai",
    {
      schema: {
        tags: ["essai"],
        summary: "Ouvrir un essai sans compte",
      },
    },
    async (requete, reponse) => {
      const { data, error } = await supabasePour(requete).rpc("ouvrir_essai", {
        adresse: adresseDe(requete),
      })

      if (error) {
        const trop = error.code === "53400"
        requete.log.warn({ error }, "essai refuse")
        return reponse.code(trop ? 429 : 403).send({
          erreur: trop ? "trop_d_essais" : "essai_refuse",
          message: error.message,
        })
      }

      const ligne = (data as Array<{
        id: string
        jetons_restants: number
        expire_le: string
      }> | null)?.[0]

      if (!ligne) {
        return reponse.code(503).send({
          erreur: "essai_indisponible",
          message: "L'essai n'est pas disponible pour le moment.",
        })
      }

      return {
        id: ligne.id,
        jetonsRestants: ligne.jetons_restants,
        expireLe: ligne.expire_le,
      }
    },
  )

  app.post(
    "/essai/:id/message",
    {
      schema: {
        tags: ["essai"],
        summary: "Écrire au tuteur d'essai",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["contenu"],
          properties: {
            contenu: { type: "string", minLength: 1, maxLength: 2000 },
            historique: {
              type: "array",
              maxItems: HISTORIQUE_MAX,
              items: {
                type: "object",
                required: ["role", "contenu"],
                properties: {
                  role: { type: "string", enum: ["utilisateur", "tuteur"] },
                  contenu: { type: "string", maxLength: 4000 },
                },
              },
            },
          },
        },
      },
    },
    async (requete, reponse) => {
      const { id } = requete.params as { id: string }
      const { contenu, historique = [] } = requete.body as {
        contenu: string
        historique?: Message[]
      }
      const supabase = supabasePour(requete)

      // On réserve avant d'appeler : vérifier puis appeler laisserait passer
      // deux requêtes simultanées sur le dernier jeton. Zéro ajouté ici, on
      // ajuste après la réponse.
      const { error: erreurBudget } = await supabase.rpc("consommer_essai", {
        essai: id,
        jetons_ajoutes: 0,
      })

      if (erreurBudget) {
        return reponse.code(429).send({
          erreur: "essai_termine",
          message: erreurBudget.message,
        })
      }

      let config
      try {
        config = await configurationDuTuteur(Date.now())
      } catch {
        return reponse.code(503).send({
          erreur: "tuteur_non_configure",
          message: "Le tuteur n'est pas disponible.",
        })
      }

      const messages: Message[] = [
        ...historique.slice(-HISTORIQUE_MAX),
        { role: "utilisateur", contenu },
      ]

      // Une borne de plus que le schéma : trente messages de quatre mille
      // caractères feraient cent vingt mille caractères.
      let total = 0
      const retenus = messages.filter((m) => {
        total += m.contenu.length
        return total <= CARACTERES_MAX
      })

      reponse.hijack()
      reponse.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      })

      const envoyer = (o: unknown): void => {
        reponse.raw.write(`data: ${JSON.stringify(o)}\n\n`)
      }

      try {
        const flux = parler(
          {
            systeme: reglesDEssai(),
            messages: retenus,
            modele: config.modele,
            maxJetons: JETONS_PAR_REPONSE,
          },
          config,
        )

        for await (const m of flux) {
          if (m.type === "texte") {
            envoyer(m)
          } else {
            // Ce que ça a coûté, ajouté au compteur. La réponse du modèle est
            // la seule mesure fiable.
            const { data } = await supabase.rpc("consommer_essai", {
              essai: id,
              jetons_ajoutes: m.usage.entree + m.usage.sortie,
            })
            const reste = (data as Array<{ jetons_restants: number }> | null)?.[0]
            envoyer({ type: "fin", jetonsRestants: reste?.jetons_restants ?? 0 })
          }
        }
      } catch (e) {
        const code = e instanceof ErreurIA ? e.code : "autre"
        requete.log.error({ e, code }, "essai : appel du tuteur echoue")
        envoyer({ type: "erreur", code })
      }

      reponse.raw.end()
    },
  )
}

/**
 * Les règles, sans élève ni programme.
 *
 * Le tuteur d'essai ne sait ni à qui il parle, ni en quelle classe, ni quel
 * programme suit cette classe. Il le dit plutôt que de faire semblant — et il
 * demande, ce qui est de toute façon sa manière de travailler.
 */
function reglesDEssai(): string {
  return (
    PROMPT_TUTEUR.replaceAll("{{PRENOM_ELEVE}}", "l'élève")
      .replaceAll("{{NIVEAU}}", "inconnu pour l'instant")
      .replaceAll("{{PAYS}}", "CM")
      .replaceAll("{{MATIERE}}", "toutes matières") +
    "\n\n---\n\n## Essai sans compte\n\n" +
    "Tu ne sais rien de la personne qui t'écrit : ni son prénom, ni sa " +
    "classe, ni son programme officiel. Demande-lui sa classe et ce qu'elle " +
    "travaille dès ta première réponse, en une phrase, puis pars de là.\n\n" +
    "N'invente jamais une progression officielle que tu n'as pas.\n\n" +
    "Cet essai est court. Va droit au but : une idée, une question."
  )
}
