import type { FastifyInstance } from "fastify"

import { exigerSession, supabasePour, utilisateurDe } from "../../supabase.js"

/**
 * Le rattachement d'un adulte à un enfant.
 *
 * L'adulte demande, l'enfant reconnaît. Jamais l'inverse : faire saisir à
 * l'adulte le mot de passe de l'enfant serait la preuve la plus forte, et la
 * pire — elle apprendrait à chaque enfant de la plateforme que donner son mot
 * de passe à un adulte qui l'aide est la procédure normale.
 *
 * Rien n'est décidé ici. Les trois fonctions SQL portent les règles : le
 * silence sur l'existence du compte, le plafond de trois demandes, le refus
 * définitif, les quarante-huit heures de lien provisoire et le signalement au
 * dixième refus. Cette route ne fait que les appeler.
 */
export async function routesLiens(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", exigerSession)

  const securite = [{ porteur: [] as string[] }]

  app.post(
    "/liens/demande",
    {
      schema: {
        tags: ["liens"],
        summary: "Demander à être rattaché à un enfant",
        description:
          "Ne dit jamais si le compte existe : un adulte qui essaierait des " +
          "noms au hasard obtient exactement la même réponse dans tous les cas.",
        security: securite,
        body: {
          type: "object",
          required: ["nom"],
          properties: { nom: { type: "string", minLength: 2, maxLength: 80 } },
        },
      },
    },
    async (requete, reponse) => {
      const { nom } = requete.body as { nom: string }

      const { error } = await supabasePour(requete).rpc(
        "demander_rattachement",
        { nom_enfant: nom },
      )

      if (error) {
        requete.log.warn({ error }, "demande de rattachement refusee")
        return reponse.code(403).send({
          erreur: "demande_refusee",
          message: error.message,
        })
      }

      // Toujours la même réponse. C'est le propos.
      return { ok: true }
    },
  )

  app.get(
    "/liens/a-reconnaitre",
    {
      schema: {
        tags: ["liens"],
        summary: "Les adultes qui disent être mes parents",
        description:
          "Un prénom, un nom, une photo. Ni adresse ni téléphone : cet écran " +
          "ne doit pas devenir un moyen d'apprendre comment joindre un " +
          "adulte hors de la plateforme.",
        security: securite,
      },
    },
    async (requete) => {
      const { data } = await supabasePour(requete).rpc("demandes_a_reconnaitre")
      return { donnees: data ?? [] }
    },
  )

  app.post(
    "/liens/:id/reponse",
    {
      schema: {
        tags: ["liens"],
        summary: "Reconnaître un adulte, ou non",
        security: securite,
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["oui"],
          properties: { oui: { type: "boolean" } },
        },
      },
    },
    async (requete, reponse) => {
      const { id } = requete.params as { id: string }
      const { oui } = requete.body as { oui: boolean }

      const { error } = await supabasePour(requete).rpc(
        "repondre_rattachement",
        { demande: id, oui },
      )

      if (error) {
        requete.log.warn({ error }, "reponse au rattachement refusee")
        return reponse.code(403).send({
          erreur: "reponse_refusee",
          message: error.message,
        })
      }

      return { ok: true }
    },
  )

  app.post(
    "/liens/enfants/:id/detacher",
    {
      schema: {
        tags: ["liens"],
        summary: "Se détacher d'un enfant",
        description:
          "L'adulte se retire, il ne retire pas l'enfant : il n'agit que sur " +
          "son propre lien, et rien de ce que l'enfant possède n'est touché. " +
          "Ses séances, son registre et son compte restent à lui. Ce qui part " +
          "est l'accès de cet adulte à son dossier, sa capacité à lui reposer " +
          "un mot de passe, et sa place parmi ceux qui peuvent payer ses " +
          "séances.",
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

      const { error } = await supabasePour(requete).rpc("detacher_enfant", {
        enfant: id,
      })

      if (error) {
        requete.log.warn({ error }, "detachement refuse")
        return reponse.code(403).send({
          erreur: "detachement_refuse",
          message: error.message,
        })
      }

      return { ok: true }
    },
  )

  app.post(
    "/liens/adultes/:id/couper",
    {
      schema: {
        tags: ["liens"],
        summary: "L'enfant coupe un rattachement",
        description:
          "L'enfant retire un adulte de son compte. Le miroir exact du " +
          "détachement côté adulte : la demande acceptée est effacée, donc " +
          "le rattachement peut se refaire par la procédure normale. Se " +
          "détacher n'est pas refuser — un refus, lui, reste définitif et " +
          "muet.",
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

      const { error } = await supabasePour(requete).rpc("couper_rattachement", {
        adulte: id,
      })

      if (error) {
        requete.log.warn({ error }, "coupure de rattachement refusee")
        return reponse.code(403).send({
          erreur: "coupure_refusee",
          message: error.message,
        })
      }

      return { ok: true }
    },
  )

  app.get(
    "/liens/mes-parents",
    {
      schema: {
        tags: ["liens"],
        summary: "Les adultes rattachés à moi, vus par l'enfant",
        description:
          "Un prénom, une photo, et qui porte les séances. Ni adresse ni " +
          "téléphone : cet écran ne doit pas devenir un moyen d'apprendre " +
          "comment joindre un adulte hors de la plateforme.",
        security: securite,
      },
    },
    async (requete) => {
      const moi = utilisateurDe(requete)
      const supabase = supabasePour(requete)

      // `mes_adultes()` et non deux requêtes : la politique de lecture de
      // `profils` n'autorise pas un enfant à lire le profil de son adulte —
      // seulement l'inverse. La liste revenait donc vide alors que le lien
      // existait. L'élargir donnerait la ligne entière, téléphone compris ;
      // la fonction rend le prénom, l'image, et rien d'autre.
      const [{ data: adultes }, { data: jauge }] = await Promise.all([
        supabase.rpc("mes_adultes"),
        supabase.rpc("jauge_detaillee", { eleve: moi }),
      ])

      const mesure = (jauge as Array<{
        actif: boolean
        etat: string
        part: number
        payeur: string | null
      }> | null)?.[0]

      return {
        // `actif` faux tant que le module de jetons est éteint : l'écran
        // n'affiche alors aucune jauge. Un anneau plein qui ne bouge jamais
        // n'est pas une information, c'est du bruit.
        actif: mesure?.actif ?? false,
        etat: mesure?.etat ?? "illimite",
        part: mesure?.part ?? 100,
        payeur: mesure?.payeur ?? null,
        donnees: (adultes ?? []) as Array<{
          id: string
          prenom: string | null
          photo_url: string | null
          porte: boolean
          fournit: boolean
          provisoire: boolean
        }>,
      }
    },
  )

  app.post(
    "/liens/:parentId/porter",
    {
      schema: {
        tags: ["liens"],
        summary: "Choisir quel adulte porte mes séances",
        security: securite,
        params: {
          type: "object",
          required: ["parentId"],
          properties: { parentId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (requete, reponse) => {
      const { parentId } = requete.params as { parentId: string }

      // Par la fonction, et non par un UPDATE : ouvrir la table en
      // modification aurait demandé des droits par colonne, et les droits par
      // colonne valent pour un rôle entier. L'enfant aurait pu décider qui
      // fournit, et l'adulte qui porte.
      const { error } = await supabasePour(requete).rpc("choisir_porteur", {
        parent: parentId,
      })

      if (error) {
        return reponse.code(403).send({
          erreur: "choix_refuse",
          message: error.message,
        })
      }

      return { ok: true }
    },
  )

  app.post(
    "/liens/:eleveId/fournir",
    {
      schema: {
        tags: ["liens"],
        summary: "Décider si l'on fournit les jetons de cet enfant",
        description:
          "Parents séparés, oncle rattaché par courtoisie : sans cet " +
          "interrupteur, on importerait des conflits de famille dans " +
          "l'application.",
        security: securite,
        params: {
          type: "object",
          required: ["eleveId"],
          properties: { eleveId: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["oui"],
          properties: { oui: { type: "boolean" } },
        },
      },
    },
    async (requete, reponse) => {
      const { eleveId } = requete.params as { eleveId: string }
      const { oui } = requete.body as { oui: boolean }

      const { error } = await supabasePour(requete).rpc("fournir_les_jetons", {
        eleve: eleveId,
        oui,
      })

      if (error) {
        return reponse.code(403).send({
          erreur: "refus",
          message: error.message,
        })
      }

      return { ok: true }
    },
  )

  app.get(
    "/liens/mots-de-passe",
    {
      schema: {
        tags: ["liens"],
        summary: "Les enfants qui ont demandé un nouveau mot de passe",
        security: securite,
      },
    },
    async (requete) => {
      const { data } = await supabasePour(requete).rpc(
        "demandes_de_mot_de_passe",
      )
      return { donnees: data ?? [] }
    },
  )

  app.post(
    "/liens/mots-de-passe/:id",
    {
      schema: {
        tags: ["liens"],
        summary: "Poser le nouveau mot de passe d'un enfant",
        description:
          "La demande vaut dix minutes et ne sert qu'une fois. Le courriel " +
          "parti chez les autres adultes ne vaut plus rien dès qu'elle est " +
          "utilisée : la première réponse clôt la question, des deux côtés.",
        security: securite,
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["motDePasse"],
          properties: {
            motDePasse: { type: "string", minLength: 6, maxLength: 200 },
          },
        },
      },
    },
    async (requete, reponse) => {
      const { id } = requete.params as { id: string }
      const { motDePasse } = requete.body as { motDePasse: string }

      const { error } = await supabasePour(requete).rpc(
        "poser_mot_de_passe_enfant",
        { demande: id, nouveau: motDePasse },
      )

      if (error) {
        const perimee = error.code === "53400"
        return reponse.code(perimee ? 410 : 403).send({
          erreur: perimee ? "demande_perimee" : "refus",
          message: error.message,
        })
      }

      return { ok: true }
    },
  )

  app.post(
    "/liens/mots-de-passe/:eleveId/renvoyer",
    {
      schema: {
        tags: ["liens"],
        summary: "Renvoyer une demande de mot de passe",
        description:
          "La precedente se ferme a la seconde : deux demandes vivantes, ce " +
          "serait deux liens valables pour un seul besoin, et le plus ancien " +
          "traine dans une boite de courriel longtemps apres avoir ete oublie.",
        security: securite,
        params: {
          type: "object",
          required: ["eleveId"],
          properties: { eleveId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (requete, reponse) => {
      const { eleveId } = requete.params as { eleveId: string }

      const { error } = await supabasePour(requete).rpc(
        "renvoyer_demande_mot_de_passe",
        { enfant: eleveId },
      )

      if (error) {
        return reponse.code(403).send({ erreur: "refus", message: error.message })
      }

      return { ok: true }
    },
  )
}
