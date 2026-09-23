import type { FastifyInstance } from "fastify"

import { exigerSession, supabasePour, utilisateurDe } from "../../supabase.js"

/**
 * Séances avec le tuteur IA, et leurs messages.
 *
 * À ne pas confondre avec `seances_humaines`, qui porte les cours avec un
 * répétiteur. Ce sont deux tables et deux promesses différentes : l'une est un
 * échange avec un modèle, l'autre un adulte en face d'un enfant.
 *
 * L'envoi d'un message est dans `message.js`, à part : il répond en flux, ce
 * qui demande de court-circuiter la sérialisation de Fastify, et les routes
 * d'ici répondent toutes en JSON. Il vivait dans le site jusqu'au 24 septembre
 * 2026, avec la clé dans l'environnement de Vercel et un accès direct à la
 * base — ce qui est précisément ce qu'on avait décidé d'arrêter.
 */
export async function routesConversation(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", exigerSession)

  const securite = [{ porteur: [] as string[] }]

  app.post(
    "/",
    {
      schema: {
        tags: ["tuteur"],
        summary: "Ouvrir une séance avec un tuteur",
        security: securite,
        body: {
          type: "object",
          required: ["tuteurId"],
          properties: {
            tuteurId: { type: "string", format: "uuid" },
            mode: { type: "string", enum: ["texte", "audio"], default: "texte" },
          },
        },
      },
    },
    async (requete, reponse) => {
      const { tuteurId, mode = "texte" } = requete.body as {
        tuteurId: string
        mode?: string
      }
      const supabase = supabasePour(requete)

      // Aucun filtre sur l'élève : la politique de `tuteurs_ia` ne renvoie que
      // les siens, donc un identifiant qui n'est pas le sien ne remonte pas.
      const { data: tuteur } = await supabase
        .from("tuteurs_ia")
        .select("id, matiere")
        .eq("id", tuteurId)
        .maybeSingle()

      if (!tuteur) {
        return reponse.code(404).send({
          erreur: "tuteur_introuvable",
          message: "Ce tuteur n'existe pas.",
        })
      }

      const { data: profil } = await supabase
        .from("profils")
        .select("prenom")
        .eq("id", utilisateurDe(requete))
        .maybeSingle()

      const { data: seance, error } = await supabase
        .from("seances")
        .insert({ tuteur_id: tuteur.id, mode })
        .select("id")
        .single()

      if (error || !seance) {
        requete.log.warn({ error }, "ouverture de seance refusee")
        return reponse.code(403).send({
          erreur: "seance_refusee",
          message: error?.message ?? "La séance n'a pas pu s'ouvrir.",
        })
      }

      // Le premier message vient du tuteur, pas de l'élève : un écran vide
      // avec un curseur qui clignote ne dit pas quoi faire, surtout à un
      // enfant qui ouvre l'application pour la première fois.
      await supabase.from("messages").insert({
        seance_id: seance.id,
        auteur: "tuteur",
        contenu: `Salut ${profil?.prenom ?? ""} 👋 Alors, qu'est-ce que vous avez fait en ${String(
          tuteur.matiere,
        ).toLowerCase()} aujourd'hui ?`,
      })

      return reponse.code(201).send({ id: seance.id })
    },
  )

  app.get(
    "/:id",
    {
      schema: {
        tags: ["tuteur"],
        summary: "Une séance et son fil",
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
      const supabase = supabasePour(requete)

      const { data: seance } = await supabase
        .from("seances")
        .select("id, tuteur_id, mode, statut, lecon_titre, demarree_le, terminee_le")
        .eq("id", id)
        .maybeSingle()

      if (!seance) {
        return reponse.code(404).send({
          erreur: "seance_introuvable",
          message: "Cette séance n'existe pas.",
        })
      }

      const { data: messages } = await supabase
        .from("messages")
        .select("id, auteur, contenu, cree_le")
        .eq("seance_id", id)
        .order("cree_le", { ascending: true })

      return { seance, messages: messages ?? [] }
    },
  )

  app.post(
    "/:id/cloture",
    {
      schema: {
        tags: ["tuteur"],
        summary: "Terminer une séance",
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

      const { data, error } = await supabasePour(requete)
        .from("seances")
        .update({ statut: "terminee", terminee_le: new Date().toISOString() })
        .eq("id", id)
        .is("terminee_le", null)
        .select("id")
        .maybeSingle()

      if (error) {
        return reponse.code(403).send({
          erreur: "cloture_refusee",
          message: error.message,
        })
      }

      // Déjà close, ou pas la sienne : on ne distingue pas. Répondre « elle
      // existe mais pas pour vous » apprendrait quelque chose à qui essaie
      // des identifiants au hasard.
      if (!data) {
        return reponse.code(404).send({
          erreur: "seance_introuvable",
          message: "Cette séance n'existe pas ou est déjà terminée.",
        })
      }

      return { ok: true }
    },
  )
}
