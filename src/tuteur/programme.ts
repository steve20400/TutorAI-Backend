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

  if (mots.length === 0) return null

  let meilleure: Lecon | null = null
  let meilleurScore = 0
  let meilleurMot = ""

  for (const lecon of lecons) {
    const motsDuTitre = normaliser(lecon.titre)
      .split(" ")
      .filter((m) => m.length > 3)

    const trouves = mots.filter((m) => motsDuTitre.some((t) => memeMot(m, t)))

    if (trouves.length > meilleurScore) {
      meilleurScore = trouves.length
      meilleure = lecon
      meilleurMot = trouves.reduce((a, b) => (b.length > a.length ? b : a), "")
    }
  }

  if (!meilleure) return null

  // Deux mots communs suffisent : c'est le cas courant, « les limites et la
  // continuité ».
  if (meilleurScore >= 2) return meilleure

  // Un seul mot peut suffire, mais à deux conditions.
  //
  // « limites » ne désigne qu'une leçon et c'est tout ce que l'élève a dit :
  // exiger deux mots le renvoyait vers un tuteur sans leçon, alors qu'il
  // avait parfaitement répondu à la question posée. C'était le cas le plus
  // courant, et il échouait.
  //
  // « les équations du second degré » contient lui aussi un mot qui touche —
  // « équations » — mais deux autres qui ne touchent rien. C'est le signe que
  // l'élève parle d'autre chose : les équations différentielles ne sont pas
  // les équations du second degré. On refuse, et le tuteur demande.
  //
  // D'où la part : le mot trouvé doit représenter l'essentiel de ce que
  // l'élève a dit, pas un fragment noyé dans le reste.
  const part = meilleurScore / mots.length
  return meilleurMot.length >= 6 && part >= 0.6 ? meilleure : null
}

/**
 * Deux mots désignent-ils la même chose.
 *
 * Égaux, ou l'un commence par l'autre sur au moins cinq lettres. Sans cette
 * tolérance, « limite » ne reconnaissait pas « limites », ni « intégrale »
 * « intégral » — et un élève ne met pas ses mots au singulier pour faire
 * plaisir à une comparaison de chaînes.
 */
function memeMot(a: string, b: string): boolean {
  if (a === b) return true
  const court = Math.min(a.length, b.length)
  if (court < 5) return false
  return a.startsWith(b.slice(0, 5)) || b.startsWith(a.slice(0, 5))
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
