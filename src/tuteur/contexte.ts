import { detaillerLecon, tableDesMatieres, trouverLecon, type Lecon, type Programme } from "./programme.js"
import { PROMPT_TUTEUR } from "./prompt.js"
import type { Demande, Message } from "../ia/index.js"

/**
 * Ce que le tuteur reçoit avant chaque réplique.
 *
 * Le modèle n'est JAMAIS entraîné. Il reçoit à chaque requête les règles, le
 * programme officiel, la leçon du jour, la mémoire de l'élève et le fil de la
 * conversation — puis il oublie tout. C'est l'application qui se souvient.
 *
 * Le découpage en trois couches n'est pas décoratif : il décide de la facture.
 * Les règles et le programme ne changent pas d'un message à l'autre, donc ils
 * sont mis en cache chez le fournisseur. La leçon et la mémoire changent, donc
 * elles viennent après le repère de cache.
 */

export type MemoireEleve = {
  notions_acquises: string[]
  notions_fragiles: string[]
  erreurs_recurrentes: string[]
}

export type ContexteSeance = {
  prenomEleve: string
  niveau: string
  pays: string
  matiere: string
  mode: "texte" | "audio"
  /**
   * Nul quand l'élève a nommé sa matière lui-même : aucun programme officiel
   * n'est chargé pour elle.
   */
  programme: Programme | null
  memoire: MemoireEleve | null
  leconTitre: string | null
  historique: Array<{ auteur: string; contenu: string }>
  /** Texte extrait d'une photo du manuel. Éphémère : jamais écrit en base. */
  pageDuJour?: string
}

/** Les règles, avec le nom de l'élève dedans. Ne change pas d'un message à l'autre. */
function regles(c: ContexteSeance): string {
  return PROMPT_TUTEUR.replaceAll("{{PRENOM_ELEVE}}", c.prenomEleve)
    .replaceAll("{{NIVEAU}}", c.niveau)
    .replaceAll("{{PAYS}}", c.pays)
    .replaceAll("{{MATIERE}}", c.matiere)
}

/** Ce qui change à chaque séance : la leçon, ce que l'élève sait déjà, la page photographiée. */
function volatil(c: ContexteSeance, lecon: Lecon | null): string {
  const blocs: string[] = []

  blocs.push(
    lecon
      ? `LECON_DU_JOUR :\n${detaillerLecon(lecon)}`
      : "LECON_DU_JOUR : non encore identifiée. Demande à l'élève de préciser ce qui a été fait en classe, puis retrouve la leçon dans la table des matières.",
  )

  if (c.memoire) {
    blocs.push(
      [
        "HISTORIQUE :",
        `Notions acquises : ${c.memoire.notions_acquises.join(" ; ") || "(aucune encore)"}`,
        `Notions fragiles : ${c.memoire.notions_fragiles.join(" ; ") || "(aucune encore)"}`,
        `Erreurs récurrentes : ${c.memoire.erreurs_recurrentes.join(" ; ") || "(aucune encore)"}`,
      ].join("\n"),
    )
  }

  // Éphémère par construction : présent dans la requête, absent de la base.
  if (c.pageDuJour) {
    blocs.push(
      `PAGE_DU_JOUR (photo du manuel, valable pour cette séance uniquement — reformule, ne recopie jamais) :\n${c.pageDuJour}`,
    )
  }

  blocs.push(`MODE : ${c.mode}`)
  return blocs.join("\n\n")
}

/** La demande complète, prête pour n'importe lequel des trois fournisseurs. */
export function demandePourLeTuteur(
  c: ContexteSeance,
  modele: string,
  maxJetons: number,
): Demande {
  const dernierProposEleve =
    [...c.historique].reverse().find((m) => m.auteur === "eleve")?.contenu ?? ""

  const lecon = c.programme
    ? trouverLecon(c.programme, c.leconTitre ?? dernierProposEleve)
    : null

  const messages: Message[] = c.historique.map((m) => ({
    role: m.auteur === "eleve" ? "utilisateur" : "tuteur",
    contenu: m.contenu,
  }))

  return {
    systeme: regles(c),
    // Sans programme, on le DIT au modèle plutôt que de le laisser inventer
    // une progression. Un tuteur qui prétend suivre un programme qu'il n'a
    // pas est pire qu'un tuteur qui avoue ne pas l'avoir : l'élève le croit.
    stable: c.programme
      ? `PROGRAMME OFFICIEL — ${c.niveau}, ${c.matiere}\n\n${tableDesMatieres(c.programme)}`
      : `AUCUN PROGRAMME OFFICIEL n'est chargé pour ${c.matiere} en ${c.niveau}.\n\n` +
        `Tu travailles donc sans table des matières. Dis-le simplement à l'élève ` +
        `dès ta première réponse — une phrase suffit — puis demande-lui ce que ` +
        `sa classe a fait récemment, et pars de là. N'invente jamais une ` +
        `progression officielle que tu n'as pas : il te croirait.`,
    volatil: volatil(c, lecon),
    messages,
    modele,
    maxJetons,
  }
}

/**
 * Ce que le tuteur répond quand il préfère ne pas répondre.
 *
 * Réservé à un refus décidé par le modèle. Une panne technique ne doit JAMAIS
 * emprunter cette phrase : l'enfant croirait que son tuteur l'a rembarré, et
 * la phrase resterait dans son historique pour toujours.
 */
export const REFUS =
  "Je préfère ne pas répondre à ça. Revenons à ton programme : sur quelle leçon veux-tu travailler ?"
