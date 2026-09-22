/**
 * Lecture de la configuration, une seule fois au démarrage.
 *
 * Une variable manquante fait échouer le démarrage avec un message qui dit
 * quoi faire — plutôt qu'une erreur incompréhensible à la première requête,
 * en production, un dimanche.
 */

function requise(nom: string): string {
  const valeur = process.env[nom]
  if (!valeur) {
    throw new Error(
      [
        `Variable d'environnement manquante : ${nom}`,
        "",
        "En local  : copie .env.example vers .env et remplis-la.",
        "Sur Render: Dashboard → Environment → Add Environment Variable.",
        "",
        "Les clés Supabase sont dans Project Settings → API Keys.",
      ].join("\n"),
    )
  }
  return valeur
}

export const config = {
  port: Number(process.env.PORT ?? 3001),

  /** Liste fermée : un navigateur dont l'origine n'y figure pas est refusé. */
  originesAutorisees: (process.env.ORIGINES_AUTORISEES ?? "http://localhost:3000")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),

  supabase: {
    url: requise("SUPABASE_URL"),
    /**
     * Clé publiable, jamais la secrète.
     *
     * Ce service ne détient délibérément aucun pouvoir propre sur la base :
     * il n'agit qu'avec le jeton de l'utilisateur qui l'appelle. C'est ce qui
     * garantit que les règles de protection des élèves restent écrites à un
     * seul endroit — les politiques RLS — et non recopiées ici.
     */
    clePubliable: requise("SUPABASE_CLE_PUBLIABLE"),
  },
} as const
