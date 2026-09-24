import { anthropic } from "./anthropic.js"
import { compatible } from "./compatible.js"
import { gemini } from "./gemini.js"
import {
  ErreurIA,
  type Demande,
  type Fournisseur,
  type Morceau,
  type Reglages,
} from "./types.js"

export * from "./types.js"

const FOURNISSEURS: Record<string, Fournisseur> = {
  anthropic,
  gemini,
  compatible,
}

/**
 * La configuration du tuteur, telle qu'elle vit en base.
 *
 * Elle est passée en argument plutôt que lue ici, et ce n'est pas un détail :
 * ce module ne sait pas comment on obtient une clé secrète. Il ne peut donc
 * pas, par distraction, se mettre à la lire avec des droits qu'il n'aurait pas
 * dû avoir. Celui qui l'appelle assume cette question-là, en un seul endroit.
 */
export type Configuration = {
  fournisseur: string
  modele: string
  cle: string
  url?: string
}

/**
 * Parler au tuteur, quel qu'il soit.
 *
 * En flux, toujours. Un tuteur qui écrit progressivement paraît vivant ; un
 * tuteur qui fait attendre huit secondes paraît cassé — et sur une connexion
 * camerounaise, huit secondes est optimiste. Celui qui n'a pas besoin du
 * direct appelle `rassembler()` sur le résultat.
 */
/**
 * Attentes entre deux tentatives, en millisecondes.
 *
 * Sur un palier gratuit, « ce modèle est très demandé » arrive souvent et
 * passe en quelques secondes. Sans ces deux reprises, un élève voyait une
 * panne là où il n'y avait qu'une bousculade.
 *
 * Deux essais de plus, pas dix : au-delà, on fait attendre un enfant devant
 * un écran figé, ce qui est pire qu'un message honnête.
 */
const REPRISES = [800, 2500]

export function parler(
  demande: Demande,
  config: Configuration,
): AsyncGenerator<Morceau> {
  const f = FOURNISSEURS[config.fournisseur]

  if (!f) {
    throw new ErreurIA(
      config.fournisseur,
      500,
      `Fournisseur inconnu : « ${config.fournisseur} ». ` +
        `Attendu : ${Object.keys(FOURNISSEURS).join(", ")}.`,
    )
  }

  if (!config.cle && config.fournisseur !== "compatible") {
    // Le compatible peut tourner sans clé — un serveur local n'en demande
    // souvent pas. Les deux autres, jamais.
    throw new ErreurIA(
      config.fournisseur,
      503,
      "Aucune clé n'est enregistrée pour ce fournisseur.",
    )
  }

  const reglages: Reglages = { cle: config.cle, url: config.url }
  return avecReprises(f, demande, reglages)
}

/**
 * Réessaie tant que rien n'est encore parti à l'écran.
 *
 * La nuance compte : dès qu'un premier morceau de texte est affiché, on ne
 * peut plus recommencer — l'élève verrait la réponse repartir du début, ou
 * deux débuts se succéder. On ne reprend donc que si l'échec est survenu
 * avant le premier mot.
 */
async function* avecReprises(
  f: Fournisseur,
  demande: Demande,
  reglages: Reglages,
): AsyncGenerator<Morceau> {
  for (let essai = 0; ; essai++) {
    let rienDitEncore = true

    try {
      for await (const morceau of f.flux(demande, reglages)) {
        if (morceau.type === "texte") rienDitEncore = false
        yield morceau
      }
      return
    } catch (e) {
      const passagere = e instanceof ErreurIA && e.passagere
      const reste = essai < REPRISES.length

      if (!passagere || !reste || !rienDitEncore) throw e

      await new Promise((r) => setTimeout(r, REPRISES[essai]))
    }
  }
}

/** Les noms acceptés par `ia_fournisseur`, pour valider un réglage. */
export const FOURNISSEURS_CONNUS = Object.keys(FOURNISSEURS)
