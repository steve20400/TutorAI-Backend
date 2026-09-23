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

  /**
   * Tout le tableau de bord en un appel.
   *
   * Six requêtes séparées auraient voulu dire six allers-retours vers Render.
   * Sur un service gratuit qui s'endort, le premier chargement de la journée
   * aurait dépassé la minute — et l'écran d'accueil de l'administration est
   * précisément celui qu'on ouvre en arrivant.
   */
  app.get(
    "/tableau-de-bord",
    {
      schema: {
        tags: ["administration"],
        summary: "Chiffres et couverture",
        security: securite,
      },
    },
    async (requete, reponse) => {
      const supabase = supabasePour(requete)

      const [attente, verifies, familles, enCours, villes, cles] =
        await Promise.all([
          supabase
            .from("repetiteurs")
            .select("id", { count: "exact", head: true })
            .eq("statut", "en_attente"),
          supabase.from("repetiteurs").select("ville").eq("statut", "verifie"),
          supabase
            .from("profils")
            .select("id", { count: "exact", head: true })
            .eq("role", "parent"),
          supabase
            .from("seances_humaines")
            .select("id", { count: "exact", head: true })
            .not("demarree_le", "is", null)
            .is("terminee_le", null),
          supabase
            .from("villes")
            .select("nom, lon, lat")
            .eq("visible", true)
            .order("nom"),
          supabase
            .from("cles_api")
            .select("nom, valeur")
            .in("nom", ["carte_style", "carte_cle"]),
        ])

      if (verifies.error) return echec(requete, reponse, verifies.error, "tableau de bord")

      // Répartition par ville, calculée ici : la base ne sait pas regrouper
      // sans vue dédiée, et le volume reste minuscule pendant des années.
      const comptes: Record<string, number> = {}
      for (const r of verifies.data ?? []) {
        const ville = ((r.ville as string | null) ?? "").trim()
        if (ville) comptes[ville] = (comptes[ville] ?? 0) + 1
      }

      // Le style est composé ici : `{cle}` y est remplacé par la clé du
      // fournisseur, que l'appelant n'a donc pas à connaître ni à assembler.
      const parNom = new Map(
        ((cles.data ?? []) as { nom: string; valeur: string | null }[]).map(
          (c) => [c.nom, c.valeur],
        ),
      )
      const styleCarte = (
        parNom.get("carte_style") ?? "https://demotiles.maplibre.org/style.json"
      ).replace("{cle}", parNom.get("carte_cle") ?? "")

      return {
        aVerifier: attente.count ?? 0,
        familles: familles.count ?? 0,
        seancesEnCours: enCours.count ?? 0,
        villes: villes.data ?? [],
        comptes,
        styleCarte,
      }
    },
  )

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

      const supabase = supabasePour(requete)
      const { data, error } = await supabase
        .from("repetiteurs")
        .select(
          "id, ville, bio, matieres, niveaux, tarif_mensuel, annees_experience, statut, verifie_le, motif_refus, cree_le, maj_le",
        )
        .eq("statut", statut)
        .order("maj_le", { ascending: true })

      if (error) return echec(requete, reponse, error, "dossiers")

      const ids = (data ?? []).map((d) => d.id as string)
      if (ids.length === 0) return { donnees: [] }

      // L'identité vient avec, plutôt qu'en second appel : deux allers-retours
      // vers un service qui peut dormir cinquante secondes pour afficher un
      // seul écran, c'est une pile de dossiers qu'on n'ouvre plus.
      const { data: profils } = await supabase
        .from("profils")
        .select("id, prenom, nom, identifiant, desactive_le")
        .in("id", ids)

      const parId = new Map((profils ?? []).map((p) => [p.id as string, p]))

      return {
        donnees: (data ?? []).map((d) => ({
          ...d,
          profil: parId.get(d.id as string) ?? null,
        })),
      }
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

  app.get(
    "/dossiers/:id",
    {
      schema: {
        tags: ["administration"],
        summary: "Une fiche et ses pièces",
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

      const [fiche, profil, pieces, types] = await Promise.all([
        supabase
          .from("repetiteurs")
          .select(
            "id, ville, bio, matieres, niveaux, tarif_mensuel, annees_experience, disponibilites_texte, statut, verifie_le, motif_refus",
          )
          .eq("id", id)
          .maybeSingle(),
        supabase
          .from("profils")
          .select("prenom, nom, identifiant, telephone, desactive_le, motif_desactivation")
          .eq("id", id)
          .maybeSingle(),
        supabase
          .from("pieces_justificatives")
          .select("type_cle, statut, motif, cree_le")
          .eq("repetiteur_id", id),
        // La liste des pièces attendues vient avec : sans elle, l'écran ne
        // peut pas montrer ce qui MANQUE, et une pièce absente ne se voit pas.
        supabase
          .from("types_pieces")
          .select("cle, libelle_fr, libelle_en, requise, ordre")
          .order("ordre"),
      ])

      if (!fiche.data) {
        return reponse.code(404).send({
          erreur: "dossier_introuvable",
          message: "Cette fiche n'existe pas.",
        })
      }

      return {
        fiche: fiche.data,
        profil: profil.data,
        pieces: pieces.data ?? [],
        types: types.data ?? [],
      }
    },
  )

  // ── Annuaire complet, tous statuts ──────────────────────────────────────
  app.get(
    "/repetiteurs",
    {
      schema: {
        tags: ["administration"],
        summary: "Toutes les fiches, avec l'identité",
        security: securite,
      },
    },
    async (requete, reponse) => {
      const supabase = supabasePour(requete)

      const { data: fiches, error } = await supabase
        .from("repetiteurs")
        .select("id, ville, matieres, niveaux, statut, verifie_le, cree_le")
        .order("cree_le", { ascending: false })

      if (error) return echec(requete, reponse, error, "repetiteurs")

      const ids = (fiches ?? []).map((f) => f.id as string)
      if (ids.length === 0) return { donnees: [] }

      const { data: profils } = await supabase
        .from("profils")
        .select("id, prenom, nom, identifiant, desactive_le")
        .in("id", ids)

      const parId = new Map((profils ?? []).map((p) => [p.id as string, p]))

      // Le rapprochement se fait ici plutôt qu'avec une jointure PostgREST :
      // `repetiteurs` et `profils` n'ont pas de clé étrangère déclarée entre
      // elles, et en poser une pour le confort d'une requête changerait le
      // schéma pour une raison d'affichage.
      return {
        donnees: (fiches ?? []).map((f) => ({
          ...f,
          profil: parId.get(f.id as string) ?? null,
        })),
      }
    },
  )

  // ── Familles ────────────────────────────────────────────────────────────
  app.get(
    "/familles",
    {
      schema: {
        tags: ["administration"],
        summary: "Parents et enfants rattachés",
        security: securite,
      },
    },
    async (requete, reponse) => {
      const supabase = supabasePour(requete)

      const { data: parents, error } = await supabase
        .from("profils")
        .select("id, prenom, nom, identifiant, telephone, pays, cree_le, desactive_le")
        .eq("role", "parent")
        .order("cree_le", { ascending: false })

      if (error) return echec(requete, reponse, error, "familles")

      const { data: liens } = await supabase
        .from("liens_familiaux")
        .select("parent_id, eleve_id")

      const idsEnfants = (liens ?? []).map((l) => l.eleve_id as string)
      const { data: enfants } = idsEnfants.length
        ? await supabase
            .from("profils")
            .select("id, prenom, nom, identifiant")
            .in("id", idsEnfants)
        : { data: [] as { id: string }[] }

      const parEnfant = new Map(
        (enfants ?? []).map((e) => [e.id as string, e]),
      )

      return {
        donnees: (parents ?? []).map((p) => ({
          ...p,
          enfants: (liens ?? [])
            .filter((l) => l.parent_id === p.id)
            .map((l) => parEnfant.get(l.eleve_id as string))
            .filter(Boolean),
        })),
      }
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

  app.post(
    "/facturation",
    {
      schema: {
        tags: ["administration"],
        summary: "Changer le réglage de facturation",
        description:
          "Le montant et le pourcentage sont conservés tous les deux, même " +
          "quand un seul s'applique : basculer d'un mode à l'autre ne doit " +
          "pas effacer le réglage qu'on vient de quitter.",
        security: securite,
        body: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["par_eleve_actif", "pourcentage_gains"] },
            montant_par_eleve: { type: "integer", minimum: 0 },
            pourcentage: { type: "number", minimum: 0, maximum: 100 },
            delai_masquage_jours: { type: "integer", minimum: 0, maximum: 365 },
          },
        },
      },
    },
    async (requete, reponse) => {
      const corps = requete.body as Record<string, unknown>

      // Seuls les champs présents sont écrits : un PATCH partiel, pour que
      // changer le délai n'efface pas le montant.
      const { error } = await supabasePour(requete)
        .from("facturation")
        .update(corps)
        .eq("id", 1)

      if (error) return echec(requete, reponse, error, "facturation")
      return { ok: true }
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
