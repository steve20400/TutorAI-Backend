import type { FastifyInstance } from "fastify"
import { exigerSession, supabasePour, utilisateurDe } from "../../supabase.js"

/**
 * Profil de la personne connectée.
 *
 * Première route à consommer depuis le web ou le mobile : elle vérifie d'un
 * coup que le jeton circule bien et que la RLS le reconnaît.
 */
export async function routesMoi(app: FastifyInstance): Promise<void> {
  app.get(
    "/moi",
    {
      preHandler: exigerSession,
      schema: {
        tags: ["compte"],
        summary: "Profil de la personne connectée",
        security: [{ porteur: [] }],
      },
    },
    async (requete, reponse) => {
      // Pas de filtre sur l'identifiant : la politique RLS de `profils` ne
      // laisse de toute façon passer que la ligne de l'appelant. Filtrer ici
      // en plus donnerait l'illusion que c'est le code qui protège.
      const { data, error } = await supabasePour(requete)
        .from("profils")
        .select("id, prenom, nom, role, pays, identifiant, photo_url")
        .eq("id", utilisateurDe(requete))
        .maybeSingle()

      if (error) {
        requete.log.error({ error }, "lecture du profil impossible")
        return reponse.code(502).send({
          erreur: "base_indisponible",
          message: "Impossible de lire le profil pour le moment.",
        })
      }

      if (!data) {
        return reponse.code(404).send({
          erreur: "profil_absent",
          message: "Aucun profil n'est rattaché à ce compte.",
        })
      }

      return data
    },
  )
}
