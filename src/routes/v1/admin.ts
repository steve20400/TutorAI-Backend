import type { FastifyInstance } from "fastify"

import { configurationDuTuteur, oublierLaConfiguration } from "../../ia/configuration.js"
import { FOURNISSEURS_CONNUS } from "../../ia/index.js"

import type { SupabaseClient } from "@supabase/supabase-js"

import {
  exigerAdmin,
  exigerSession,
  supabasePour,
  utilisateurDe,
} from "../../supabase.js"

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
/**
 * Modules qui exigent une clé enregistrée pour pouvoir s'allumer, et le nom de
 * la clé dont chacun dépend.
 *
 * Une Map plutôt qu'un Set : savoir QUELLE clé manque permet de le dire, et de
 * vérifier qu'elle est réellement posée plutôt que de refuser en bloc.
 */
const CLES_REQUISES = new Map([
  ["ia_active", "anthropic"],
  ["paiement_actif", "mtn"],
])

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
      // `.select()` n'est pas décoratif : un UPDATE qui ne touche AUCUNE
      // ligne réussit sans rien dire. C'est ce qui s'est produit ici pendant
      // des semaines — la RLS ne donnait aucun droit d'écriture à
      // l'administration, l'update ne trouvait rien, `error` restait nul, et
      // la route répondait « ok » en inscrivant au registre une vérification
      // qui n'avait pas eu lieu. Un registre qui se trompe est pire qu'un
      // registre vide.
      const { data, error } = await supabasePour(requete)
        .from("repetiteurs")
        .update({
          statut: "verifie",
          verifie_le: new Date().toISOString(),
          motif_refus: null,
        })
        .eq("id", id)
        .select("id")

      if (error) return echec(requete, reponse, error, "cachet")
      if (!data || data.length === 0) {
        return reponse.code(403).send({
          erreur: "cachet_refuse",
          message:
            "Ce dossier n'a pas pu être vérifié. Il n'existe pas, ou vous " +
            "n'avez pas le droit d'y toucher.",
        })
      }

      await journaliser(
        supabasePour(requete),
        utilisateurDe(requete),
        "verification",
        "repetiteur",
        id,
      )
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

      const { data, error } = await supabasePour(requete)
        .from("repetiteurs")
        .update({ statut: "refuse", motif_refus: motif, verifie_le: null })
        .eq("id", id)
        .select("id")

      if (error) return echec(requete, reponse, error, "refus")
      if (!data || data.length === 0) {
        return reponse.code(403).send({
          erreur: "refus_impossible",
          message:
            "Ce dossier n'a pas pu être refusé. Il n'existe pas, ou vous " +
            "n'avez pas le droit d'y toucher.",
        })
      }

      await journaliser(
        supabasePour(requete),
        utilisateurDe(requete),
        "refus",
        "repetiteur",
        id,
        motif,
      )
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
            "id, ville, bio, matieres, niveaux, tarif_mensuel, annees_experience, disponibilites_texte, statut, verifie_le, motif_refus, photo_url",
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
          .select("id, type_cle, statut, motif, chemin, deposee_le")
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

  /**
   * Ouvrir une pièce justificative, sans la rendre publique.
   *
   * Le bucket est privé : ces fichiers sont des cartes d'identité et des
   * extraits de casier judiciaire. On ne sert donc jamais l'URL du fichier,
   * mais une URL SIGNÉE, valable quelques minutes et liée à cette demande.
   *
   * Quinze minutes : assez pour consulter un dossier entier sans relancer,
   * trop peu pour qu'un lien copié dans un message reste utilisable demain.
   * Un lien qui ne périme pas est un lien qui circule.
   *
   * La consultation est journalisée. L'administration voit tout — c'est la
   * condition de son travail — mais voir la pièce d'identité de quelqu'un
   * laisse une trace, comme le reste. C'est ce qui distingue un droit d'un
   * pouvoir.
   */
  app.get(
    "/pieces/:id/ouvrir",
    {
      schema: {
        tags: ["administration"],
        summary: "URL signée d'une pièce, valable quelques minutes",
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

      const { data: piece } = await supabase
        .from("pieces_justificatives")
        .select("id, repetiteur_id, type_cle, chemin")
        .eq("id", id)
        .maybeSingle()

      if (!piece?.chemin) {
        return reponse.code(404).send({
          erreur: "piece_introuvable",
          message: "Cette pièce n'existe pas ou n'a pas de fichier.",
        })
      }

      const { data, error } = await supabase.storage
        .from("pieces")
        .createSignedUrl(piece.chemin as string, 900)

      if (error || !data?.signedUrl) {
        requete.log.error({ error }, "signature de piece impossible")
        return reponse.code(502).send({
          erreur: "piece_indisponible",
          message: "Le fichier n'a pas pu être ouvert.",
        })
      }

      await journaliser(
        supabase,
        utilisateurDe(requete),
        "consultation_piece",
        "piece",
        id,
        piece.type_cle as string,
      )

      // Le type est déduit de l'extension : le lecteur doit savoir s'il
      // affiche une image ou un document avant de charger quoi que ce soit.
      const chemin = piece.chemin as string
      const extension = chemin.slice(chemin.lastIndexOf(".") + 1).toLowerCase()

      return {
        url: data.signedUrl,
        type: extension === "pdf" ? "pdf" : "image",
        expireDans: 900,
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
        .select(
          "id, prenom, nom, identifiant, telephone, pays, cree_le, desactive_le, photo_url",
        )
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

  /**
   * Une famille : le parent, ses enfants, et ce qui les lie à des répétiteurs.
   *
   * C'est l'écran d'arbitrage. Le jour où un parent conteste quelque chose, il
   * faut pouvoir dire qui est cette famille, avec quel répétiteur, depuis
   * quand, et combien de séances ont eu lieu. Une liste de noms ne répond à
   * aucune de ces questions.
   */
  app.get(
    "/familles/:id",
    {
      schema: {
        tags: ["administration"],
        summary: "Une famille et son suivi",
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

      const { data: parent } = await supabase
        .from("profils")
        .select(
          "id, prenom, nom, identifiant, telephone, pays, photo_url, cree_le, desactive_le, motif_desactivation",
        )
        .eq("id", id)
        .eq("role", "parent")
        .maybeSingle()

      if (!parent) {
        return reponse.code(404).send({
          erreur: "famille_introuvable",
          message: "Cette famille n'existe pas.",
        })
      }

      const { data: liens } = await supabase
        .from("liens_familiaux")
        .select("eleve_id, cree_le")
        .eq("parent_id", id)

      const idsEnfants = (liens ?? []).map((l) => l.eleve_id as string)

      const [enfants, contrats] = await Promise.all([
        idsEnfants.length
          ? supabase
              .from("profils")
              .select("id, prenom, nom, identifiant, photo_url, cree_le, desactive_le")
              .in("id", idsEnfants)
          : Promise.resolve({ data: [] as Record<string, unknown>[] }),
        supabase
          .from("contrats")
          .select(
            "id, eleve_id, repetiteur_id, matiere, tarif, frequence, demarre_le, termine_le",
          )
          .eq("parent_id", id),
      ])

      // Le nom du répétiteur, pas seulement son identifiant : « contrat avec
      // 8f3a-… » n'aide personne à comprendre un litige.
      const idsRepetiteurs = [
        ...new Set((contrats.data ?? []).map((c) => c.repetiteur_id as string)),
      ]
      const { data: repetiteurs } = idsRepetiteurs.length
        ? await supabase
            .from("profils")
            .select("id, prenom, nom, identifiant")
            .in("id", idsRepetiteurs)
        : { data: [] as Record<string, unknown>[] }

      const parRepetiteur = new Map(
        (repetiteurs ?? []).map((r) => [r.id as string, r]),
      )

      // Combien de séances par contrat : c'est le chiffre qu'on cherche quand
      // quelqu'un affirme qu'il n'y en a jamais eu.
      const idsContrats = (contrats.data ?? []).map((c) => c.id as string)
      const { data: seances } = idsContrats.length
        ? await supabase
            .from("seances_humaines")
            .select("id, contrat_id, demarree_le, terminee_le")
            .in("contrat_id", idsContrats)
        : { data: [] as Record<string, unknown>[] }

      // L'adresse vient d'`auth.users`, que PostgREST n'expose pas : seule une
      // fonction `security definer` peut la lire, et elle vérifie elle-même
      // que l'appelant est bien de l'administration. Contacter un parent par
      // écrit est souvent le seul moyen de régler quelque chose — et c'est
      // par écrit qu'on garde une trace.
      const { data: courriel } = await supabase.rpc("courriel_du_compte", {
        cible: id,
      })

      return {
        parent: { ...parent, courriel: courriel ?? null },
        enfants: enfants.data ?? [],
        contrats: (contrats.data ?? []).map((c) => ({
          ...c,
          repetiteur: parRepetiteur.get(c.repetiteur_id as string) ?? null,
          seances: (seances ?? []).filter((s) => s.contrat_id === c.id).length,
        })),
        seances: seances ?? [],
      }
    },
  )

  /**
   * Les séances, toutes ou seulement celles en cours.
   *
   * L'administration voit tout : la surveillance est la promesse faite au
   * parent, pas un effet de bord. Chaque ligne porte qui enseignait, à qui, et
   * dans quelle matière — un identifiant de contrat ne dit rien à personne.
   */
  app.get(
    "/seances",
    {
      schema: {
        tags: ["administration"],
        summary: "Séances, avec les personnes",
        security: securite,
        querystring: {
          type: "object",
          properties: {
            enCours: { type: "boolean", default: false },
            limite: { type: "integer", minimum: 1, maximum: 200, default: 80 },
          },
        },
      },
    },
    async (requete, reponse) => {
      const { enCours = false, limite = 80 } = requete.query as {
        enCours?: boolean
        limite?: number
      }
      const supabase = supabasePour(requete)

      let q = supabase
        .from("seances_humaines")
        .select(
          "id, contrat_id, lecon_id, demarree_le, terminee_le, enregistrement_url, compte_rendu",
        )
        .order("demarree_le", { ascending: false, nullsFirst: false })
        .limit(limite)

      if (enCours) q = q.is("terminee_le", null).not("demarree_le", "is", null)

      const { data: seances, error } = await q
      if (error) return echec(requete, reponse, error, "seances")
      if (!seances?.length) return { donnees: [] }

      const idsContrats = [
        ...new Set(seances.map((s) => s.contrat_id as string)),
      ]
      const { data: contrats } = await supabase
        .from("contrats")
        .select("id, matiere, eleve_id, repetiteur_id, parent_id")
        .in("id", idsContrats)

      const idsPersonnes = [
        ...new Set(
          (contrats ?? []).flatMap((c) => [
            c.eleve_id as string,
            c.repetiteur_id as string,
          ]),
        ),
      ]
      const { data: personnes } = idsPersonnes.length
        ? await supabase
            .from("profils")
            .select("id, prenom, nom, identifiant, photo_url")
            .in("id", idsPersonnes)
        : { data: [] as Record<string, unknown>[] }

      const parId = new Map((personnes ?? []).map((p) => [p.id as string, p]))
      const parContrat = new Map(
        (contrats ?? []).map((c) => [c.id as string, c]),
      )

      return {
        donnees: seances.map((s) => {
          const c = parContrat.get(s.contrat_id as string)
          return {
            ...s,
            matiere: c?.matiere ?? null,
            eleve: c ? (parId.get(c.eleve_id as string) ?? null) : null,
            repetiteur: c
              ? (parId.get(c.repetiteur_id as string) ?? null)
              : null,
            parent_id: c?.parent_id ?? null,
          }
        }),
      }
    },
  )

  /**
   * Une séance : qui, quoi, combien de temps, et ce qu'il en reste.
   *
   * C'est ce qu'on ouvre quand un parent conteste. L'enregistrement et le
   * compte rendu sont la réponse — quand ils existent. Tant que le module
   * d'enregistrement est éteint, l'écran le dit plutôt que de laisser croire
   * à une perte.
   */
  app.get(
    "/seances/:id",
    {
      schema: {
        tags: ["administration"],
        summary: "Une séance en détail",
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
        .from("seances_humaines")
        .select(
          "id, contrat_id, lecon_id, demarree_le, terminee_le, enregistrement_url, compte_rendu, regle",
        )
        .eq("id", id)
        .maybeSingle()

      if (!seance) {
        return reponse.code(404).send({
          erreur: "seance_introuvable",
          message: "Cette séance n'existe pas.",
        })
      }

      const { data: contrat } = await supabase
        .from("contrats")
        .select("id, matiere, tarif, frequence, eleve_id, repetiteur_id, parent_id")
        .eq("id", seance.contrat_id as string)
        .maybeSingle()

      const ids = contrat
        ? [contrat.eleve_id, contrat.repetiteur_id, contrat.parent_id].filter(
            Boolean,
          )
        : []

      const { data: personnes } = ids.length
        ? await supabase
            .from("profils")
            .select("id, prenom, nom, identifiant, photo_url, telephone")
            .in("id", ids as string[])
        : { data: [] as Record<string, unknown>[] }

      const parId = new Map((personnes ?? []).map((p) => [p.id as string, p]))

      // L'enregistrement est dans le même coffre que les pièces : on ne sert
      // jamais son URL brute, mais un lien signé qui périme.
      let lecture: string | null = null
      if (seance.enregistrement_url) {
        const { data: signe } = await supabase.storage
          .from("pieces")
          .createSignedUrl(seance.enregistrement_url as string, 900)
        lecture = signe?.signedUrl ?? null

        await journaliser(
          supabase,
          utilisateurDe(requete),
          "consultation_enregistrement",
          "seance",
          id,
        )
      }

      return {
        seance,
        contrat,
        eleve: contrat ? (parId.get(contrat.eleve_id as string) ?? null) : null,
        repetiteur: contrat
          ? (parId.get(contrat.repetiteur_id as string) ?? null)
          : null,
        parent: contrat
          ? (parId.get(contrat.parent_id as string) ?? null)
          : null,
        enregistrement: lecture,
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
      const supabase = supabasePour(requete)

      // Un module qui exige une clé ne s'allume pas sans elle.
      //
      // L'interrupteur est grisé dans l'interface, mais un bouton désactivé ne
      // protège que l'interface. Allumer le tuteur IA sans clé Anthropic
      // afficherait aux élèves un écran de création qui échouerait à la
      // première question — et le refus serait attribué au produit, pas au
      // réglage manquant.
      if (valeur === true && CLES_REQUISES.has(cle)) {
        const { data: posee } = await supabase
          .from("cles_api")
          .select("nom, apercu")
          .eq("nom", CLES_REQUISES.get(cle)!)
          .maybeSingle()

        if (!posee?.apercu) {
          await journaliser(
            supabase,
            utilisateurDe(requete),
            "activation_refusee_cle_manquante",
            "parametre",
            cle,
          )
          return reponse.code(409).send({
            erreur: "cle_manquante",
            message:
              "Ce module a besoin d'une clé d'accès enregistrée avant de " +
              "pouvoir être allumé.",
          })
        }
      }

      const { data, error } = await supabase
        .from("parametres")
        .update({ valeur, maj_le: new Date().toISOString() })
        .eq("cle", cle)
        .select("cle")

      if (error) return echec(requete, reponse, error, "parametre")
      if (!data || data.length === 0) {
        return reponse.code(403).send({
          erreur: "reglage_refuse",
          message: "Ce réglage n'a pas pu être modifié.",
        })
      }

      // Un module s'allume ou s'éteint ; une résolution vidéo ou un nombre de
      // participants se règle. Écrire « desactivation » pour un passage en
      // 720p rendrait le registre trompeur — et un registre qui se trompe est
      // pire qu'un registre vide, parce qu'on le croit.
      const action =
        typeof valeur === "boolean"
          ? valeur
            ? "activation"
            : "desactivation"
          : "reglage"

      await journaliser(
        supabasePour(requete),
        utilisateurDe(requete),
        action,
        "parametre",
        cle,
      )
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
      const corps = { ...(requete.body as Record<string, unknown>) }
      const supabase = supabasePour(requete)

      // Le pourcentage suppose que l'argent transite par la plateforme. Sans
      // porte-monnaie, il n'y a aucun gain à observer — et encaisser pour
      // reverser ferait de TUTELA un émetteur de monnaie électronique au sens
      // CEMAC, ce qui demande une société et une licence. Le refus est ici, et
      // pas seulement dans l'interface qui grise le choix.
      if (corps.mode === "pourcentage_gains") {
        const { data: portefeuille } = await supabase
          .from("parametres")
          .select("valeur")
          .eq("cle", "portefeuille_actif")
          .maybeSingle()

        if (portefeuille?.valeur !== true) {
          return reponse.code(409).send({
            erreur: "portefeuille_eteint",
            message:
              "Le pourcentage des gains exige le porte-monnaie interne, qui " +
              "est éteint.",
          })
        }
      }

      // Seuls les champs présents sont écrits : un PATCH partiel, pour que
      // changer le délai n'efface pas le montant.
      const { data, error } = await supabase
        .from("facturation")
        .update(corps)
        .eq("id", 1)
        .select("id")

      if (error) return echec(requete, reponse, error, "facturation")
      if (!data || data.length === 0) {
        return reponse.code(403).send({
          erreur: "facturation_refusee",
          message: "Le barème n'a pas pu être modifié.",
        })
      }

      await journaliser(
        supabasePour(requete),
        utilisateurDe(requete),
        "facturation",
        "reglage",
        Object.keys(corps).join(","),
      )
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

  app.get(
    "/tuteur/etat",
    {
      schema: {
        tags: ["administration"],
        summary: "Le tuteur est-il en état de répondre",
        description:
          "Dit ce qui manque, sans jamais montrer la clé. Trois choses " +
          "doivent être vraies pour qu'un élève obtienne une réponse : le " +
          "service joint la base, une clé est posée, et le module est allumé.",
        security: securite,
      },
    },
    async (requete) => {
      let joignable = false
      let clePosee = false
      let fournisseur = "?"
      let modele = "?"
      let pourquoi: string | null = null

      try {
        // On oublie d'abord : sinon on lirait une réponse vieille de trente
        // secondes, et l'administration croirait sa clé sans effet.
        oublierLaConfiguration()
        const c = await configurationDuTuteur(Date.now())
        joignable = true
        fournisseur = c.fournisseur
        modele = c.modeleCompte
        clePosee = Boolean(c.cle) || c.fournisseur === "compatible"
      } catch (e) {
        pourquoi = e instanceof Error ? e.message : "cause inconnue"
        requete.log.warn({ e }, "etat du tuteur : base injoignable")
      }

      const { data: reglage } = await supabasePour(requete)
        .from("parametres")
        .select("valeur")
        .eq("cle", "ia_active")
        .maybeSingle()

      const moduleAllume = reglage?.valeur === true

      return {
        joignable,
        clePosee,
        moduleAllume,
        fournisseur,
        modele,
        fournisseursConnus: FOURNISSEURS_CONNUS,
        pretARepondre: joignable && clePosee && moduleAllume,
        pourquoi,
      }
    },
  )
}

/**
 * Journalise une décision d'administration. Sans exception.
 *
 * C'était fait côté site avant que ces routes existent. Le déplacer ici n'est
 * pas un rangement : une décision prise par un autre appelant — l'application
 * mobile, un script, une future console — laissait sinon aucune trace. Le
 * registre n'aurait plus dit « tout », seulement « tout ce qui est passé par
 * le site », ce qui est la même chose que rien le jour où une décision est
 * contestée.
 *
 * `desactiver_compte`, `reactiver_compte` et `poser_cle` journalisent
 * elles-mêmes : elles connaissent le moment exact de la bascule, et on ne
 * repasse pas derrière.
 */
async function journaliser(
  supabase: SupabaseClient,
  adminId: string,
  action: string,
  cibleType: string,
  cibleId: string,
  motif?: string | null,
): Promise<void> {
  await supabase.from("journal_admin").insert({
    admin_id: adminId,
    action,
    cible_type: cibleType,
    cible_id: cibleId,
    motif: motif ?? null,
  })
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
