import type { FastifyInstance } from "fastify"

import { exigerSession, supabasePour } from "../../supabase.js"

/**
 * Le rattachement d'un adulte à un enfant.
 *
 * L'adulte demande, l'enfant reconnaît. Jamais l'inverse : faire saisir à
 * l'adulte le mot de passe de l'enfant serait la preuve la plus forte, et la
 * pire — elle apprendrait à chaque enfant de la plateforme que donner son mot
 * de passe à un adulte qui l'aide est la procédure normale.
 *
 * Rien n'est décidé ici. Les trois fonctions SQL portent les règles : le
 * silence sur l'existence du compte, le plafond de trois demandes, le refus
 * définitif, les quarante-huit heures de lien provisoire et le signalement au
 * dixième refus. Cette route ne fait que les appeler.
 */
export async function routesLiens(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", exigerSession)

  const securite = [{ porteur: [] as string[] }]

  app.post(
    "/liens/demande",
    {
      schema: {
        tags: ["liens"],
        summary: "Demander à être rattaché à un enfant",
        description:
          "Ne dit jamais si le compte existe : un adulte qui essaierait des " +
          "noms au hasard obtient exactement la même réponse dans tous les cas.",
        security: securite,
        body: {
          type: "object",
          required: ["nom"],
          properties: { nom: { type: "string", minLength: 2, maxLength: 80 } },
        },
      },
    },
    async (requete, reponse) => {
      const { nom } = requete.body as { nom: string }

      const { error } = await supabasePour(requete).rpc(
        "demander_rattachement",
        { nom_enfant: nom },
      )

      if (error) {
        requete.log.warn({ error }, "demande de rattachement refusee")
        return reponse.code(403).send({
          erreur: "demande_refusee",
          message: error.message,
        })
      }

      // Toujours la même réponse. C'est le propos.
      return { ok: true }
    },
  )

  app.get(
    "/liens/a-reconnaitre",
    {
      schema: {
        tags: ["liens"],
        summary: "Les adultes qui disent être mes parents",
        description:
          "Un prénom, un nom, une photo. Ni adresse ni téléphone : cet écran " +
          "ne doit pas devenir un moyen d'apprendre comment joindre un " +
          "adulte hors de la plateforme.",
        security: securite,
      },
    },
    async (requete) => {
      const { data } = await supabasePour(requete).rpc("demandes_a_reconnaitre")
      return { donnees: data ?? [] }
    },
  )

  app.post(
    "/liens/:id/reponse",
    {
      schema: {
        tags: ["liens"],
        summary: "Reconnaître un adulte, ou non",
        security: securite,
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["oui"],
          properties: { oui: { type: "boolean" } },
        },
      },
    },
    async (requete, reponse) => {
      const { id } = requete.params as { id: string }
      const { oui } = requete.body as { oui: boolean }

      const { error } = await supabasePour(requete).rpc(
        "repondre_rattachement",
        { demande: id, oui },
      )

      if (error) {
        requete.log.warn({ error }, "reponse au rattachement refusee")
        return reponse.code(403).send({
          erreur: "reponse_refusee",
          message: error.message,
        })
      }

      return { ok: true }
    },
  )
}
