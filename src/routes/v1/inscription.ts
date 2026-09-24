import type { FastifyInstance } from "fastify"

import { supabasePour } from "../../supabase.js"

/**
 * L'inscription d'un enfant venu seul.
 *
 * Sans session — c'est tout le propos : il entend parler de TUTELA, il vient
 * essayer le tuteur, personne ne l'a inscrit.
 *
 * Il n'a pas d'adresse électronique et on ne lui en demande pas. Une adresse
 * est un canal vers lui qui ne passe pas par la plateforme, et tout le produit
 * est bâti pour qu'aucun adulte n'ait de canal privé vers un enfant. La
 * conséquence est qu'il ne peut pas récupérer son mot de passe tant qu'aucun
 * adulte ne lui est rattaché : l'écran le lui dit avant qu'il ne choisisse.
 *
 * Le plafond horaire vit dans la fonction SQL, pas ici : c'est le seul endroit
 * de la plateforme où un visiteur anonyme écrit dans `auth.users`, et le
 * compteur doit être verrouillé dans la même transaction que la création —
 * sans quoi deux demandes simultanées passent toutes les deux.
 */
export async function routesInscription(app: FastifyInstance): Promise<void> {
  app.post(
    "/inscription/enfant",
    {
      schema: {
        tags: ["inscription"],
        summary: "Créer un compte d'enfant, sans adresse ni adulte",
        body: {
          type: "object",
          required: ["prenom", "motDePasse"],
          properties: {
            prenom: { type: "string", minLength: 2, maxLength: 60 },
            nom: { type: "string", maxLength: 60 },
            motDePasse: { type: "string", minLength: 6, maxLength: 200 },
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
        "creer_compte_enfant_seul",
        {
          prenom_eleve: prenom,
          nom_eleve: nom ?? null,
          mot_de_passe: motDePasse,
        },
      )

      if (error) {
        // 53400 est le code que la fonction lève quand le plafond horaire est
        // atteint. On le distingue : ce n'est pas la faute de l'enfant, et le
        // message doit lui dire de réessayer plutôt que de le renvoyer.
        const trop = error.code === "53400"
        requete.log.warn({ error }, "inscription d'enfant refusee")

        return reponse.code(trop ? 429 : 400).send({
          erreur: trop ? "trop_d_inscriptions" : "inscription_refusee",
          message: error.message,
        })
      }

      const ligne = (data as Array<{ identifiant: string }> | null)?.[0]
      if (!ligne) {
        return reponse.code(500).send({
          erreur: "inscription_incomplete",
          message: "Le compte n'a pas pu être créé.",
        })
      }

      // L'identifiant seulement : c'est avec lui que l'enfant se connectera,
      // et c'est la seule chose dont le site ait besoin pour ouvrir sa
      // session dans la foulée.
      return { identifiant: ligne.identifiant }
    },
  )
}

/**
 * L'enfant demande un nouveau mot de passe.
 *
 * Sans session — c'est tout le propos, il l'a perdu. Il donne son nom de
 * connexion, pas une adresse : il n'en a pas.
 *
 * La réponse est toujours la même. Dire « ce compte n'existe pas » ou « cet
 * enfant n'a aucun adulte rattaché » ferait de ce champ un annuaire des
 * enfants inscrits, et pire : il dirait lesquels sont seuls.
 */
export async function routesRecuperationEnfant(
  app: FastifyInstance,
): Promise<void> {
  app.post(
    "/recuperation/enfant",
    {
      schema: {
        tags: ["inscription"],
        summary: "Demander un nouveau mot de passe pour un compte d'enfant",
        body: {
          type: "object",
          required: ["nom"],
          properties: { nom: { type: "string", minLength: 2, maxLength: 80 } },
        },
      },
    },
    async (requete) => {
      const { nom } = requete.body as { nom: string }

      const { error } = await supabasePour(requete).rpc(
        "demander_nouveau_mot_de_passe",
        { nom_enfant: nom },
      )

      if (error) requete.log.warn({ error }, "demande de mot de passe refusee")

      // Toujours la même réponse, erreur comprise.
      return { ok: true }
    },
  )
}
