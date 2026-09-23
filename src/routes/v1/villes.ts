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

/**
 * Réglages de la plateforme, en lecture.
 *
 * Non réservée à l'administration : l'accueil d'un élève a besoin de savoir si
 * le tuteur est allumé, et la salle de cours combien de participants elle
 * accepte. La politique de `parametres` les ouvre déjà à tous — ce sont des
 * réglages de fonctionnement, pas des secrets. L'écriture, elle, reste sous
 * `/v1/admin/parametres/:cle`.
 */
export async function routesParametres(app: FastifyInstance): Promise<void> {
  app.get(
    "/parametres",
    {
      schema: {
        tags: ["référentiel"],
        summary: "Modules allumés et réglages",
      },
    },
    async (requete, reponse) => {
      const { data, error } = await supabasePour(requete)
        .from("parametres")
        .select("cle, valeur")

      if (error) {
        requete.log.error({ error }, "lecture des parametres impossible")
        return reponse.code(502).send({
          erreur: "base_indisponible",
          message: "Impossible de lire les réglages pour le moment.",
        })
      }

      // Un objet plutôt qu'une liste : c'est ainsi que l'appelant s'en sert,
      // et le transformer de son côté à chaque page serait du travail répété.
      const reglages: Record<string, unknown> = {}
      for (const p of data ?? []) reglages[p.cle as string] = p.valeur
      return reglages
    },
  )
}

/**
 * Coordonnées de contact, lisibles sans session.
 *
 * Elles s'adressent d'abord à qui ne peut PAS se connecter : un compte
 * désactivé qui veut contester. Les réserver aux gens authentifiés reviendrait
 * à cacher la sonnette derrière la porte fermée.
 *
 * Seules les clés publiques sortent — la politique de `cles_api` ne renvoie
 * que celles-là, quelle que soit la requête écrite ici.
 */
export async function routesContact(app: FastifyInstance): Promise<void> {
  app.get(
    "/contact",
    {
      schema: {
        tags: ["référentiel"],
        summary: "Où écrire à l'administration",
      },
    },
    async (requete) => {
      const { data } = await supabasePour(requete)
        .from("cles_api")
        .select("nom, valeur")
        .eq("nom", "contact_administration")
        .maybeSingle()

      return { contact_administration: data?.valeur ?? null }
    },
  )
}
