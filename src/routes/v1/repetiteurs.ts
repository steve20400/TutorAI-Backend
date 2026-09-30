import type { FastifyInstance } from "fastify"

import { supabasePour } from "../../supabase.js"

/** Bornes de pagination, identiques dans les trois services de la plateforme. */
const PAR_PAGE_DEFAUT = 20
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
            matiere: { type: "string", maxLength: 60 },
            niveau: { type: "string", maxLength: 40 },
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
      const { ville, matiere, niveau, page = 1, parPage = PAR_PAGE_DEFAUT } =
        requete.query as {
          ville?: string
          matiere?: string
          niveau?: string
          page?: number
          parPage?: number
        }

      const debut = (page - 1) * parPage

      let requeteSql = supabasePour(requete)
        .from("repetiteurs")
        .select(
          "id, bio, ville, matieres, niveaux, tarif_mensuel, annees_experience, disponibilites_texte, photo_url",
          { count: "exact" },
        )
        .order("annees_experience", { ascending: false, nullsFirst: false })
        .range(debut, debut + parPage - 1)

      if (ville) requeteSql = requeteSql.ilike("ville", ville)
      if (matiere) requeteSql = requeteSql.contains("matieres", [matiere])
      if (niveau) requeteSql = requeteSql.contains("niveaux", [niveau])

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
