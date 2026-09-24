import type { FastifyInstance } from "fastify"

import {
  configurationDuTuteur,
  ErreurConfiguration,
  inscrireConsommation,
} from "../../ia/configuration.js"
import { ErreurIA, parler } from "../../ia/index.js"
import { demandePourLeTuteur, type ContexteSeance } from "../../tuteur/contexte.js"
import { exigerSession, supabasePour, utilisateurDe } from "../../supabase.js"

/**
 * L'élève écrit au tuteur, le tuteur répond.
 *
 * Cette route vivait dans le site, sur Vercel, avec la clé d'Anthropic dans
 * son environnement et un appel direct à la base — ce que Steve avait demandé
 * qu'on arrête : « le front-end ne va pas normalement communiquer avec la base
 * de données ». Elle est ici maintenant, derrière les adaptateurs, et la clé
 * vient de l'espace d'administration.
 *
 * La réponse part en flux. Un tuteur qui écrit progressivement paraît vivant ;
 * un tuteur qui fait attendre huit secondes paraît cassé, et sur une connexion
 * d'ici huit secondes est optimiste. Celui qui appelle peut rassembler le flux
 * sans rien changer côté écran — c'est ce que fait le site aujourd'hui — mais
 * le protocole, lui, est déjà le bon.
 */

/** Garde-fous de coût. Chaque message se paie. */
const MESSAGES_PAR_HEURE = 30
const LONGUEUR_MAX = 4000
const JETONS_PAR_REPONSE = 8000

