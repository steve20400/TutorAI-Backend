import { createClient } from "@supabase/supabase-js"
import type { FastifyInstance } from "fastify"

import { config } from "../../config.js"
import { exigerSession, supabasePour, utilisateurDe } from "../../supabase.js"

/**
 * Son propre compte : nom, identifiant, photo, mot de passe.
 *
 * Exister pour que personne n'ait à ouvrir la base pour changer un mot de
 * passe. Manipuler Postgres à la main pour une opération courante, c'est
 * s'exposer à la fausse manœuvre qui efface autre chose — et il n'y a pas de
 * bouton « annuler » sur un `delete`.
 */
export async function routesCompte(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", exigerSession)

  const securite = [{ porteur: [] as string[] }]

  app.get(
    "/",
    {
      schema: {
        tags: ["compte"],
        summary: "Mon profil complet",
        security: securite,
      },
    },
    async (requete, reponse) => {
      const { data, error } = await supabasePour(requete)
        .from("profils")
        .select("id, prenom, nom, role, identifiant, telephone, pays, photo_url, cree_le")
        .eq("id", utilisateurDe(requete))
        .maybeSingle()

      if (error || !data) {
        return reponse.code(502).send({
          erreur: "base_indisponible",
          message: "Impossible de lire votre profil pour le moment.",
        })
      }

      return data
    },
  )

  app.post(
    "/",
    {
      schema: {
        tags: ["compte"],
        summary: "Modifier mon profil",
        description:
          "L'identifiant n'est modifiable que par l'administration : un " +
          "déclencheur le garantit, et il sert de nom de connexion.",
        security: securite,
        body: {
          type: "object",
          properties: {
            prenom: { type: "string", minLength: 1, maxLength: 60 },
            nom: { type: "string", maxLength: 60 },
            telephone: { type: "string", maxLength: 30 },
            identifiant: { type: "string", minLength: 3, maxLength: 40 },
            photo_url: { type: "string", maxLength: 500 },
          },
        },
      },
    },
    async (requete, reponse) => {
      const corps = requete.body as Record<string, unknown>
      const aEcrire: Record<string, unknown> = {}

      for (const champ of ["prenom", "nom", "telephone", "photo_url"]) {
        if (corps[champ] !== undefined) {
          aEcrire[champ] = corps[champ] === "" ? null : corps[champ]
        }
      }

      // L'identifiant en majuscules sans espaces : c'est un nom de connexion,
      // pas un pseudonyme. « Galilée » et « GALILEE » doivent mener au même
      // compte, et un espace en fin de saisie ne doit pas créer un doublon
      // invisible.
      if (typeof corps.identifiant === "string" && corps.identifiant.trim()) {
        aEcrire.identifiant = corps.identifiant
          .trim()
          .toUpperCase()
          .replace(/\s+/g, "-")
      }

      if (Object.keys(aEcrire).length === 0) return { ok: true }

      const { error } = await supabasePour(requete)
        .from("profils")
        .update(aEcrire)
        .eq("id", utilisateurDe(requete))

      if (error) {
        requete.log.warn({ error }, "modification de profil refusee")
        // 23505 : l'identifiant est déjà pris. Le dire, plutôt qu'un refus
        // muet devant lequel on ressaie le même.
        const pris = error.code === "23505"
        return reponse.code(pris ? 409 : 403).send({
          erreur: pris ? "identifiant_pris" : "modification_refusee",
          message: pris
            ? "Cet identifiant est déjà utilisé par un autre compte."
            : error.message,
        })
      }

      return { ok: true }
    },
  )

  app.post(
    "/mot-de-passe",
    {
      schema: {
        tags: ["compte"],
        summary: "Changer mon mot de passe",
        description:
          "Le mot de passe actuel est exigé. Sans lui, quelqu'un trouvant " +
          "une session ouverte — un ordinateur non verrouillé — prendrait le " +
          "compte et en fermerait la porte derrière lui.",
        security: securite,
        body: {
          type: "object",
          required: ["actuel", "nouveau"],
          properties: {
            actuel: { type: "string", minLength: 1, maxLength: 72 },
            nouveau: { type: "string", minLength: 8, maxLength: 72 },
          },
        },
      },
    },
    async (requete, reponse) => {
      const { actuel, nouveau } = requete.body as {
        actuel: string
        nouveau: string
      }

      const supabase = supabasePour(requete)

      const { data: moi } = await supabase.auth.getUser()
      const courriel = moi.user?.email
      if (!courriel) {
        return reponse.code(409).send({
          erreur: "sans_adresse",
          message: "Ce compte n'a pas d'adresse et ne peut pas être vérifié.",
        })
      }

      // Vérification dans un client neuf, sans session : un `signInWithPassword`
      // sur le client de la requête remplacerait le jeton en cours par celui de
      // la vérification. Ici, l'appel est isolé et n'a aucun effet de bord.
      const verificateur = createClient(
        config.supabase.url,
        config.supabase.clePubliable,
        { auth: { persistSession: false, autoRefreshToken: false } },
      )

      const { error: mauvais } = await verificateur.auth.signInWithPassword({
        email: courriel,
        password: actuel,
      })

      if (mauvais) {
        return reponse.code(403).send({
          erreur: "mot_de_passe_incorrect",
          message: "Le mot de passe actuel ne correspond pas.",
        })
      }

      const { error } = await supabase.auth.updateUser({ password: nouveau })

      if (error) {
        requete.log.warn({ error }, "changement de mot de passe refuse")
        return reponse.code(400).send({
          erreur: "changement_refuse",
          message: error.message,
        })
      }

      return { ok: true }
    },
  )
}
