import type { FastifyInstance } from "fastify"

import { exigerSession, supabasePour, utilisateurDe } from "../../supabase.js"

/**
 * Signaler qu'il se passe quelque chose.
 *
 * C'est la route la plus importante du service, et la plus permissive :
 * n'importe quel compte connecté peut déposer un signalement, sans avoir à
 * prouver un lien avec la séance. Demander une légitimité au moment de
 * l'alerte, c'est ajouter un obstacle là où il n'en faut aucun. Un signalement
 * infondé se classe ; un signalement qu'on n'a pas pu déposer ne se rattrape
 * pas.
 *
 * En revanche l'auteur ne peut ni le relire chez les autres, ni le retirer :
 * un répétiteur ayant obtenu un retrait sous pression ferait disparaître
 * l'alerte, et avec elle la trace qu'elle a existé. Seule l'administration
 * traite.
 */
export async function routesSignalements(app: FastifyInstance): Promise<void> {
  app.post(
    "/signalements",
    {
      preHandler: exigerSession,
      schema: {
        tags: ["signalements"],
        summary: "Déposer un signalement",
        security: [{ porteur: [] }],
        body: {
          type: "object",
          required: ["motif"],
          properties: {
            motif: { type: "string", minLength: 3, maxLength: 2000 },
            seanceId: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (requete, reponse) => {
      const { motif, seanceId } = requete.body as {
        motif: string
        seanceId?: string
      }

      const { data, error } = await supabasePour(requete)
        .from("signalements")
        .insert({
          auteur_id: utilisateurDe(requete),
          seance_id: seanceId ?? null,
          motif,
          statut: "ouvert",
        })
        .select("id, cree_le")
        .single()

      if (error) {
        // On journalise, mais on ne renvoie pas d'échec silencieux : quelqu'un
        // qui signale doit savoir si son alerte est partie.
        requete.log.error({ error }, "signalement non enregistre")
        return reponse.code(502).send({
          erreur: "signalement_non_enregistre",
          message:
            "Le signalement n'a pas pu être enregistré. Réessayez, et si " +
            "cela se reproduit, contactez directement l'administration.",
        })
      }

      return reponse.code(201).send(data)
    },
  )

  app.get(
    "/signalements",
    {
      preHandler: exigerSession,
      schema: {
        tags: ["signalements"],
        summary: "Mes signalements",
        description:
          "L'administration voit tous les signalements ; chacun ne voit " +
          "que les siens.",
        security: [{ porteur: [] }],
      },
    },
    async (requete, reponse) => {
      const { data, error } = await supabasePour(requete)
        .from("signalements")
        .select("id, seance_id, motif, statut, decision, traite_le, cree_le")
        .order("cree_le", { ascending: false })

      if (error) {
        requete.log.error({ error }, "lecture des signalements impossible")
        return reponse.code(502).send({
          erreur: "base_indisponible",
          message: "Impossible de lire les signalements pour le moment.",
        })
      }

      return { donnees: data ?? [] }
    },
  )
}