export async function routesMessage(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", exigerSession)

  app.post(
    "/:id/message",
    {
      schema: {
        tags: ["tuteur"],
        summary: "Écrire au tuteur, et recevoir sa réponse en flux",
        description:
          "Répond en « server-sent events » : des morceaux `{type:\"texte\"}` " +
          "puis un `{type:\"fin\"}` portant la consommation en jetons.",
        security: [{ porteur: [] as string[] }],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } },
        },
        body: {
          type: "object",
          required: ["contenu"],
          properties: {
            contenu: { type: "string", minLength: 1, maxLength: LONGUEUR_MAX },
            /** Texte extrait d'une photo du manuel. Jamais écrit en base. */
            pageDuJour: { type: "string", maxLength: 8000 },
          },
        },
      },
    },
    async (requete, reponse) => {
      const { id } = requete.params as { id: string }
      const { contenu, pageDuJour } = requete.body as {
        contenu: string
        pageDuJour?: string
      }
      const moi = utilisateurDe(requete)
      const supabase = supabasePour(requete)

      // ── Le module ───────────────────────────────────────────────────────
      // Masquer un écran n'empêche personne d'appeler la route qui se trouve
      // derrière : sans cette garde, n'importe quel compte connecté ferait
      // dépenser la plateforme alors que le module est éteint.
      const { data: reglage } = await supabase
        .from("parametres")
        .select("valeur")
        .eq("cle", "ia_active")
        .maybeSingle()

      if (reglage?.valeur !== true) {
        return reponse.code(403).send({
          erreur: "module_desactive",
          message: "Le tuteur n'est pas disponible en ce moment.",
        })
      }

      // ── Le rythme ───────────────────────────────────────────────────────
      // Compté sur `messages`, que la RLS restreint déjà aux séances de cet
      // élève : pas de service en plus, pas de compteur en mémoire — un
      // compteur en mémoire ne survivrait pas aux réveils de Render.
      const ilYaUneHeure = new Date(Date.now() - 3_600_000).toISOString()
      const { count } = await supabase
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("auteur", "eleve")
        .gte("cree_le", ilYaUneHeure)

      if ((count ?? 0) >= MESSAGES_PAR_HEURE) {
        return reponse.code(429).send({
          erreur: "trop_de_messages",
          message:
            "Tu as beaucoup travaillé cette heure-ci. Fais une pause et reviens dans un moment.",
        })
      }

      // ── La séance ───────────────────────────────────────────────────────
      // La RLS filtre : une séance qui n'est pas la sienne ne remonte pas.
      //
      // `programmes` sans `!inner`, contrairement à `tuteurs_ia` : un tuteur
      // dont l'élève a nommé la matière lui-même n'a pas de programme, et une
      // jointure obligatoire l'aurait fait disparaître — la séance aurait
      // répondu « introuvable » sans que personne comprenne pourquoi.
      const { data: seance } = await supabase
        .from("seances")
        .select(
          `id, statut, mode, lecon_titre,
           tuteur:tuteurs_ia!inner (
             id, matiere, niveau,
             programme:programmes ( contenu ),
             memoire:memoire_eleve ( notions_acquises, notions_fragiles, erreurs_recurrentes )
           )`,
        )
        .eq("id", id)
        .maybeSingle()

      if (!seance) {
        return reponse.code(404).send({
          erreur: "seance_introuvable",
          message: "Cette séance n'existe pas.",
        })
      }

      if (seance.statut !== "en_cours") {
        return reponse.code(409).send({
          erreur: "seance_terminee",
          message: "Cette séance est terminée.",
        })
      }

      // ── La configuration ────────────────────────────────────────────────
      let config
      try {
        config = await configurationDuTuteur(Date.now())
      } catch (e) {
        requete.log.error({ e }, "configuration du tuteur illisible")
        return reponse.code(503).send({
          erreur: "tuteur_non_configure",
          message: "Le tuteur n'est pas configuré. Prévenez l'administration.",
        })
      }

      if (!config.cle && config.fournisseur !== "compatible") {
        return reponse.code(503).send({
          erreur: "cle_absente",
          message:
            "Aucune clé n'est enregistrée pour le tuteur. Posez-la dans « Clés ».",
        })
      }

      // ── Le contexte ─────────────────────────────────────────────────────
      const [{ data: profil }, { data: historique }] = await Promise.all([
        supabase.from("profils").select("prenom, pays").eq("id", moi).maybeSingle(),
        supabase
          .from("messages")
          .select("auteur, contenu")
          .eq("seance_id", id)
          .order("id", { ascending: true }),
      ])

      const t = premier(seance.tuteur)
      const programme = t.programme ? premier(t.programme) : null
      const memoire = premier(t.memoire)

      const contexte: ContexteSeance = {
        prenomEleve: profil?.prenom ?? "l'élève",
        niveau: t.niveau,
        pays: profil?.pays ?? "CM",
        matiere: t.matiere,
        mode: seance.mode,
        programme: programme?.contenu ?? null,
        memoire: memoire ?? null,
        leconTitre: seance.lecon_titre,
        historique: [...(historique ?? []), { auteur: "eleve", contenu }],
        pageDuJour,
      }

      // ── On écrit le message de l'élève AVANT d'appeler le modèle ────────
      // Si l'appel échoue, son message reste : il n'aura pas à le retaper.
      const { error: erreurEcriture } = await supabase
        .from("messages")
        .insert({ seance_id: id, auteur: "eleve", contenu })

      if (erreurEcriture) {
        return reponse.code(500).send({
          erreur: "ecriture_impossible",
          message: "Ton message n'a pas pu être enregistré.",
        })
      }

      // ── Le flux ─────────────────────────────────────────────────────────
      reponse.hijack()
      reponse.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Render et les intermédiaires tamponnent par défaut : sans cet
        // en-tête, le flux arrive d'un bloc à la fin, ce qui revient à ne pas
        // en avoir.
        "x-accel-buffering": "no",
      })

      const envoyer = (o: unknown): void => {
        reponse.raw.write(`data: ${JSON.stringify(o)}\n\n`)
      }

      let rendu = ""
      let usage: { entree: number; sortie: number; approximatif: boolean } | null =
        null

      try {
        const flux = parler(
          demandePourLeTuteur(contexte, config.modeleCompte, JETONS_PAR_REPONSE),
          config,
        )

        for await (const m of flux) {
          if (m.type === "texte") {
            rendu += m.texte
            envoyer(m)
          } else {
            usage = m.usage
            envoyer(m)
          }
        }
      } catch (e) {
        // Le message du fournisseur part au journal, pas à l'écran : il est
        // en anglais et technique — « This model is currently experiencing
        // high demand ». Un enfant de cinquième ne doit jamais lire ça.
        // L'écran reçoit un code, et choisit sa phrase dans la langue de
        // l'élève.
        const code = e instanceof ErreurIA ? e.code : "autre"
        const message =
          e instanceof ErreurIA || e instanceof ErreurConfiguration
            ? e.message
            : String(e)

        requete.log.error({ e, code }, "appel du tuteur echoue")
        envoyer({ type: "erreur", code, message })
      }

      // ── On garde la réponse ─────────────────────────────────────────────
      //
      // Rien à garder quand le modèle n'a rien dit. Écrire `REFUS` dans ce
      // cas — ce que faisait ce code — inscrivait « je préfère ne pas
      // répondre à ça » dans le fil de l'enfant alors que la panne était
      // technique. Il croyait que son tuteur l'avait rembarré, et la phrase
      // restait dans son historique pour toujours.
      //
      // Une panne se dit comme une panne. Le refus est une décision
      // pédagogique, et le modèle est seul à pouvoir la prendre.
      const texte = rendu.trim()
      if (texte) {
        await supabase
          .from("messages")
          .insert({ seance_id: id, auteur: "tuteur", contenu: texte })
      }

      // Ce que cette réponse a coûté. Une ligne par appel, jamais agrégée :
      // on peut toujours additionner des lignes, on ne peut jamais retrouver
      // le détail d'une somme.
      if (usage) {
        try {
          await inscrireConsommation({
            compteId: moi,
            seanceId: id,
            fournisseur: config.fournisseur,
            modele: config.modeleCompte,
            entree: usage.entree,
            sortie: usage.sortie,
            approximatif: usage.approximatif,
          })
        } catch (e) {
          // Une ligne de comptabilité perdue vaut mieux qu'une réponse perdue.
          requete.log.error({ e }, "consommation non inscrite")
        }
      }

      reponse.raw.end()
    },
  )
}

/** Supabase rend parfois un objet, parfois un tableau d'un seul élément. */
function premier<T>(v: T | T[]): T {
  return Array.isArray(v) ? (v[0] as T) : v
}
