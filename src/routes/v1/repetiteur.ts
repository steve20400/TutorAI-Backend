import type { FastifyInstance } from "fastify"

import { exigerSession, supabasePour, utilisateurDe } from "../../supabase.js"

/**
 * Le filtrage reste fermé — ce qui arrive du navigateur ne rentre pas tel
 * quel — mais la liste vient de la base, plus du code. Le système scolaire
 * camerounais bouge : une matière s'ajoute, un intitulé change. Rien de cela
 * ne devrait demander un déploiement.
 */
async function referentiel(
  supabase: ReturnType<typeof supabasePour>,
): Promise<{ matieres: string[]; niveaux: string[] }> {
  const [m, n] = await Promise.all([
    supabase.from("matieres").select("nom").eq("active", true),
    supabase.from("niveaux").select("nom").eq("actif", true),
  ])
  return {
    matieres: (m.data ?? []).map((x) => x.nom as string),
    niveaux: (n.data ?? []).map((x) => x.nom as string),
  }
}

/**
 * La fiche d'un répétiteur, vue par lui-même.
 *
 * Il relit toujours la sienne, même refusée : sans cela il ne saurait pas ce
 * qu'on lui reproche et ne pourrait rien corriger. C'est la politique
 * `qui voit une fiche de repetiteur` qui le permet, pas ce fichier.
 *
 * Ce qu'il ne peut PAS écrire — `statut`, `verifie_le`, `motif_refus` — est
 * refusé par le déclencheur `proteger_verification_repetiteur`, quelle que
 * soit la route employée. Les champs sont quand même filtrés ici, pour que le
 * refus arrive avec un message lisible plutôt qu'une erreur de base.
 */
export async function routesRepetiteur(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", exigerSession)

  const securite = [{ porteur: [] as string[] }]

  app.get(
    "/profil",
    {
      schema: {
        tags: ["répétiteur"],
        summary: "Ma fiche",
        security: securite,
      },
    },
    async (requete, reponse) => {
      const moi = utilisateurDe(requete)
      const supabase = supabasePour(requete)

      const [fiche, profil] = await Promise.all([
        supabase
          .from("repetiteurs")
          .select(
            "id, bio, ville, matieres, niveaux, tarif_mensuel, annees_experience, disponibilites_texte, photo_url, statut, motif_refus, verifie_le",
          )
          .eq("id", moi)
          .maybeSingle(),
        supabase
          .from("profils")
          .select("prenom, nom, identifiant, telephone, desactive_le")
          .eq("id", moi)
          .maybeSingle(),
      ])

      if (fiche.error) {
        requete.log.error({ error: fiche.error }, "lecture de la fiche impossible")
        return reponse.code(502).send({
          erreur: "base_indisponible",
          message: "Impossible de lire votre fiche pour le moment.",
        })
      }

      return { fiche: fiche.data, profil: profil.data }
    },
  )

  app.post(
    "/profil",
    {
      schema: {
        tags: ["répétiteur"],
        summary: "Enregistrer ma fiche",
        description:
          "Le statut de vérification n'est pas modifiable : seule " +
          "l'administration l'écrit, et un déclencheur le garantit.",
        security: securite,
        body: {
          type: "object",
          properties: {
            bio: { type: "string", maxLength: 2000 },
            ville: { type: "string", maxLength: 80 },
            matieres: { type: "array", items: { type: "string" }, maxItems: 12 },
            niveaux: { type: "array", items: { type: "string" }, maxItems: 10 },
            tarif_mensuel: { type: "integer", minimum: 0, maximum: 10_000_000 },
            annees_experience: { type: "integer", minimum: 0, maximum: 70 },
            disponibilites_texte: { type: "string", maxLength: 500 },
          },
        },
      },
    },
    async (requete, reponse) => {
      const corps = requete.body as Record<string, unknown>
      const moi = utilisateurDe(requete)
      const connu = await referentiel(supabasePour(requete))

      // Les listes viennent du client : on ne garde que ce qui figure dans les
      // référentiels. Sans ce filtre, une matière inventée entrerait en base et
      // apparaîtrait dans l'annuaire des familles.
      const matieres = Array.isArray(corps.matieres)
        ? (corps.matieres as string[]).filter((m) => connu.matieres.includes(m))
        : undefined
      const niveaux = Array.isArray(corps.niveaux)
        ? (corps.niveaux as string[]).filter((n) => connu.niveaux.includes(n))
        : undefined

      const aEcrire: Record<string, unknown> = {
        bio: corps.bio ?? null,
        ville: corps.ville ?? null,
        tarif_mensuel: corps.tarif_mensuel ?? null,
        annees_experience: corps.annees_experience ?? null,
        disponibilites_texte: corps.disponibilites_texte ?? null,
        maj_le: new Date().toISOString(),
      }
      if (matieres) aEcrire.matieres = matieres
      if (niveaux) aEcrire.niveaux = niveaux

      // Une fiche complète passe en attente de vérification. Une fiche
      // incomplète reste en brouillon : la mettre dans la pile de
      // l'administration ferait perdre du temps aux deux côtés.
      const complete =
        Boolean(corps.ville) &&
        Boolean(corps.bio) &&
        (matieres?.length ?? 0) > 0 &&
        (niveaux?.length ?? 0) > 0

      const { data: actuelle } = await supabasePour(requete)
        .from("repetiteurs")
        .select("statut")
        .eq("id", moi)
        .maybeSingle()

      // On ne repasse en attente que depuis un brouillon ou un refus : une
      // fiche déjà vérifiée ne doit pas retomber dans la pile parce que son
      // auteur a corrigé une faute de frappe.
      if (
        complete &&
        (actuelle?.statut === "brouillon" || actuelle?.statut === "refuse")
      ) {
        aEcrire.statut = "en_attente"
      }

      const { error } = await supabasePour(requete)
        .from("repetiteurs")
        .update(aEcrire)
        .eq("id", moi)

      if (error) {
        requete.log.warn({ error }, "enregistrement de fiche refuse")
        return reponse.code(403).send({
          erreur: "enregistrement_refuse",
          message: error.message,
        })
      }

      return { ok: true, enAttente: aEcrire.statut === "en_attente" }
    },
  )
}
