/** Structure d'une leçon dans un programme officiel. */
export type Lecon = {
  id: string
  titre: string
  prerequis?: string[]
  habiletes?: Record<string, string[]>
  savoirs?: string[]
  savoir_faire?: string[]
}

/**
 * Extraction de la leçon pertinente dans un programme officiel.
 *
 * Le programme entier est trop volumineux pour être envoyé à chaque requête —
 * et surtout, l'envoyer en entier noie la leçon du jour. On envoie donc :
 *   - la table des matières (courte, stable → mise en cache)
 *   - le détail de la seule leçon concernée
 */

export type Programme = {
  niveau?: string
  matiere?: string
  competences?: unknown[]
  modules?: unknown[]
  [k: string]: unknown
}

/** Aplatit un programme (structure ivoirienne ou camerounaise) en liste de leçons. */
export function listerLecons(programme: Programme): Lecon[] {
  const lecons: Lecon[] = []

  const parcourir = (noeud: unknown): void => {
    if (Array.isArray(noeud)) {
      noeud.forEach(parcourir)
      return
    }
    if (noeud === null || typeof noeud !== "object") return

    const o = noeud as Record<string, unknown>

    // Une leçon se reconnaît à la présence d'un titre et d'un identifiant.
    if (typeof o.titre === "string" && typeof o.id === "string") {
      lecons.push(o as unknown as Lecon)
    }

    for (const valeur of Object.values(o)) parcourir(valeur)
  }

  parcourir(programme)
  return lecons
}

/** Table des matières : ce que le tuteur doit toujours avoir sous les yeux. */
export function tableDesMatieres(programme: Programme): string {
  const lecons = listerLecons(programme)
  if (lecons.length === 0) return "(programme non encore saisi)"
  return lecons.map((l) => `- ${l.id} : ${l.titre}`).join("\n")
}

/**
 * Normalise pour une comparaison tolérante aux accents et à la casse :
 * « Équations » et « equations » doivent se correspondre.
 *
 * La plage U+0300 a U+036F est écrite en échappements, jamais avec les
 * caractères combinants littéraux : ceux-ci sont invisibles dans un éditeur
 * et un simple reformatage les supprimerait sans que rien ne le signale.
 */
export function normaliser(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Retrouve la leçon correspondant à ce que l'élève dit avoir fait en classe.
 * Correspondance par mots-clés : l'élève écrit « les équations du second degré »,
 * pas « Leçon 1.1 ».
 */
export function trouverLecon(programme: Programme, propos: string): Lecon | null {
  const lecons = listerLecons(programme)
  if (lecons.length === 0) return null

  const mots = normaliser(propos)
    .split(" ")
    .filter((m) => m.length > 3)

  let meilleure: Lecon | null = null
  let meilleurScore = 0

  for (const lecon of lecons) {
    const titre = normaliser(lecon.titre)
    const score = mots.filter((m) => titre.includes(m)).length
    if (score > meilleurScore) {
      meilleurScore = score
      meilleure = lecon
    }
  }

  // Sous deux mots-clés communs, la correspondance n'est pas fiable :
  // mieux vaut laisser le tuteur demander une précision à l'élève.
  return meilleurScore >= 2 ? meilleure : null
}

/** Détail d'une leçon, mis en forme pour le contexte du modèle. */
export function detaillerLecon(lecon: Lecon): string {
  const lignes: string[] = [`Leçon ${lecon.id} — ${lecon.titre}`]

  if (lecon.prerequis?.length) {
    lignes.push(`Prérequis : ${lecon.prerequis.join(" ; ")}`)
  }

  if (lecon.habiletes) {
    lignes.push("Habiletés et contenus attendus :")
    for (const [habilete, contenus] of Object.entries(lecon.habiletes)) {
      lignes.push(`  ${habilete} :`)
      for (const c of contenus) lignes.push(`    - ${c}`)
    }
  }

  if (lecon.savoirs?.length) {
    lignes.push(`Savoirs : ${lecon.savoirs.join(" ; ")}`)
  }
  if (lecon.savoir_faire?.length) {
    lignes.push(`Savoir-faire : ${lecon.savoir_faire.join(" ; ")}`)
  }

  return lignes.join("\n")
}
