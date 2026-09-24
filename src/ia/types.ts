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

/**
 * Ce qui a échoué, en quatre familles.
 *
 * Le message du fournisseur est en anglais et technique — « This model is
 * currently experiencing high demand ». Un enfant de cinquième ne doit jamais
 * lire ça. Le code voyage jusqu'à l'écran, qui choisit une phrase dans la
 * langue de l'élève ; le message, lui, va au journal.
 */
export type CodeErreurIA =
  /** Le fournisseur est débordé ou nous freine. Réessayer a du sens. */
  | "surcharge"
  /** Clé absente, invalide ou sans crédit. L'administration doit agir. */
  | "cle"
  /** Le modèle nommé n'existe pas ou plus. L'administration doit agir. */
  | "modele"
  /** Tout le reste. */
  | "autre"

/** Erreur du fournisseur, avec de quoi la montrer sans trahir la clé. */
export class ErreurIA extends Error {
  readonly code: CodeErreurIA

  constructor(
    readonly fournisseur: string,
    readonly statut: number,
    message: string,
    code?: CodeErreurIA,
  ) {
    super(message)
    this.name = "ErreurIA"
    this.code = code ?? deviner(statut, message)
  }

  /** Vrai quand réessayer dans un instant a des chances d'aboutir. */
  get passagere(): boolean {
    return this.code === "surcharge"
  }
}

/**
 * Chaque fournisseur nomme ses pannes à sa façon.
 *
 * On lit d'abord le code HTTP, qui est la partie fiable, puis le texte pour
 * les cas que le code ne distingue pas — un 400 peut aussi bien dire « ce
 * modèle n'existe pas » que « votre requête est malformée ».
 */
function deviner(statut: number, message: string): CodeErreurIA {
  if (statut === 429 || statut === 503 || statut === 529) return "surcharge"
  if (statut === 401 || statut === 403) return "cle"

  const m = message.toLowerCase()
  if (m.includes("overload") || m.includes("high demand") || m.includes("rate limit")) {
    return "surcharge"
  }
  if (m.includes("api key") || m.includes("api_key") || m.includes("quota")) return "cle"
  if (m.includes("model") && (m.includes("not found") || m.includes("no longer") || m.includes("unknown"))) {
    return "modele"
  }
  return "autre"
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
