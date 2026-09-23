/**
 * Ce que le reste de l'application sait d'une IA.
 *
 * Rien d'autre. Le porte-monnaie de jetons, la salle de cours et le tuteur des
 * élèves parlent à cette forme-là — jamais à Anthropic, jamais à Gemini. C'est
 * ce qui permettra de passer à un modèle tournant sur la machine de Steve sans
 * toucher une ligne ailleurs.
 */

/** Les rôles sont nommés dans la langue du projet, pas dans celle d'un vendeur. */
export type Message = {
  role: "utilisateur" | "tuteur"
  contenu: string
}

/**
 * Ce qu'a coûté un échange.
 *
 * `approximatif` n'est pas un détail : un modèle qu'on héberge soi-même peut
 * ne rien renvoyer du tout. Compter à sa place vaut mieux que de ne pas
 * compter, mais il faut le dire — sinon on facture un jour sur une estimation
 * en croyant facturer sur une mesure.
 */
export type Usage = {
  entree: number
  sortie: number
  approximatif: boolean
}

export type Morceau =
  | { type: "texte"; texte: string }
  | { type: "fin"; usage: Usage }

/**
 * Le contexte, en trois couches, de la plus stable à la plus changeante.
 *
 * Cette séparation n'est pas de l'esthétique : c'est elle qui décide de la
 * facture. Le tuteur renvoie le programme officiel entier à CHAQUE message.
 * Anthropic sait ne le facturer qu'une fois si on lui dit où s'arrête la
 * partie stable — environ 90 % d'économie sur le préfixe. Sans ce repère, on
 * paie le programme complet à chaque réplique.
 *
 * Chaque fournisseur le traduit dans son propre dialecte, ou l'ignore s'il
 * n'en a pas. C'est le travail de l'adaptateur, pas celui de l'appelant.
 */
export type Demande = {
  /** Qui est le tuteur, ce qu'il n'a pas le droit de faire. Ne change jamais. */
  systeme: string
  /** Le programme officiel. Change à chaque matière, pas à chaque message. */
  stable?: string
  /** La leçon du jour, la mémoire de l'élève. Change à chaque séance. */
  volatil?: string
  messages: Message[]
  modele: string
  /** Plafond de sortie. Une réponse qui ne s'arrête jamais coûte sans fin. */
  maxJetons: number
  signal?: AbortSignal
}

export type Reglages = {
  cle: string
  /** Seulement pour le fournisseur « compatible » : l'adresse du serveur. */
  url?: string
}

export type Fournisseur = {
  nom: string
  flux(demande: Demande, reglages: Reglages): AsyncGenerator<Morceau>
}

/** Erreur du fournisseur, avec de quoi la montrer sans trahir la clé. */
export class ErreurIA extends Error {
  constructor(
    readonly fournisseur: string,
    readonly statut: number,
    message: string,
  ) {
    super(message)
    this.name = "ErreurIA"
  }
}

/**
 * Environ quatre caractères par jeton en français.
 *
 * Ne sert QUE de repli quand le fournisseur ne compte pas. L'écart avec la
 * vérité peut atteindre vingt pour cent sur un texte plein d'accents et de
 * formules — d'où le drapeau qui accompagne le chiffre.
 */
export function jetonsApproximatifs(texte: string): number {
  return Math.ceil(texte.length / 4)
}

/**
 * Découpe un flux « server-sent events » en objets.
 *
 * Les trois fournisseurs parlent ce dialecte. Un événement se termine par une
 * ligne vide, et une trame TCP peut couper n'importe où : d'où le tampon.
 */
export async function* evenements(
  corps: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const lecteur = corps.getReader()
  const decodeur = new TextDecoder()
  let tampon = ""

  try {
    for (;;) {
      const { done, value } = await lecteur.read()
      if (done) break
      tampon += decodeur.decode(value, { stream: true })

      let coupe: number
      while ((coupe = tampon.indexOf("\n")) >= 0) {
        const ligne = tampon.slice(0, coupe).trim()
        tampon = tampon.slice(coupe + 1)
        if (ligne.startsWith("data:")) yield ligne.slice(5).trim()
      }
    }
  } finally {
    lecteur.releaseLock()
  }
}

/** Rassemble un flux en une réponse entière, pour qui n'a pas besoin du direct. */
export async function rassembler(
  flux: AsyncGenerator<Morceau>,
): Promise<{ texte: string; usage: Usage }> {
  let texte = ""
  let usage: Usage = { entree: 0, sortie: 0, approximatif: true }

  for await (const m of flux) {
    if (m.type === "texte") texte += m.texte
    else usage = m.usage
  }
  return { texte, usage }
}
