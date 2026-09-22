import type { FastifyInstance } from "fastify"

import { exigerSession, supabasePour } from "../../supabase.js"

/**
 * Séances avec un répétiteur — celles qui justifient la plateforme.
 *
 * L'administration les voit toutes, et ce n'est pas un privilège de confort :
 * la surveillance est la promesse faite au parent, pas un effet de bord.
 */
export async function routesSeances(app: FastifyInstance): Promise<void> {
  app.get(
    "/seances",
    {
      preHandler: exigerSession,
      schema: {
        tags: ["séances"],
        summary: "Les séances que j'ai le droit de voir",
        security: [{ porteur: [] }],
        querystring: {
          type: "object",
          properties: {
            contratId: { type: "string", format: "uuid" },
            enCours: { type: "boolean", default: false },
          },
        },
      },
    },
    async (requete, reponse) => {
      const { contratId, enCours = false } = requete.query as {
        contratId?: string
        enCours?: boolean
      }

      let q = supabasePour(requete)
        .from("seances_humaines")
        .select(
          "id, contrat_id, lecon_id, demarree_le, terminee_le, enregistrement_url, compte_rendu",
        )
        .order("demarree_le", { ascending: false, nullsFirst: false })

      if (contratId) q = q.eq("contrat_id", contratId)
      if (enCours) q = q.is("terminee_le", null).not("demarree_le", "is", null)

      const { data, error } = await q

      if (error) {
        requete.log.error({ error }, "lecture des seances impossible")
        return reponse.code(502).send({
          erreur: "base_indisponible",
          message: "Impossible de lire les séances pour le moment.",
        })
      }

      return { donnees: data ?? [] }
    },
  )

  app.post(
    "/seances",
    {
      preHandler: exigerSession,
      schema: {
        tags: ["séances"],
        summary: "Ouvrir une séance",
        description:
          "Réservé au répétiteur du contrat. Le parent n'a pas à démarrer " +
          "la séance, et surtout il ne doit pas pouvoir la clore : une " +
          "séance qu'on peut terminer sans trace est une séance qu'on peut " +
          "effacer.",
        security: [{ porteur: [] }],
        body: {
          type: "object",
          required: ["contratId"],
          properties: {
            contratId: { type: "string", format: "uuid" },
            leconId: { type: "string", maxLength: 120 },
          },
        },
      },
    },
    async (requete, reponse) => {
      const { contratId, leconId } = requete.body as {
        contratId: string
        leconId?: string
      }

      const { data, error } = await supabasePour(requete)
        .from("seances_humaines")
        .insert({
          contrat_id: contratId,
          lecon_id: leconId ?? null,
          demarree_le: new Date().toISOString(),
          regle: false,
        })
        .select()
        .single()

      if (error) {
        requete.log.warn({ error }, "ouverture de seance refusee")
        return reponse.code(403).send({
          erreur: "seance_refusee",
          message: "Seul le répétiteur du contrat ouvre la séance.",
        })
      }

      return reponse.code(201).send(data)
    },
  )

  app.post(
    "/seances/:id/cloture",
    {
      preHandler: exigerSession,
      schema: {
        tags: ["séances"],
        summary: "Clore une séance",
        security: [{ porteur: [] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      },
    },
    async (requete, reponse) => {
      const { id } = requete.params as { id: string }

      const { data, error } = await supabasePour(requete)
        .from("seances_humaines")
        .update({ terminee_le: new Date().toISOString() })
        .eq("id", id)
        .is("terminee_le", null)
        .select()
        .maybeSingle()

      if (error) {
        requete.log.warn({ error }, "cloture refusee")
        return reponse.code(403).send({
          erreur: "cloture_refusee",
          message: "Seul le répétiteur du contrat clôt la séance.",
        })
      }

      // Aucune ligne modifiée : soit la séance n'existe pas, soit elle est
      // déjà close, soit la politique l'a écartée. On ne distingue pas —
      // répondre « elle existe mais vous n'y avez pas droit » apprendrait
      // déjà quelque chose à qui essaie des identifiants au hasard.
      if (!data) {
        return reponse.code(404).send({
          erreur: "seance_introuvable",
          message: "Cette séance n'existe pas ou est déjà terminée.",
        })
      }

      return data
    },
  )
}
