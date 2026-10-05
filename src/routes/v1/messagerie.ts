import type { FastifyInstance } from "fastify"

import { exigerSession, supabasePour, utilisateurDe } from "../../supabase.js"

const securite = [{ porteur: [] }]

/**
 * Les messages entre une famille et un répétiteur.
 *
 * Seul le parent ouvre un fil : un répétiteur qui pourrait écrire le premier
 * démarcherait les familles de l'annuaire, et l'annuaire deviendrait une liste
 * d'adresses à prospecter. Il répond, il n'aborde pas. C'est la base qui le
 * tient, pas ce fichier — `ouvrir_conversation` refuse tout autre rôle.
 *
 * L'enfant n'y est pas, ni comme auteur ni comme lecteur. La promesse du
 * produit est qu'il n'est jamais seul avec un adulte ; lui ouvrir un canal
 * écrit vers un répétiteur la déferait entièrement.
 */
export async function routesMessagerie(app: FastifyInstance): Promise<void> {
  app.get(
    "/messagerie",
    {
      preHandler: exigerSession,
      schema: {
        tags: ["messagerie"],
        summary: "Mes fils de discussion",
        security: securite,
      },
    },
    async (requete, reponse) => {
      const { data, error } = await supabasePour(requete).rpc("mes_conversations")

      if (error) {
        requete.log.error({ error }, "lecture des conversations impossible")
        return reponse.code(502).send({
          erreur: "base_indisponible",
          message: "Vos messages n'ont pas pu être lus.",
        })
      }

      return { donnees: data ?? [] }
    },
  )

  app.post(
    "/messagerie",
    {
      preHandler: exigerSession,
      schema: {
        tags: ["messagerie"],
        summary: "Ouvrir un fil avec un répétiteur",
        description:
          "Réservé au parent, et seulement vers un répétiteur vérifié. Rend " +
          "le fil existant s'il y en a un : reprendre une question trois " +
          "semaines plus tard ne doit pas créer un second fil.",
        security: securite,
        body: {
          type: "object",
          required: ["repetiteurId"],
          properties: { repetiteurId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (requete, reponse) => {
      const { repetiteurId } = requete.body as { repetiteurId: string }

      const { data, error } = await supabasePour(requete).rpc(
        "ouvrir_conversation",
        { repetiteur: repetiteurId },
      )

      if (error) {
        requete.log.warn({ error }, "ouverture de conversation refusee")
        return reponse.code(403).send({
          erreur: "ouverture_refusee",
          message: error.message,
        })
      }

      return { id: data as string }
    },
  )

  app.get(
    "/messagerie/:id",
    {
      preHandler: exigerSession,
      schema: {
        tags: ["messagerie"],
        summary: "Les messages d'un fil",
        security: securite,
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      },
    },
    async (requete, reponse) => {
      const { id } = requete.params as { id: string }

      // La RLS fait le filtre : un fil qui n'est pas le sien rend zéro ligne.
      const { data, error } = await supabasePour(requete)
        .from("messages_familles")
        .select("id, auteur_id, texte, cree_le, lu_le")
        .eq("conversation_id", id)
        .order("cree_le", { ascending: true })

      if (error) {
        requete.log.error({ error }, "lecture des messages impossible")
        return reponse.code(502).send({
          erreur: "base_indisponible",
          message: "Les messages n'ont pas pu être lus.",
        })
      }

      return { donnees: data ?? [], moi: utilisateurDe(requete) }
    },
  )

  app.post(
    "/messagerie/:id",
    {
      preHandler: exigerSession,
      schema: {
        tags: ["messagerie"],
        summary: "Écrire dans un fil",
        security: securite,
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["texte"],
          properties: { texte: { type: "string", minLength: 1, maxLength: 4000 } },
        },
      },
    },
    async (requete, reponse) => {
      const { id } = requete.params as { id: string }
      const { texte } = requete.body as { texte: string }

      const { error } = await supabasePour(requete)
        .from("messages_familles")
        .insert({
          conversation_id: id,
          auteur_id: utilisateurDe(requete),
          texte: texte.trim(),
        })

      if (error) {
        requete.log.warn({ error }, "envoi de message refuse")
        return reponse.code(403).send({
          erreur: "envoi_refuse",
          message: error.message,
        })
      }

      return { ok: true }
    },
  )

  app.post(
    "/messagerie/:id/lus",
    {
      preHandler: exigerSession,
      schema: {
        tags: ["messagerie"],
        summary: "Marquer lus les messages de l'autre",
        security: securite,
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
      },
    },
    async (requete) => {
      // Un échec ici ne vaut pas la peine d'être annoncé : la pastille de
      // non-lus restera, ce qui est désagréable et sans conséquence.
      const { error } = await supabasePour(requete).rpc("marquer_lus", {
        conversation: (requete.params as { id: string }).id,
      })
      if (error) requete.log.warn({ error }, "marquage lu refuse")
      return { ok: true }
    },
  )
}
