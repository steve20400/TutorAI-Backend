import type { FastifyInstance } from "fastify"

import { exigerAdmin, exigerSession, supabasePour } from "../../supabase.js"

/**
 * Espace d'administration.
 *
 * Aucune de ces routes ne filtre par rôle : `est_admin()` est dans les
 * politiques, et c'est là qu'il doit rester. `exigerAdmin` n'est posé que pour
 * répondre 403 au lieu d'une liste vide — la différence entre « rien à voir »
 * et « pas le droit de regarder ».
 *
 * Les décisions qui engagent quelque chose — apposer un cachet, allumer un
 * module, poser une clé, désactiver un compte — passent par des fonctions de
 * la base, jamais par des écritures successives depuis ici. Elles journalisent
 * elles-mêmes : seules elles connaissent le moment exact de la bascule, et un
 * registre écrit après coup peut manquer ce qui vient d'échouer.
 */
export async function routesAdmin(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", exigerSession)
  app.addHook("preHandler", exigerAdmin)

  const securite = [{ porteur: [] as string[] }]

  // ── Dossiers en attente de vérification ─────────────────────────────────
  app.get(
    "/dossiers",
    {
      schema: {
        tags: ["administration"],
        summary: "Fiches à vérifier",
        security: securite,
        querystring: {
          type: "object",
          properties: {
            statut: {
              type: "string",
              enum: ["brouillon", "en_attente", "verifie", "refuse"],
            },
          },
        },
      },
    },
    async (requete, reponse) => {
      const { statut = "en_attente" } = requete.query as { statut?: string }

      const { data, error } = await supabasePour(requete)
        .from("repetiteurs")
        .select(
          "id, ville, bio, matieres, niveaux, tarif_mensuel, annees_experience, statut, verifie_le, motif_refus, cree_le",
        )
        .eq("statut", statut)
        .order("cree_le", { ascending: true })

      if (error) return echec(requete, reponse, error, "dossiers")
      return { donnees: data ?? [] }
    },
  )

  app.post(
    "/dossiers/:id/cachet",
    {
      schema: {
        tags: ["administration"],
        summary: "Apposer le cachet de vérification",
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

      // Le déclencheur `proteger_verification_repetiteur` refuserait cette
      // écriture à quiconque n'est pas administrateur, même en passant par ici.
      const { error } = await supabasePour(requete)
        .from("repetiteurs")
        .update({
          statut: "verifie",
          verifie_le: new Date().toISOString(),
          motif_refus: null,
        })
        .eq("id", id)

      if (error) return echec(requete, reponse, error, "cachet")
      return { ok: true }
    },
  )

  app.post(
    "/dossiers/:id/refus",
    {
      schema: {
        tags: ["administration"],
        summary: "Refuser une fiche",
        description:
          "Le motif est obligatoire : un refus sans motif ne se conteste " +
          "pas, et le répétiteur ne peut rien corriger.",
        security: securite,
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["motif"],
          properties: {
            motif: { type: "string", minLength: 3, maxLength: 1000 },
          },
        },
      },
    },
    async (requete, reponse) => {
      const { id } = requete.params as { id: string }
      const { motif } = requete.body as { motif: string }

      const { error } = await supabasePour(requete)
        .from("repetiteurs")
        .update({ statut: "refuse", motif_refus: motif, verifie_le: null })
        .eq("id", id)

      if (error) return echec(requete, reponse, error, "refus")
      return { ok: true }
    },
  )

  // ── Comptes ─────────────────────────────────────────────────────────────
  app.post(
    "/comptes/:id/desactivation",
    {
      schema: {
        tags: ["administration"],
        summary: "Désactiver un compte",
        description:
          "Jamais de suppression : effacer l'auteur d'une séance effacerait " +
          "la séance. La fiche sort de l'annuaire, les sessions ouvertes sont " +
          "fermées immédiatement, et la décision se défait.",
        security: securite,
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          properties: { motif: { type: "string", maxLength: 1000 } },
        },
      },
    },
    async (requete, reponse) => {
      const { id } = requete.params as { id: string }
      const { motif } = (requete.body ?? {}) as { motif?: string }

      const { error } = await supabasePour(requete).rpc("desactiver_compte", {
        cible: id,
        motif: motif ?? "",
      })

      if (error) return echec(requete, reponse, error, "desactivation")
      return { ok: true }
    },
  )

  app.post(
    "/comptes/:id/reactivation",
    {
      schema: {
        tags: ["administration"],
        summary: "Réactiver un compte",
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
      const { error } = await supabasePour(requete).rpc("reactiver_compte", {
        cible: id,
      })
      if (error) return echec(requete, reponse, error, "reactivation")
      return { ok: true }
    },
  )

  // ── Réglages ────────────────────────────────────────────────────────────
  app.get(
    "/parametres",
    { schema: { tags: ["administration"], summary: "Modules et réglages", security: securite } },
    async (requete, reponse) => {
      const { data, error } = await supabasePour(requete)
        .from("parametres")
        .select("cle, valeur, libelle, maj_le")
        .order("cle")
      if (error) return echec(requete, reponse, error, "parametres")
      return { donnees: data ?? [] }
    },
  )

  app.post(
    "/parametres/:cle",
    {
      schema: {
        tags: ["administration"],
        summary: "Changer un réglage",
        security: securite,
        params: {
          type: "object",
          required: ["cle"],
          properties: { cle: { type: "string", maxLength: 60 } },
        },
        body: {
          type: "object",
          required: ["valeur"],
          // `valeur` est un jsonb : booléen pour un module, texte pour la
          // résolution, entier pour le nombre de participants.
          properties: {},
          additionalProperties: true,
        },
      },
    },
    async (requete, reponse) => {
      const { cle } = requete.params as { cle: string }
      const { valeur } = requete.body as { valeur: unknown }

      const { error } = await supabasePour(requete)
        .from("parametres")
        .update({ valeur, maj_le: new Date().toISOString() })
        .eq("cle", cle)

      if (error) return echec(requete, reponse, error, "parametre")
      return { ok: true }
    },
  )

  // ── Clés d'accès ────────────────────────────────────────────────────────
  app.get(
    "/cles",
    {
      schema: {
        tags: ["administration"],
        summary: "Clés posées, sans leur valeur",
        description:
          "`lister_cles` ne renvoie jamais la colonne `valeur` : une clé " +
          "secrète lue dans un navigateur d'administrateur est une clé lue " +
          "par toutes les extensions qu'il y a installées.",
        security: securite,
      },
    },
    async (requete, reponse) => {
      const { data, error } = await supabasePour(requete).rpc("lister_cles")
      if (error) return echec(requete, reponse, error, "cles")
      return { donnees: data ?? [] }
    },
  )

  app.post(
    "/cles/:nom",
    {
      schema: {
        tags: ["administration"],
        summary: "Poser une clé",
        security: securite,
        params: {
          type: "object",
          required: ["nom"],
          properties: { nom: { type: "string", maxLength: 60 } },
        },
        body: {
          type: "object",
          required: ["valeur"],
          properties: { valeur: { type: "string", maxLength: 500 } },
        },
      },
    },
    async (requete, reponse) => {
      const { nom } = requete.params as { nom: string }
      const { valeur } = requete.body as { valeur: string }

      const { error } = await supabasePour(requete).rpc("poser_cle", {
        nom_cle: nom,
        nouvelle_valeur: valeur,
      })

      if (error) return echec(requete, reponse, error, "pose de cle")
      // La valeur n'est jamais renvoyée, pas même celle qu'on vient d'écrire.
      return { ok: true }
    },
  )

  // ── Facturation et registre ─────────────────────────────────────────────
  app.get(
    "/facturation",
    { schema: { tags: ["administration"], summary: "Réglage de facturation", security: securite } },
    async (requete, reponse) => {
      const { data, error } = await supabasePour(requete)
        .from("facturation")
        .select("*")
        .eq("id", 1)
        .maybeSingle()
      if (error) return echec(requete, reponse, error, "facturation")
      return data ?? {}
    },
  )

  app.get(
    "/registre",
    {
      schema: {
        tags: ["administration"],
        summary: "Journal des décisions",
        security: securite,
        querystring: {
          type: "object",
          properties: {
            limite: { type: "integer", minimum: 1, maximum: 200, default: 60 },
          },
        },
      },
    },
    async (requete, reponse) => {
      const { limite = 60 } = requete.query as { limite?: number }
      const { data, error } = await supabasePour(requete)
        .from("journal_admin")
        .select("id, admin_id, action, cible_type, cible_id, motif, cree_le")
        .order("cree_le", { ascending: false })
        .limit(limite)
      if (error) return echec(requete, reponse, error, "registre")
      return { donnees: data ?? [] }
    },
  )
}

/** Réponse d'échec commune, pour ne pas la réécrire à chaque route. */
function echec(
  requete: { log: { error: (o: unknown, m: string) => void } },
  reponse: {
    code: (n: number) => { send: (o: unknown) => unknown }
  },
  erreur: { code?: string; message: string },
  quoi: string,
) {
  requete.log.error({ erreur }, `echec : ${quoi}`)

  // 42501 vient d'un déclencheur ou d'une politique : c'est un refus, pas une
  // panne. Le distinguer évite d'afficher « réessayez » à quelqu'un dont la
  // demande sera refusée aussi longtemps qu'il la répétera.
  if (erreur.code === "42501") {
    return reponse.code(403).send({ erreur: "refuse", message: erreur.message })
  }

  return reponse.code(502).send({
    erreur: "base_indisponible",
    message: "L'opération n'a pas pu aboutir. Réessayez dans un instant.",
  })
}
