import type { FastifyInstance } from "fastify"

import { supabasePour } from "../../supabase.js"

/**
 * Villes ouvertes. Lisible sans session : l'annuaire s'en sert pour filtrer,
 * et la liste des villes d'un pays n'est un secret pour personne.
 */
export async function routesVilles(app: FastifyInstance): Promise<void> {
  app.get(
    "/villes",
    {
      schema: {
        tags: ["référentiel"],
        summary: "Villes où la plateforme est ouverte",
      },
    },
    async (requete, reponse) => {
      const { data, error } = await supabasePour(requete)
        .from("villes")
        .select("nom, lon, lat")
        .eq("visible", true)
        .order("nom")

      if (error) {
        requete.log.error({ error }, "lecture des villes impossible")
        return reponse.code(502).send({
          erreur: "base_indisponible",
          message: "Impossible de lire les villes pour le moment.",
        })
      }

      return { donnees: data ?? [] }
    },
  )
}
