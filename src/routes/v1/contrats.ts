import type { FastifyInstance } from "fastify"

import { exigerSession, supabasePour, utilisateurDe } from "../../supabase.js"

/**
 * Contrats entre une famille et un répétiteur.
 *
 * Trois personnes y sont parties — le parent, l'élève, le répétiteur — et la
 * politique de lecture les laisse tous les trois voir la ligne. Rien n'est
 * filtré ici : ce que l'appelant n'a pas le droit de voir ne remonte pas de la
 * base, quelle que soit la requête écrite dans ce fichier.
 */
export async function routesContrats(app: FastifyInstance): Promise<void> {
  app.get(
    "/contrats",
    {
      preHandler: exigerSession,
      schema: {
        tags: ["contrats"],
        summary: "Mes contrats",
        security: [{ porteur: [] }],
        querystring: {
          type: "object",
          properties: {
            actifs: {
              type: "boolean",
              default: false,
              description: "Ne garder que les contrats non terminés.",
            },
          },
        },
      },
    },
    async (requete, reponse) => {
      const { actifs = false } = requete.query as { actifs?: boolean }

      let q = supabasePour(requete)
        .from("contrats")
        .select(
          "id, parent_id, eleve_id, repetiteur_id, matiere, tarif, frequence, demarre_le, termine_le, regle",
        )
        .order("demarre_le", { ascending: false, nullsFirst: false })

      if (actifs) q = q.is("termine_le", null)

      const { data, error } = await q

      if (error) {
        requete.log.error({ error }, "lecture des contrats impossible")
        return reponse.code(502).send({
          erreur: "base_indisponible",
          message: "Impossible de lire les contrats pour le moment.",
        })
      }

      return { donnees: data ?? [] }
    },
  )

  app.post(
    "/contrats",
    {
      preHandler: exigerSession,
      schema: {
        tags: ["contrats"],
        summary: "Engager un répétiteur pour un enfant",
        description:
          "Réservé au parent. Ni l'élève — un mineur ne signe pas —, ni le " +
          "répétiteur, qui se donnerait des élèves tout seul.",
        security: [{ porteur: [] }],
        body: {
          type: "object",
          required: ["eleveId", "repetiteurId", "matiere"],
          properties: {
            eleveId: { type: "string", format: "uuid" },
            repetiteurId: { type: "string", format: "uuid" },
            matiere: { type: "string", minLength: 2, maxLength: 60 },
            tarif: { type: "integer", minimum: 0 },
            frequence: { type: "string", maxLength: 80 },
          },
        },
      },
    },
    async (requete, reponse) => {
      const corps = requete.body as {
        eleveId: string
        repetiteurId: string
        matiere: string
        tarif?: number
        frequence?: string
      }

      // `parent_id` vient de la session, jamais du corps de la requête : le
      // laisser choisir permettrait d'engager un répétiteur au nom d'un autre.
      const { data, error } = await supabasePour(requete)
        .from("contrats")
        .insert({
          parent_id: utilisateurDe(requete),
          eleve_id: corps.eleveId,
          repetiteur_id: corps.repetiteurId,
          matiere: corps.matiere,
          tarif: corps.tarif ?? null,
          frequence: corps.frequence ?? null,
          demarre_le: new Date().toISOString().slice(0, 10),
          regle: false,
        })
        .select()
        .single()

      if (error) {
        requete.log.warn({ error }, "creation de contrat refusee")
        return reponse.code(403).send({
          erreur: "contrat_refuse",
          message:
            "Seul un parent peut engager un répétiteur, et seulement pour " +
            "un enfant rattaché à son compte.",
        })
      }

      return reponse.code(201).send(data)
    },
  )
}
