import type { FastifyInstance } from "fastify"

import { supabasePour } from "../../supabase.js"

/** Bornes de pagination, identiques dans les trois services de la plateforme. */
const PAR_PAGE_DEFAUT = 20
/** Un identifiant qui n'existe jamais, pour une recherche sans résultat. */
const EMPTY_UUID = "00000000-0000-0000-0000-000000000000"

const PAR_PAGE_MAX = 50

/**
 * Annuaire des répétiteurs.
 *
 * Aucune condition sur le statut n'est écrite ici, et c'est volontaire : la
 * politique RLS « les familles voient les répétiteurs vérifiés » ne renvoie
 * que les fiches vérifiées. Si un jour quelqu'un oubliait un filtre dans ce
 * fichier, la base refuserait quand même de livrer une fiche non contrôlée.
 *
 * C'est la différence entre une règle de sécurité et un filtre d'affichage.
 */
export async function routesRepetiteurs(app: FastifyInstance): Promise<void> {
  app.get(
    "/repetiteurs",
    {
      schema: {
        tags: ["répétiteurs"],
        summary: "Répétiteurs vérifiés, filtrables",
        querystring: {
          type: "object",
          properties: {
            ville: { type: "string", maxLength: 80 },
            q: { type: "string", maxLength: 80 },
            prixMin: { type: "integer", minimum: 0 },
            prixMax: { type: "integer", minimum: 0 },
            experienceMin: { type: "integer", minimum: 0, maximum: 60 },
            tri: { type: "string", enum: ["experience", "tarif"] },
            matiere: { type: "string", maxLength: 60 },
            niveau: { type: "string", maxLength: 40 },
            // Listes fermées, comme en base : une valeur libre rendrait le
            // filtre inutilisable au premier « Anglais/English » saisi à la
            // main, et ne rendrait jamais personne.
            langueCours: { type: "string", enum: ["fr", "en"] },
            moment: {
              type: "string",
              enum: [
                "semaine_apres_ecole",
                "semaine_soir",
                "samedi",
                "dimanche",
              ],
            },
            page: { type: "integer", minimum: 1, default: 1 },
            parPage: {
              type: "integer",
              minimum: 1,
              maximum: PAR_PAGE_MAX,
              default: PAR_PAGE_DEFAUT,
            },
          },
        },
      },
    },
    async (requete, reponse) => {
      const {
        ville,
        matiere,
        niveau,
        q,
        prixMin,
        prixMax,
        experienceMin,
        langueCours,
        moment,
        tri,
        page = 1,
        parPage = PAR_PAGE_DEFAUT,
      } = requete.query as {
        ville?: string
        matiere?: string
        niveau?: string
        q?: string
        prixMin?: number
        prixMax?: number
        experienceMin?: number
        langueCours?: string
        moment?: string
        tri?: "experience" | "tarif"
        page?: number
        parPage?: number
      }

      const debut = (page - 1) * parPage

      let requeteSql = supabasePour(requete)
        .from("repetiteurs")
        .select(
          "id, bio, ville, matieres, niveaux, tarif_mensuel, annees_experience, disponibilites_texte, langues_cours, moments, photo_url, verifie_le",
          { count: "exact" },
        )
        // Par défaut les plus expérimentés, comme au canevas. Le tarif le
        // plus bas est l'autre tri que demande un parent, et le seul autre
        // qu'on puisse trier honnêtement : « le mieux noté » n'existe pas,
        // il n'y a pas de notes.
        .order(tri === "tarif" ? "tarif_mensuel" : "annees_experience", {
          ascending: tri === "tarif",
          nullsFirst: false,
        })
        .range(debut, debut + parPage - 1)

      // La recherche passe par une fonction : le nom vit dans `profils`, que
      // la politique de lecture ferme à un parent. Elle ne rend que des
      // identifiants, et seulement ceux de répétiteurs vérifiés.
      if (q?.trim()) {
        const { data: trouves, error: erreurQ } = await supabasePour(requete).rpc(
          "chercher_repetiteurs",
          { q },
        )

        if (erreurQ) {
          requete.log.error({ error: erreurQ }, "recherche dans l'annuaire impossible")
          return reponse.code(502).send({
            erreur: "base_indisponible",
            message: "La recherche est momentanément indisponible.",
          })
        }

        const ids = ((trouves ?? []) as Array<{ id: string }>).map((r) => r.id)
        // Aucun résultat : on le dit par une liste vide, pas en ignorant le
        // filtre — sans quoi chercher « zzz » rendrait tout l'annuaire.
        requeteSql = requeteSql.in("id", ids.length > 0 ? ids : [EMPTY_UUID])
      }

      if (ville) requeteSql = requeteSql.ilike("ville", ville)
      if (matiere) requeteSql = requeteSql.contains("matieres", [matiere])
      if (niveau) requeteSql = requeteSql.contains("niveaux", [niveau])
      // `contains` et non `overlaps` : on demande « enseigne en anglais »,
      // pas « enseigne dans l'une de ces langues ». Un seul critère à la
      // fois, donc les deux reviennent au même — mais le jour où le filtre
      // acceptera deux langues, c'est « les deux » qu'il faudra, pas « l'une
      // ou l'autre ».
      if (langueCours) {
        requeteSql = requeteSql.contains("langues_cours", [langueCours])
      }
      if (moment) requeteSql = requeteSql.contains("moments", [moment])
      if (prixMin !== undefined) requeteSql = requeteSql.gte("tarif_mensuel", prixMin)
      if (prixMax !== undefined) requeteSql = requeteSql.lte("tarif_mensuel", prixMax)
      if (experienceMin !== undefined) {
        requeteSql = requeteSql.gte("annees_experience", experienceMin)
      }

      const { data, error, count } = await requeteSql

      if (error) {
        requete.log.error({ error }, "lecture de l'annuaire impossible")
        return reponse.code(502).send({
          erreur: "base_indisponible",
          message: "L'annuaire est momentanément indisponible.",
        })
      }

      // Les noms viennent à part.
      //
      // La politique de lecture de `profils` n'autorise pas un parent à lire
      // le profil d'un répétiteur — seulement le sien, ceux de ses enfants et
      // l'administration. L'annuaire rendait donc des fiches complètes et
      // anonymes. `noms_de_repetiteurs()` rend le prénom et le nom des
      // vérifiés, et rien d'autre : élargir la politique aurait donné la
      // ligne entière, téléphone et identifiant compris.
      const ids = (data ?? []).map((r) => r.id as string)
      let noms = new Map<string, { prenom: string | null; nom: string | null }>()

      if (ids.length > 0) {
        const { data: lignes, error: erreurNoms } = await supabasePour(
          requete,
        ).rpc("noms_de_repetiteurs", { ids })

        if (erreurNoms) {
          // Bruyant : une fiche sans nom est inutilisable, et rien à l'écran
          // ne dirait pourquoi.
          requete.log.error({ error: erreurNoms }, "noms de l'annuaire illisibles")
        }

        noms = new Map(
          ((lignes ?? []) as Array<{
            id: string
            prenom: string | null
            nom: string | null
          }>).map((l) => [l.id, { prenom: l.prenom, nom: l.nom }]),
        )
      }

      return {
        donnees: (data ?? []).map((r) => ({
          ...r,
          prenom: noms.get(r.id as string)?.prenom ?? null,
          nom: noms.get(r.id as string)?.nom ?? null,
        })),
        pagination: {
          page,
          parPage,
          total: count ?? 0,
          pages: Math.max(1, Math.ceil((count ?? 0) / parPage)),
        },
      }
    },
  )

  app.get(
    "/repetiteurs/villes",
    {
      schema: {
        tags: ["répétiteurs"],
        summary: "Combien de répétiteurs vérifiés par ville",
        description:
          "La barre de filtres affiche les effectifs. Sans eux, il faudrait " +
          "charger tout l'annuaire pour les calculer.",
      },
    },
    async (requete, reponse) => {
      const { data, error } = await supabasePour(requete).rpc(
        "repetiteurs_par_ville",
      )

      if (error) {
        requete.log.error({ error }, "effectifs par ville illisibles")
        return reponse.code(502).send({
          erreur: "base_indisponible",
          message: "Les effectifs ne sont pas disponibles.",
        })
      }

      return { donnees: data ?? [] }
    },
  )

  app.get(
    "/repetiteurs/bornes",
    {
      schema: {
        tags: ["répétiteurs"],
        summary: "Le tarif le plus bas et le plus haut de l'annuaire",
      },
    },
    async (requete, reponse) => {
      const { data, error } = await supabasePour(requete).rpc("bornes_tarifs")

      if (error) {
        requete.log.error({ error }, "bornes de tarif illisibles")
        return reponse.code(502).send({
          erreur: "base_indisponible",
          message: "Les bornes ne sont pas disponibles.",
        })
      }

      const l = (data as Array<{ bas: number; haut: number }> | null)?.[0]
      return { bas: l?.bas ?? 0, haut: l?.haut ?? 0 }
    },
  )

  app.get(
    "/repetiteurs/:id",
    {
      schema: {
        tags: ["répétiteurs"],
        summary: "Le dossier public d'un répétiteur vérifié",
        description:
          "Ce qu'un parent a le droit de lire : l'identité, la façon de " +
          "travailler, ce qui est enseigné, le tarif — et les pièces qui ont " +
          "été contrôlées, avec leur date. Jamais l'emplacement d'un " +
          "document, jamais le verdict d'une pièce refusée : cela appartient " +
          "à l'administration et à celui qui l'a déposée.",
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

      const [{ data: fiches, error }, { data: pieces }] = await Promise.all([
        supabase.rpc("repetiteur_public", { rid: id }),
        supabase.rpc("pieces_controlees", { rid: id }),
      ])

      if (error) {
        requete.log.error({ error }, "lecture du dossier impossible")
        return reponse.code(502).send({
          erreur: "base_indisponible",
          message: "Le dossier est momentanément indisponible.",
        })
      }

      const fiche = (fiches as unknown[] | null)?.[0]

      // Introuvable et non vérifié se répondent pareil : dire « ce dossier
      // existe mais n'est pas publié » apprendrait qui a postulé.
      if (!fiche) {
        return reponse.code(404).send({
          erreur: "dossier_absent",
          message: "Ce dossier n'existe pas.",
        })
      }

      return { fiche, pieces: pieces ?? [] }
    },
  )
}
