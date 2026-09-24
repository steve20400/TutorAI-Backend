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

  /**
   * Créer un ou plusieurs tuteurs, un par matière choisie.
   *
   * Les programmes sont RELUS ici : le client envoie des identifiants, et
   * seuls ceux qui existent et sont publiés sont retenus. Sans cette relecture,
   * un identifiant fabriqué créerait un tuteur sur une matière que la
   * plateforme ne couvre pas — et le modèle recevrait un programme vide.
   *
   * La mémoire naît avec le tuteur, vide. La créer plus tard, au premier
   * message, ferait dépendre l'existence d'une ligne d'un échange qui peut
   * échouer.
   */
  app.post(
    "/",
    {
      schema: {
        tags: ["tuteur"],
        summary: "Créer ses tuteurs",
        security: securite,
        body: {
          type: "object",
          properties: {
            programmeIds: {
              type: "array",
              items: { type: "string", format: "uuid" },
              maxItems: 12,
            },
            /**
             * Les matières que l'élève a nommées lui-même, faute de programme
             * officiel chargé pour elles. Le niveau vient avec, puisque aucun
             * programme ne le porte.
             */
            libres: {
              type: "array",
              maxItems: 12,
              items: {
                type: "object",
                required: ["matiere", "niveau"],
                properties: {
                  matiere: { type: "string", minLength: 2, maxLength: 60 },
                  niveau: { type: "string", minLength: 1, maxLength: 40 },
                },
              },
            },
            manuels: {
              type: "array",
              items: {
                type: "object",
                properties: { titre: { type: "string", maxLength: 200 } },
              },
              maxItems: 20,
            },
          },
        },
      },
    },
    async (requete, reponse) => {
      const { programmeIds = [], libres = [], manuels = [] } = requete.body as {
        programmeIds?: string[]
        libres?: { matiere: string; niveau: string }[]
        manuels?: { titre: string }[]
      }
      const moi = utilisateurDe(requete)
      const supabase = supabasePour(requete)

      if (programmeIds.length === 0 && libres.length === 0) {
        return reponse.code(400).send({
          erreur: "aucune_matiere",
          message: "Choisis au moins une matière.",
        })
      }

      // Les programmes sont relus ici : le client a pu envoyer n'importe quel
      // identifiant, et seuls les programmes publiés comptent.
      const { data: programmes } = programmeIds.length
        ? await supabase
            .from("programmes")
            .select("id, niveau, matiere")
            .in("id", programmeIds)
            .eq("publie", true)
        : { data: [] as Array<{ id: string; niveau: string; matiere: string }> }

      if (programmeIds.length > 0 && !programmes?.length) {
        return reponse.code(400).send({
          erreur: "programme_introuvable",
          message: "Aucun de ces programmes n'existe.",
        })
      }

      // Une matière écrite par un élève entre au catalogue, pour être
      // proposée au suivant. C'est la demande qui dira à l'administration
      // quels programmes charger ensuite — plutôt qu'une intuition.
      const propres = libres
        .map((l) => ({ matiere: net(l.matiere), niveau: net(l.niveau) }))
        .filter((l) => l.matiere.length >= 2 && l.niveau.length >= 1)

      if (propres.length) {
        await supabase.from("matieres").upsert(
          propres.map((l) => ({
            nom: l.matiere,
            ordre: 500,
            active: true,
            proposee_par_un_eleve: true,
          })),
          { onConflict: "nom", ignoreDuplicates: true },
        )
      }

      const aCreer = [
        ...(programmes ?? []).map((p) => ({
          eleve_id: moi,
          programme_id: p.id,
          matiere: p.matiere,
          niveau: p.niveau,
          manuels,
        })),
        ...propres.map((l) => ({
          eleve_id: moi,
          programme_id: null,
          matiere: l.matiere,
          niveau: l.niveau,
          manuels,
        })),
      ]

      const { data: crees, error } = await supabase
        .from("tuteurs_ia")
        .insert(aCreer)
        .select("id, matiere, niveau")

      if (error || !crees) {
        requete.log.warn({ error }, "creation de tuteur refusee")
        return reponse.code(403).send({
          erreur: "creation_refusee",
          message: error?.message ?? "La création a échoué.",
        })
      }

      await supabase
        .from("memoire_eleve")
        .insert(crees.map((t) => ({ tuteur_id: t.id })))

      return reponse.code(201).send({ donnees: crees })
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

/**
 * Nettoie ce qu'un élève a tapé.
 *
 * Espaces en trop, casse d'affichage. Sans cela « anglais », « Anglais  » et
 * « ANGLAIS » deviendraient trois matières distinctes dans le catalogue, et
 * l'élève suivant se verrait proposer les trois.
 */
function net(valeur: string): string {
  const propre = valeur.trim().replace(/\s+/g, " ")
  return propre.charAt(0).toUpperCase() + propre.slice(1)
}
