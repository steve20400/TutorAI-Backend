import type { FastifyInstance } from "fastify"

import { exigerSession, supabasePour } from "../../supabase.js"

/**
 * Les enfants d'un parent.
 *
 * Un enfant n'a pas d'adresse mail : dans une maison où l'on partage un
 * téléphone et une boîte, le premier inscrit prendrait l'adresse et fermerait
 * la porte aux autres. Le parent crée donc le compte, et l'enfant se connecte
 * avec un identifiant.
 *
 * La création passe par `creer_compte_eleve` en base, jamais par des écritures
 * successives depuis ici : le compte, le profil et le lien familial doivent
 * naître dans la même transaction. Un enfant à moitié créé — sans lien vers
 * son parent — serait un mineur sans adulte responsable, c'est-à-dire
 * exactement ce que la plateforme existe pour empêcher.
 */
export async function routesEnfants(app: FastifyInstance): Promise<void> {
  app.get(
    "/enfants",
    {
      preHandler: exigerSession,
      schema: {
        tags: ["famille"],
        summary: "Les enfants rattachés à mon compte",
        security: [{ porteur: [] }],
      },
    },
    async (requete, reponse) => {
      // Aucun filtre sur le parent : la politique de `liens_familiaux` ne
      // renvoie que les liens de l'appelant. Filtrer ici en plus donnerait
      // l'illusion que c'est ce code qui protège.
      const { data: liens, error } = await supabasePour(requete)
        .from("liens_familiaux")
        .select("eleve_id, actif_le")

      if (error) {
        requete.log.error({ error }, "lecture des liens impossible")
        return reponse.code(502).send({
          erreur: "base_indisponible",
          message: "Impossible de lire la famille pour le moment.",
        })
      }

      const ids = (liens ?? []).map((l) => l.eleve_id as string)
      if (ids.length === 0) return { donnees: [] }

      const { data } = await supabasePour(requete)
        .from("profils")
        .select("id, prenom, nom, identifiant")
        .in("id", ids)
        .order("prenom")

      // L'état du lien voyage avec l'enfant. Un rattachement né d'une
      // reconnaissance reste provisoire quarante-huit heures — pendant
      // lesquelles l'adulte ne voit que le prénom. Sans cette information,
      // il croirait à une panne : « je vois son nom mais rien d'autre ».
      const quand = new Map(
        (liens ?? []).map((l) => [l.eleve_id as string, l.actif_le as string]),
      )

      return {
        donnees: (data ?? []).map((e) => {
          const actifLe = quand.get(e.id as string)
          return {
            ...e,
            actif_le: actifLe ?? null,
            provisoire: actifLe ? new Date(actifLe) > new Date() : false,
          }
        }),
      }
    },
  )

  app.post(
    "/enfants",
    {
      preHandler: exigerSession,
      schema: {
        tags: ["famille"],
        summary: "Créer le compte d'un enfant",
        security: [{ porteur: [] }],
        body: {
          type: "object",
          required: ["prenom", "motDePasse"],
          properties: {
            prenom: { type: "string", minLength: 2, maxLength: 60 },
            nom: { type: "string", maxLength: 60 },
            // Court, parce qu'un enfant doit pouvoir le taper seul.
            motDePasse: { type: "string", minLength: 6, maxLength: 72 },
          },
        },
      },
    },
    async (requete, reponse) => {
      const { prenom, nom, motDePasse } = requete.body as {
        prenom: string
        nom?: string
        motDePasse: string
      }

      const { data, error } = await supabasePour(requete).rpc(
        "creer_compte_eleve",
        {
          prenom_eleve: prenom,
          nom_eleve: nom ?? null,
          mot_de_passe: motDePasse,
        },
      )

      if (error) {
        // 42501 : la base a refusé parce que l'appelant n'est pas un parent.
        // C'est un refus d'autorisation, pas une panne.
        const interdit = error.code === "42501"
        requete.log.warn({ error }, "creation d'enfant refusee")
        return reponse.code(interdit ? 403 : 400).send({
          erreur: interdit ? "reserve_aux_parents" : "creation_refusee",
          message: error.message,
        })
      }

      const ligne = Array.isArray(data) ? data[0] : data
      // 201 et l'identifiant : c'est la seule chose que le parent doit
      // retenir, et aucune adresse mail ne le lui rappellera.
      return reponse.code(201).send(ligne)
    },
  )
}
