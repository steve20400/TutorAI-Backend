import { anthropic } from "./anthropic.js"
import { compatible } from "./compatible.js"
import { gemini } from "./gemini.js"
import { ErreurIA, type Demande, type Fournisseur, type Morceau, type Reglages } from "./types.js"

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
  return f.flux(demande, reglages)
}

/** Les noms acceptés par `ia_fournisseur`, pour valider un réglage. */
export const FOURNISSEURS_CONNUS = Object.keys(FOURNISSEURS)
