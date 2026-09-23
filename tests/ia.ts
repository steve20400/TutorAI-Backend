/**
 * Les trois adaptateurs, sans réseau et sans clé.
 *
 * On leur sert des réponses fabriquées à la main, exactement dans la forme que
 * chaque fournisseur envoie, et on vérifie ce qui sort. C'est la seule façon
 * de contrôler le compte des jetons avant d'avoir une clé — et le compte des
 * jetons est ce sur quoi reposera la facturation.
 *
 *   npx tsx tests/ia.ts
 */
import { parler, rassembler, ErreurIA } from "../src/ia/index.js"

let echecs = 0

function verifier(quoi: string, obtenu: unknown, attendu: unknown): void {
  const a = JSON.stringify(obtenu)
  const b = JSON.stringify(attendu)
  if (a === b) {
    console.log(` OK    ${quoi}`)
  } else {
    echecs++
    console.log(` ECHEC ${quoi}\n         obtenu  ${a}\n         attendu ${b}`)
  }
}

/** Fabrique une réponse HTTP dont le corps est un flux d'événements. */
function fluxDe(lignes: string[], statut = 200): Response {
  const corps = new ReadableStream<Uint8Array>({
    start(c) {
      const encodeur = new TextEncoder()
      // Une ligne par trame, pour éprouver le tampon : un vrai flux coupe
      // n'importe où, y compris au milieu d'un mot.
      for (const l of lignes) c.enqueue(encodeur.encode(l + "\n"))
      c.close()
    },
  })
  return new Response(corps, { status: statut })
}

const demande = {
  systeme: "Tu es un tuteur.",
  messages: [{ role: "utilisateur" as const, contenu: "Bonjour" }],
  modele: "un-modele",
  maxJetons: 500,
}

async function main(): Promise<void> {
  const vraiFetch = globalThis.fetch
  let derniereRequete: { url: string; init: RequestInit } | null = null

  const servir = (lignes: string[], statut = 200) => {
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      derniereRequete = { url: String(url), init }
      return fluxDe(lignes, statut)
    }) as typeof fetch
  }

  // ── Anthropic : entrée au début, sortie à la fin ───────────────────────────
  servir([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":412}}}',
    'data: {"type":"content_block_delta","delta":{"text":"Salut "}}',
    'data: {"type":"content_block_delta","delta":{"text":"Junior."}}',
    'data: {"type":"message_delta","usage":{"output_tokens":37}}',
    'data: {"type":"message_stop"}',
  ])
  let r = await rassembler(parler(demande, { fournisseur: "anthropic", modele: "m", cle: "k" }))
  verifier("anthropic assemble le texte", r.texte, "Salut Junior.")
  verifier("anthropic compte les deux sens", r.usage, { entree: 412, sortie: 37, approximatif: false })
  verifier("anthropic annonce sa version d'API",
    (derniereRequete!.init.headers as Record<string, string>)["anthropic-version"], "2023-06-01")

  // ── Gemini : la consommation est CUMULATIVE, il ne faut pas l'additionner ──
  servir([
    'data: {"candidates":[{"content":{"parts":[{"text":"Bien"}]}}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":5}}',
    'data: {"candidates":[{"content":{"parts":[{"text":"sur."}]}}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":11}}',
  ])
  r = await rassembler(parler(demande, { fournisseur: "gemini", modele: "m", cle: "k" }))
  verifier("gemini assemble le texte", r.texte, "Biensur.")
  verifier("gemini ne cumule PAS un compte deja cumulatif",
    r.usage, { entree: 100, sortie: 11, approximatif: false })

  // ── Compatible : avec la consommation ─────────────────────────────────────
  servir([
    'data: {"choices":[{"delta":{"content":"Deux "}}]}',
    'data: {"choices":[{"delta":{"content":"plus deux."}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":88,"completion_tokens":9}}',
    "data: [DONE]",
  ])
  r = await rassembler(parler(demande, {
    fournisseur: "compatible", modele: "m", cle: "k", url: "https://api.exemple.test/v1",
  }))
  verifier("compatible assemble le texte", r.texte, "Deux plus deux.")
  verifier("compatible lit la consommation", r.usage, { entree: 88, sortie: 9, approximatif: false })

  // ── Compatible : SANS consommation, cas du serveur local ──────────────────
  servir([
    'data: {"choices":[{"delta":{"content":"Bonjour"}}]}',
    "data: [DONE]",
  ])
  r = await rassembler(parler(demande, {
    fournisseur: "compatible", modele: "m", cle: "", url: "http://localhost:8000/v1",
  }))
  verifier("un serveur muet ne fait pas croire a un cout nul", r.usage.sortie > 0, true)
  verifier("et le chiffre est annonce comme approximatif", r.usage.approximatif, true)

  // ── Les refus ─────────────────────────────────────────────────────────────
  const refuse = async (f: () => Promise<unknown>): Promise<string> => {
    try {
      await f()
      return "(aucune erreur)"
    } catch (e) {
      return e instanceof ErreurIA ? e.message : String(e)
    }
  }

  verifier("une cle absente est refusee avant tout appel",
    (await refuse(() => rassembler(parler(demande, { fournisseur: "anthropic", modele: "m", cle: "" }))))
      .includes("Aucune clé"), true)

  verifier("un fournisseur inconnu est refuse",
    (await refuse(() => rassembler(parler(demande, { fournisseur: "mistral", modele: "m", cle: "k" }))))
      .includes("inconnu"), true)

  servir([])
  verifier("http vers l'exterieur est refuse",
    (await refuse(() => rassembler(parler(demande, {
      fournisseur: "compatible", modele: "m", cle: "k", url: "http://ailleurs.example.com/v1",
    })))).includes("réseau local"), true)

  verifier("http vers le reseau local est accepte",
    (await refuse(() => rassembler(parler(demande, {
      fournisseur: "compatible", modele: "m", cle: "k", url: "http://192.168.1.40:11434/v1",
    })))), "(aucune erreur)")

  // ── Une erreur du fournisseur remonte lisible ─────────────────────────────
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: "credit epuise" } }), { status: 429 })) as typeof fetch

  verifier("l'erreur du fournisseur remonte telle quelle",
    await refuse(() => rassembler(parler(demande, { fournisseur: "anthropic", modele: "m", cle: "k" }))),
    "credit epuise")

  globalThis.fetch = vraiFetch
  console.log(`\n--- ${echecs === 0 ? "aucun echec" : echecs + " echec(s)"} ---`)
  process.exit(echecs === 0 ? 0 : 1)
}

void main()
