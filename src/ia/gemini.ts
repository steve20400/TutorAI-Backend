import {
  ErreurIA,
  evenements,
  type Demande,
  type Fournisseur,
  type Morceau,
  type Reglages,
} from "./types.js"

const BASE = "https://generativelanguage.googleapis.com/v1beta"

/**
 * Gemini.
 *
 * Deux différences avec les autres, qui piègent à chaque fois :
 *
 * — le rôle de la machine s'appelle « model », pas « assistant » ;
 * — la consommation est renvoyée à CHAQUE morceau, cumulée depuis le début.
 *   On garde donc le dernier reçu, sans additionner — additionner donnerait
 *   dix fois le coût réel.
 *
 * La clé voyage dans l'adresse. C'est ce que demande l'API, et c'est une
 * raison de plus pour que l'appel ne parte jamais du navigateur : une clé dans
 * une URL se retrouve dans les journaux de tous les intermédiaires.
 */
export const gemini: Fournisseur = {
  nom: "gemini",

  async *flux(demande: Demande, reglages: Reglages): AsyncGenerator<Morceau> {
    const adresse =
      `${BASE}/models/${encodeURIComponent(demande.modele)}` +
      `:streamGenerateContent?alt=sse&key=${encodeURIComponent(reglages.cle)}`

    const reponse = await fetch(adresse, {
      method: "POST",
      signal: demande.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: demande.systeme }] },
        contents: demande.messages.map((m) => ({
          role: m.role === "utilisateur" ? "user" : "model",
          parts: [{ text: m.contenu }],
        })),
        generationConfig: { maxOutputTokens: demande.maxJetons },
      }),
    })

    if (!reponse.ok || !reponse.body) {
      throw new ErreurIA("gemini", reponse.status, await lireErreur(reponse))
    }

    let entree = 0
    let sortie = 0
    let compte = false

    for await (const brut of evenements(reponse.body)) {
      if (brut === "[DONE]") break

      let e: Record<string, unknown>
      try {
        e = JSON.parse(brut)
      } catch {
        continue
      }

      const candidats = e.candidates as
        | Array<{ content?: { parts?: Array<{ text?: string }> } }>
        | undefined

      for (const part of candidats?.[0]?.content?.parts ?? []) {
        if (part.text) yield { type: "texte", texte: part.text }
      }

      const u = e.usageMetadata as
        | { promptTokenCount?: number; candidatesTokenCount?: number }
        | undefined

      if (u) {
        // Remplacé, jamais additionné : le compte est déjà cumulatif.
        entree = u.promptTokenCount ?? entree
        sortie = u.candidatesTokenCount ?? sortie
        compte = true
      }
    }

    yield { type: "fin", usage: { entree, sortie, approximatif: !compte } }
  },
}

async function lireErreur(reponse: Response): Promise<string> {
  try {
    const corps = (await reponse.json()) as { error?: { message?: string } }
    return corps.error?.message ?? `HTTP ${reponse.status}`
  } catch {
    return `HTTP ${reponse.status}`
  }
}
