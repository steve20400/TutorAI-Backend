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
 * Tout ce qui parle le protocole d'OpenAI.
 *
 * C'est-à-dire OpenAI, mais aussi vLLM, Ollama, llama.cpp et LM Studio — donc
 * la machine que Steve fera tourner chez lui le jour où il en aura une. Écrire
 * cet adaptateur-là, c'est couvrir d'un coup le fournisseur payant et
 * l'auto-hébergement.
 *
 * Deux prudences que les deux autres n'exigent pas :
 *
 * — `stream_options` demande la consommation dans le dernier morceau. Les
 *   serveurs locaux l'ignorent souvent, et ne renvoient alors RIEN. On compte
 *   donc nous-mêmes en repli, et on le dit avec `approximatif`.
 * — l'adresse vient de la base. Un serveur local n'a pas de certificat, donc
 *   elle peut être en http : c'est acceptable pour une machine sur le même
 *   réseau, et inacceptable ailleurs. On refuse http hors réseau local.
 */
export const compatible: Fournisseur = {
  nom: "compatible",

  async *flux(demande: Demande, reglages: Reglages): AsyncGenerator<Morceau> {
    const base = (reglages.url ?? "").replace(/\/+$/, "")
    if (!base) {
      throw new ErreurIA("compatible", 500, "Aucune adresse de serveur n'est réglée.")
    }
    refuserHttpDistant(base)

    const reponse = await fetch(`${base}/chat/completions`, {
      method: "POST",
      signal: demande.signal,
      headers: {
        "content-type": "application/json",
        // Un serveur local n'en demande souvent pas ; l'envoyer vide ne gêne
        // pas, et l'omettre casserait OpenAI.
        authorization: `Bearer ${reglages.cle}`,
      },
      body: JSON.stringify({
        model: demande.modele,
        max_tokens: demande.maxJetons,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: demande.systeme },
          ...demande.messages.map((m) => ({
            role: m.role === "utilisateur" ? "user" : "assistant",
            content: m.contenu,
          })),
        ],
      }),
    })

    if (!reponse.ok || !reponse.body) {
      throw new ErreurIA("compatible", reponse.status, await lireErreur(reponse))
    }

    let entree = 0
    let sortie = 0
    let compte = false
    let rendu = ""

    for await (const brut of evenements(reponse.body)) {
      if (brut === "[DONE]") break

      let e: Record<string, unknown>
      try {
        e = JSON.parse(brut)
      } catch {
        continue
      }

      const choix = e.choices as
        | Array<{ delta?: { content?: string } }>
        | undefined

      const texte = choix?.[0]?.delta?.content
      if (texte) {
        rendu += texte
        yield { type: "texte", texte }
      }

      const u = e.usage as
        | { prompt_tokens?: number; completion_tokens?: number }
        | undefined

      if (u?.prompt_tokens != null || u?.completion_tokens != null) {
        entree = u.prompt_tokens ?? entree
        sortie = u.completion_tokens ?? sortie
        compte = true
      }
    }

    if (!compte) {
      // Le serveur n'a rien dit. Mieux vaut un chiffre approché qu'un zéro,
      // qui laisserait croire que la conversation n'a rien coûté.
      entree = jetonsApproximatifs(
        demande.systeme + demande.messages.map((m) => m.contenu).join(" "),
      )
      sortie = jetonsApproximatifs(rendu)
    }

    yield { type: "fin", usage: { entree, sortie, approximatif: !compte } }
  },
}

/**
 * Une clé qui part en clair sur internet est une clé perdue.
 *
 * On laisse passer http vers une machine du réseau local — c'est le cas d'un
 * modèle qui tourne dans la pièce d'à côté — et on le refuse partout ailleurs.
 */
function refuserHttpDistant(base: string): void {
  let u: URL
  try {
    u = new URL(base)
  } catch {
    throw new ErreurIA("compatible", 500, "L'adresse du serveur est illisible.")
  }

  if (u.protocol === "https:") return

  const local =
    u.hostname === "localhost" ||
    u.hostname === "127.0.0.1" ||
    u.hostname === "::1" ||
    u.hostname.endsWith(".local") ||
    /^10\./.test(u.hostname) ||
    /^192\.168\./.test(u.hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)

  if (!local) {
    throw new ErreurIA(
      "compatible",
      500,
      "Une adresse en http n'est acceptée que sur le réseau local.",
    )
  }
}

async function lireErreur(reponse: Response): Promise<string> {
  try {
    const corps = (await reponse.json()) as { error?: { message?: string } }
    return corps.error?.message ?? `HTTP ${reponse.status}`
  } catch {
    return `HTTP ${reponse.status}`
  }
}
