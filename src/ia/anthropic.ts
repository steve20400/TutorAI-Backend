import {
  ErreurIA,
  evenements,
  jetonsApproximatifs,
  type Demande,
  type Fournisseur,
  type Morceau,
  type Reglages,
} from "./types.js"

/**
 * Anthropic.
 *
 * La consommation arrive en deux temps : les jetons d'entrée dans
 * `message_start`, ceux de sortie dans `message_delta` à la fin. On garde les
 * premiers de côté jusqu'à ce que les seconds arrivent, sinon on annonce un
 * coût dont il manque la moitié.
 */
export const anthropic: Fournisseur = {
  nom: "anthropic",

  async *flux(demande: Demande, reglages: Reglages): AsyncGenerator<Morceau> {
    const reponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: demande.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": reglages.cle,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: demande.modele,
        max_tokens: demande.maxJetons,
        system: demande.systeme,
        stream: true,
        messages: demande.messages.map((m) => ({
          role: m.role === "utilisateur" ? "user" : "assistant",
          content: m.contenu,
        })),
      }),
    })

    if (!reponse.ok || !reponse.body) {
      // Le corps de l'erreur peut contenir l'adresse de la clé, jamais la clé
      // elle-même ; on le remonte tel quel, il est utile au diagnostic.
      throw new ErreurIA("anthropic", reponse.status, await lireErreur(reponse))
    }

    let entree = 0
    let sortie = 0
    let sorti = false

    for await (const brut of evenements(reponse.body)) {
      if (brut === "[DONE]") break

      let e: Record<string, unknown>
      try {
        e = JSON.parse(brut)
      } catch {
        continue
      }

      const type = e.type as string

      if (type === "message_start") {
        const u = (e.message as { usage?: { input_tokens?: number } })?.usage
        entree = u?.input_tokens ?? 0
      } else if (type === "content_block_delta") {
        const texte = (e.delta as { text?: string })?.text
        if (texte) yield { type: "texte", texte }
      } else if (type === "message_delta") {
        const u = e.usage as { output_tokens?: number } | undefined
        if (u?.output_tokens != null) {
          sortie = u.output_tokens
          sorti = true
        }
      } else if (type === "error") {
        const m = (e.error as { message?: string })?.message
        throw new ErreurIA("anthropic", 502, m ?? "flux interrompu")
      }
    }

    yield {
      type: "fin",
      usage: { entree, sortie, approximatif: !sorti },
    }
  },
}

/** Le message d'erreur du fournisseur, ou son code si le corps est illisible. */
async function lireErreur(reponse: Response): Promise<string> {
  try {
    const corps = (await reponse.json()) as {
      error?: { message?: string }
    }
    return corps.error?.message ?? `HTTP ${reponse.status}`
  } catch {
    return `HTTP ${reponse.status}`
  }
}

export { jetonsApproximatifs }
