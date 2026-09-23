import type { FastifyInstance } from "fastify"

import { exigerSession, supabasePour, utilisateurDe } from "../../supabase.js"

/**
 * Tuteurs IA d'un élève.
 *
 * Le module peut être éteint — il l'est par défaut, parce que chaque échange
 * coûte des crédits. Ces routes ne vérifient pas l'interrupteur : c'est la
 * route des messages qui refuse, au moment où la dépense a lieu. Lire la liste
 * de ses propres tuteurs ne coûte rien et ne doit pas dépendre d'un réglage.
 */
export async function routesTuteurs(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", exigerSession)

  const securite = [{ porteur: [] as string[] }]

  app.get(
    "/",
    {
      schema: {
        tags: ["tuteur"],
        summary: "Mes tuteurs",
        security: securite,
      },
    },
    async (requete, reponse) => {
      const { data, error } = await supabasePour(requete)
        .from("tuteurs_ia")
        .select("id, matiere, niveau, manuels, cree_le")
        .eq("eleve_id", utilisateurDe(requete))
        .order("cree_le", { ascending: true })

      if (error) {
        requete.log.error({ error }, "lecture des tuteurs impossible")
        return reponse.code(502).send({
          erreur: "base_indisponible",
          message: "Impossible de lire vos tuteurs pour le moment.",
        })
      }

      return { donnees: data ?? [] }
    },
  )

  app.get(
    "/:id",
    {
      schema: {
        tags: ["tuteur"],
        summary: "Un tuteur et ses séances",
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

      // Aucun filtre sur l'élève : la politique de `tuteurs_ia` ne renvoie
      // que les siens. Le répéter ici donnerait l'illusion que c'est ce code
      // qui protège.
      const { data: tuteur } = await supabase
        .from("tuteurs_ia")
        .select("id, matiere, niveau, cree_le")
        .eq("id", id)
        .maybeSingle()

      if (!tuteur) {
        return reponse.code(404).send({
          erreur: "tuteur_introuvable",
          message: "Ce tuteur n'existe pas.",
        })
      }

      const { data: seances } = await supabase
        .from("seances")
        .select("id, statut, lecon_titre, demarree_le, terminee_le")
        .eq("tuteur_id", id)
        .order("demarree_le", { ascending: false })
        .limit(30)

      return { tuteur, seances: seances ?? [] }
    },
  )
}

/**
 * Programmes officiels, pour composer un tuteur.
 *
 * Lisibles sans session : un visiteur doit pouvoir voir ce que la plateforme
 * couvre avant de créer un compte. La politique n'ouvre que les programmes
 * publiés.
 */
export async function routesProgrammes(app: FastifyInstance): Promise<void> {
  app.get(
    "/programmes",
    {
      schema: {
        tags: ["référentiel"],
        summary: "Programmes officiels publiés",
        querystring: {
          type: "object",
          properties: {
            niveau: { type: "string", maxLength: 40 },
          },
        },
      },
    },
    async (requete, reponse) => {
      const { niveau } = requete.query as { niveau?: string }

      // `publie` est déjà imposé par la politique de lecture. Le répéter ici
      // ne protégerait rien de plus, mais rend la requête lisible : on voit ce
      // qu'elle renvoie sans aller lire les politiques.
      let q = supabasePour(requete)
        .from("programmes")
        .select("id, matiere, niveau, pays, sous_systeme")
        .order("niveau")
        .order("matiere")

      if (niveau) q = q.eq("niveau", niveau)

      const { data, error } = await q

      if (error) {
        requete.log.error({ error }, "lecture des programmes impossible")
        return reponse.code(502).send({
          erreur: "base_indisponible",
          message: "Impossible de lire les programmes pour le moment.",
        })
      }

      return { donnees: data ?? [] }
    },
  )
}
