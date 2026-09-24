import pg from "pg"

import type { Configuration } from "./index.js"

/**
 * Où le service va chercher la clé du tuteur.
 *
 * Par une connexion Postgres dédiée, avec le rôle `service_ia`, dont le seul
 * droit au monde est d'exécuter `cle_du_fournisseur()`. Il ne peut lire ni les
 * profils, ni les séances, ni les messages, ni même la table des clés — c'est
 * vérifié dans la migration 031.
 *
 * Pourquoi pas le client Supabase habituel : il ne sait s'authentifier qu'avec
 * la clé publiable ou le jeton de la personne connectée. La première n'a aucun
 * droit sur `cles_api`, et le second appartient à un visiteur qui n'a rien à y
 * voir. Il aurait fallu un jeton de service, qui peut tout lire — c'est
 * précisément ce qu'on refuse au service.
 *
 * Et pourquoi pas la clé directement dans l'environnement : parce que Steve
 * devrait alors retourner sur le serveur chaque fois qu'il change de
 * fournisseur. Là, il la change depuis son espace d'administration, et le
 * message suivant part avec la nouvelle.
 */

/**
 * Une seule connexion, gardée ouverte.
 *
 * Ouvrir une connexion Postgres coûte un aller-retour et une poignée de main
 * TLS — sur le palier gratuit de Render, qui dort, ce serait une seconde
 * ajoutée au premier message de chaque réveil.
 */
let bassin: pg.Pool | null = null

function connexion(): pg.Pool | null {
  const url = process.env.BASE_SERVICE_IA
  if (!url) return null

  bassin ??= new pg.Pool({
    connectionString: url,
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Supabase présente un certificat valide ; on ne désactive rien.
  })
  return bassin
}

/**
 * La configuration en vigueur, relue régulièrement.
 *
 * Pas à chaque message : ce serait un aller-retour de base avant chaque
 * réplique du tuteur, pour une valeur qui change trois fois par an. Pas au
 * démarrage non plus : Steve changerait sa clé et devrait redémarrer le
 * service, ce qui est exactement ce qu'on cherchait à éviter.
 *
 * Trente secondes est le compromis : le temps qu'il faut pour aller de
 * « Enregistrer » à « essayons voir ».
 */
const DUREE_MEMOIRE = 30_000
let memoire: { valeur: Configuration; pose: number } | null = null

export type ConfigurationComplete = Configuration & {
  /** Le modèle servi à qui a un compte, quand il diffère de celui d'essai. */
  modeleCompte: string
}

export async function configurationDuTuteur(
  maintenant: number,
): Promise<ConfigurationComplete> {
  if (memoire && maintenant - memoire.pose < DUREE_MEMOIRE) {
    return memoire.valeur as ConfigurationComplete
  }

  const bassin = connexion()
  if (!bassin) {
    throw new ErreurConfiguration(
      "BASE_SERVICE_IA n'est pas réglée : le service ne peut pas lire la clé du tuteur.",
    )
  }

  const { rows } = await bassin.query<{
    fournisseur: string
    modele_essai: string
    modele_compte: string
    cle: string
    url: string
  }>("select * from cle_du_fournisseur()")

  const l = rows[0]
  if (!l) throw new ErreurConfiguration("La base n'a renvoyé aucune configuration.")

  const valeur: ConfigurationComplete = {
    fournisseur: l.fournisseur,
    modele: l.modele_essai,
    modeleCompte: l.modele_compte || l.modele_essai,
    cle: l.cle,
    url: l.url || undefined,
  }

  memoire = { valeur, pose: maintenant }
  return valeur
}

/**
 * Inscrit ce qu'une réponse a coûté.
 *
 * Par la connexion du service, et non avec le jeton de l'élève : si le site
 * écrivait ces lignes en son nom, l'élève pourrait les écrire lui-même — et
 * minorer sa consommation. Le jour où un abonnement repose là-dessus, ce
 * serait la porte ouverte.
 *
 * Le rôle `service_ia` peut ajouter ici, et rien d'autre : il ne peut ni
 * relire ce registre, ni le modifier, ni l'effacer.
 *
 * Un échec n'interrompt jamais la conversation : mieux vaut une ligne de
 * comptabilité perdue qu'un élève qui perd sa réponse. Il part au journal.
 */
export async function inscrireConsommation(ligne: {
  compteId: string
  payePar?: string | null
  seanceId?: string | null
  fournisseur: string
  modele: string
  entree: number
  sortie: number
  approximatif: boolean
}): Promise<void> {
  const bassin = connexion()
  if (!bassin) return

  await bassin.query(
    `insert into consommation_ia
       (compte_id, paye_par, seance_id, fournisseur, modele,
        jetons_entree, jetons_sortie, approximatif)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      ligne.compteId,
      ligne.payePar ?? ligne.compteId,
      ligne.seanceId ?? null,
      ligne.fournisseur,
      ligne.modele,
      ligne.entree,
      ligne.sortie,
      ligne.approximatif,
    ],
  )
}

/**
 * Retire des jetons de la réserve du payeur.
 *
 * Par la connexion du service, comme le registre de consommation : si le site
 * débitait avec le jeton de l'élève, l'élève pourrait ne pas se débiter.
 *
 * Rend le solde restant.
 */
export async function debiterJetons(
  payeur: string,
  combien: number,
): Promise<number> {
  const bassin = connexion()
  if (!bassin) return 0

  const { rows } = await bassin.query<{ debiter_jetons: string }>(
    "select debiter_jetons($1, $2)",
    [payeur, Math.max(0, Math.round(combien))],
  )
  return Number(rows[0]?.debiter_jetons ?? 0)
}

/** Après un changement de clé, pour ne pas attendre les trente secondes. */
export function oublierLaConfiguration(): void {
  memoire = null
}

export class ErreurConfiguration extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ErreurConfiguration"
  }
}

/** Ferme proprement à l'arrêt du service. */
export async function fermerLaConnexion(): Promise<void> {
  await bassin?.end()
  bassin = null
}
