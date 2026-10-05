import type { FastifyBaseLogger } from "fastify"

import { bassinDuService } from "./ia/configuration.js"

/**
 * Prévenir les adultes qu'un enfant a perdu son mot de passe.
 *
 * L'enfant n'a pas d'adresse — c'est voulu, une adresse serait un canal vers
 * lui qui ne passe pas par la plateforme. Il donne son nom de connexion, et
 * ce sont ses adultes qui reçoivent le message.
 *
 * Le courriel ne porte **aucun lien d'action**. Il annonce, il n'autorise
 * rien. Un lien qui ouvrirait directement l'écran serait un jeton de plus à
 * fabriquer, à faire expirer, à ne servir qu'une fois — et quiconque lit la
 * boîte d'un parent prendrait le compte de son enfant. L'adulte se connecte
 * comme d'habitude et traite la demande depuis la carte de son espace, qui
 * existe déjà.
 *
 * Rien ici n'interrompt jamais la réponse à l'enfant : voir `previens()`.
 */

const BREVO = "https://api.brevo.com/v3/smtp/email"

type Cle = { cle: string | null; expediteur: string | null; expediteur_nom: string }
type Destinataire = { courriel: string; prenom_enfant: string }

/**
 * Lance l'envoi sans l'attendre.
 *
 * L'attendre rendrait la réponse plus lente quand l'enfant existe et qu'il a
 * des adultes rattachés, et plus rapide sinon. Ce seul écart suffirait à
 * savoir, nom par nom, qui est inscrit — exactement ce que le silence de
 * l'écran cherche à empêcher. La route répond donc toujours à la même
 * vitesse, et le courrier part derrière.
 */
export function previens(nomEnfant: string, journal: FastifyBaseLogger): void {
  envoyer(nomEnfant, journal).catch((erreur: unknown) => {
    journal.error({ erreur }, "courriel aux adultes : echec inattendu")
  })
}

/**
 * La clé d'envoi, lue en base, partagée par tous les courriels du service.
 *
 * Bruyante quand elle manque, et c'est voulu : sans elle, la moitié d'une
 * promesse ne tient pas — un enfant qu'on dit avoir signalé à ses parents, un
 * répétiteur qu'on dit avoir prévenu de son refus — et rien à l'écran ne le
 * montrerait.
 */
async function cleDuCourrier(
  journal: FastifyBaseLogger,
  pourQuoi: string,
): Promise<Cle | null> {
  const bassin = bassinDuService()
  if (!bassin) {
    journal.warn(
      `BASE_SERVICE_IA n'est pas reglee : ${pourQuoi} ne partira pas`,
    )
    return null
  }

  const { rows } = await bassin.query<Cle>("select * from cle_du_courrier()")
  const cle = rows[0]

  if (!cle?.cle || !cle.expediteur) {
    journal.warn(
      `Clé de courrier absente : ${pourQuoi} ne partira pas. Espace d'administration → Clés.`,
    )
    return null
  }
  return cle
}

/** Un envoi, et ce qu'il faut en dire quand il échoue. */
async function poster(
  cle: Cle,
  adresse: string,
  sujetLigne: string,
  html: string,
  journal: FastifyBaseLogger,
  quoi: string,
): Promise<boolean> {
  const reponse = await fetch(BREVO, {
    method: "POST",
    headers: {
      "api-key": cle.cle as string,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sender: { name: cle.expediteur_nom, email: cle.expediteur },
      to: [{ email: adresse }],
      subject: sujetLigne,
      htmlContent: html,
    }),
  })

  if (!reponse.ok) {
    const detail = await reponse.text().catch(() => "")
    journal.error(
      { statut: reponse.status, detail: detail.slice(0, 300) },
      `${quoi} : refus du service d'envoi`,
    )
    return false
  }
  return true
}

async function envoyer(
  nomEnfant: string,
  journal: FastifyBaseLogger,
): Promise<void> {
  const bassin = bassinDuService()
  if (!bassin) return

  const cle = await cleDuCourrier(journal, "le courriel aux adultes")
  if (!cle) return

  const { rows: destinataires } = await bassin.query<Destinataire>(
    "select * from destinataires_a_prevenir($1)",
    [nomEnfant],
  )

  // Aucun destinataire est un cas normal : nom inconnu, enfant sans adulte
  // rattaché, demande déjà en cours. La base a déjà tranché, on n'insiste pas.
  if (destinataires.length === 0) return

  const prenom = destinataires[0]?.prenom_enfant ?? ""

  for (const d of destinataires) {
    const parti = await poster(
      cle,
      d.courriel,
      sujet(prenom),
      corps(prenom, process.env.SITE_URL),
      journal,
      "courriel aux adultes",
    )
    if (!parti) return
  }

  journal.info(
    { adultes: destinataires.length },
    "courriel aux adultes : parti",
  )
}

function sujet(prenom: string): string {
  const qui = prenom || "Votre enfant"
  return `${qui} a besoin de vous — ${qui} needs you`
}

const ECHAPPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

function echapper(v: string): string {
  return v.replace(/[&<>"']/g, (c) => ECHAPPE[c] ?? c)
}

/**
 * Le même habillage que les courriels de Supabase, à la main.
 *
 * Les couleurs et le logo sont ceux des modèles posés dans le tableau de bord
 * Supabase : un parent qui reçoit les deux doit voir la même maison. Le logo
 * vient de `SITE_URL` ; sans cette variable, il n'y a pas d'image, et le nom
 * écrit suffit.
 */
function corps(prenom: string, site: string | undefined): string {
  const qui = echapper(prenom || "Votre enfant")
  const quiEn = echapper(prenom || "Your child")
  const base = site?.replace(/\/+$/, "")

  const logo = base
    ? `<img src="${base}/courriel/marque-clair.png" width="34" height="34" alt="" style="vertical-align:middle; border:0;">`
    : ""

  const bouton = base
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 24px;">
         <tr><td align="center" bgcolor="#1b2a4a" style="background-color:#1b2a4a; border-radius:8px;">
           <a href="${base}" style="display:inline-block; padding:14px 30px; font-size:15px; font-weight:600; color:#f4f1ea; text-decoration:none;">Ouvrir mon espace &mdash; Open my space</a>
         </td></tr>
       </table>`
    : ""

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TUTELA</title></head>
<body style="margin:0; padding:0; background-color:#f4f1ea; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f1ea;">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px; max-width:520px; background-color:#fbf9f4; border:1px solid #dfd9cc; border-radius:12px;">
    <tr><td align="center" style="padding:30px 36px 26px;">
      ${logo}<span style="font-size:17px; font-weight:700; letter-spacing:0.11em; color:#1b2a4a; vertical-align:middle; padding-left:10px;">TUTELA</span>
    </td></tr>

    <tr><td style="padding:0 36px;">
      <p style="margin:0 0 14px; font-size:20px; font-weight:600; line-height:1.35; color:#1b2a4a;">${qui} a oublié son mot de passe</p>
      <p style="margin:0 0 24px; font-size:15px; line-height:1.65; color:#1b2a4a;">La demande vous attend dans votre espace TUTELA. Vous seul pouvez lui en choisir un nouveau, et la demande ne dure qu'un moment.</p>
    </td></tr>

    <tr><td style="padding:0 36px;">${bouton}</td></tr>

    <tr><td style="padding:0 36px 26px;">
      <p style="margin:0; font-size:13px; line-height:1.6; color:#5d6a82;">Nous ne vous demanderons jamais le mot de passe de votre enfant, et ce message ne contient aucun lien pour le changer : il faut passer par votre compte. Si vous n'attendiez pas cette demande, parlez-en à ${qui}.</p>
    </td></tr>

    <tr><td style="padding:0 36px;"><div style="border-top:1px solid #dfd9cc; font-size:0; line-height:0;">&nbsp;</div></td></tr>

    <tr><td style="padding:26px 36px 0;">
      <p style="margin:0 0 14px; font-size:20px; font-weight:600; line-height:1.35; color:#1b2a4a;">${quiEn} forgot their password</p>
      <p style="margin:0 0 24px; font-size:15px; line-height:1.65; color:#1b2a4a;">The request is waiting in your TUTELA space. Only you can set a new one, and the request does not last long.</p>
      <p style="margin:0 0 28px; font-size:13px; line-height:1.6; color:#5d6a82;">We will never ask you for your child's password, and this message carries no link to change it: it goes through your account. If you were not expecting this, talk to ${quiEn}.</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`
}

/* ===========================================================================
 * LE VERDICT D'UN DOSSIER
 *
 * Un répétiteur dépose ses pièces, puis attend. Rien ne lui disait quand
 * l'attente s'arrêtait : l'administration apposait un cachet ou refusait, et
 * il l'apprenait en revenant essayer de se connecter — ou ne l'apprenait
 * jamais. Pour un refus, c'est pire : il ne pouvait pas corriger ce qu'on ne
 * lui reprochait pas à voix haute.
 *
 * Le motif voyage jusqu'à lui, en toutes lettres. Un refus sans motif ne se
 * conteste pas et ne se corrige pas ; c'est une porte close sans indication de
 * laquelle pousser.
 * ======================================================================== */

/** Lancé sans être attendu : la décision de l'administration est déjà prise. */
export function previensDuVerdict(
  verdict: {
    adresse: string | null
    prenom: string | null
    accepte: boolean
    /** Obligatoire pour un refus, ignoré pour une acceptation. */
    motif?: string | null
  },
  journal: FastifyBaseLogger,
): void {
  envoyerLeVerdict(verdict, journal).catch((erreur: unknown) => {
    journal.error({ erreur }, "courriel de verdict : echec inattendu")
  })
}

async function envoyerLeVerdict(
  verdict: {
    adresse: string | null
    prenom: string | null
    accepte: boolean
    motif?: string | null
  },
  journal: FastifyBaseLogger,
): Promise<void> {
  // Pas d'adresse : un compte d'élève, ou une fiche sans compte. Rien à dire,
  // et rien d'anormal.
  if (!verdict.adresse) return

  const cle = await cleDuCourrier(journal, "le courriel de verdict")
  if (!cle) return

  const parti = await poster(
    cle,
    verdict.adresse,
    verdict.accepte
      ? "Votre dossier est accepté — Your file has been accepted"
      : "Votre dossier n'a pas été retenu — Your file was not accepted",
    corpsDuVerdict(verdict, process.env.SITE_URL),
    journal,
    "courriel de verdict",
  )

  if (parti) {
    journal.info({ accepte: verdict.accepte }, "courriel de verdict : parti")
  }
}

function corpsDuVerdict(
  verdict: { prenom: string | null; accepte: boolean; motif?: string | null },
  site: string | undefined,
): string {
  const base = site?.replace(/\/+$/, "")
  const bonjour = verdict.prenom ? `${echapper(verdict.prenom)}, ` : ""

  const logo = base
    ? `<img src="${base}/courriel/marque-clair.png" width="34" height="34" alt="" style="vertical-align:middle; border:0;">`
    : ""

  const bouton = base
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 24px;">
         <tr><td align="center" bgcolor="#1b2a4a" style="background-color:#1b2a4a; border-radius:8px;">
           <a href="${base}" style="display:inline-block; padding:14px 30px; font-size:15px; font-weight:600; color:#f4f1ea; text-decoration:none;">${
             verdict.accepte
               ? "Me connecter &mdash; Sign in"
               : "Reprendre mon dossier &mdash; Edit my file"
           }</a>
         </td></tr>
       </table>`
    : ""

  // Le motif tel que l'administration l'a écrit, échappé : c'est du texte
  // saisi, et il part dans une page HTML.
  const motif = verdict.motif
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
         <tr><td style="background-color:#f4ece6; border-left:3px solid #b45309; border-radius:6px; padding:14px 16px;">
           <p style="margin:0; font-size:14.5px; line-height:1.6; color:#1b2a4a;">${echapper(verdict.motif)}</p>
         </td></tr>
       </table>`
    : ""

  const titreFr = verdict.accepte
    ? "Votre dossier est accepté"
    : "Votre dossier n'a pas été retenu"
  const texteFr = verdict.accepte
    ? `${bonjour}vos pièces ont été contrôlées. Vous pouvez désormais vous connecter : votre fiche est visible des familles dans l'annuaire, et vous recevrez leurs propositions dans votre espace.`
    : `${bonjour}vos pièces ont été examinées, et le dossier n'a pas pu être retenu en l'état. Voici pourquoi :`
  const suiteFr = verdict.accepte
    ? "Une famille ne voit jamais vos documents : elle voit seulement qu'ils ont été contrôlés, et à quelle date."
    : "Vous pouvez corriger ce qui est signalé et déposer à nouveau depuis votre espace. Si quelque chose vous paraît une erreur, répondez à ce message."

  const titreEn = verdict.accepte
    ? "Your file has been accepted"
    : "Your file was not accepted"
  const texteEn = verdict.accepte
    ? "Your documents have been checked. You can now sign in: families can see your profile in the directory, and their proposals will arrive in your space."
    : "Your documents have been reviewed, and the file could not be accepted as it stands. The reason is given above, in French."
  const suiteEn = verdict.accepte
    ? "A family never sees your documents: it only sees that they were checked, and on what date."
    : "You can fix what is flagged and upload again from your space. If this looks like a mistake, reply to this message."

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TUTELA</title></head>
<body style="margin:0; padding:0; background-color:#f4f1ea; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f1ea;">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:520px; max-width:520px; background-color:#fbf9f4; border:1px solid #dfd9cc; border-radius:12px;">
    <tr><td align="center" style="padding:30px 36px 26px;">
      ${logo}<span style="font-size:17px; font-weight:700; letter-spacing:0.11em; color:#1b2a4a; vertical-align:middle; padding-left:10px;">TUTELA</span>
    </td></tr>

    <tr><td style="padding:0 36px;">
      <p style="margin:0 0 14px; font-size:20px; font-weight:600; line-height:1.35; color:#1b2a4a;">${titreFr}</p>
      <p style="margin:0 0 20px; font-size:15px; line-height:1.65; color:#1b2a4a;">${texteFr}</p>
      ${motif}
    </td></tr>

    <tr><td style="padding:0 36px;">${bouton}</td></tr>

    <tr><td style="padding:0 36px 26px;">
      <p style="margin:0; font-size:13px; line-height:1.6; color:#5d6a82;">${suiteFr}</p>
    </td></tr>

    <tr><td style="padding:0 36px;"><div style="border-top:1px solid #dfd9cc; font-size:0; line-height:0;">&nbsp;</div></td></tr>

    <tr><td style="padding:26px 36px 0;">
      <p style="margin:0 0 14px; font-size:20px; font-weight:600; line-height:1.35; color:#1b2a4a;">${titreEn}</p>
      <p style="margin:0 0 20px; font-size:15px; line-height:1.65; color:#1b2a4a;">${texteEn}</p>
      <p style="margin:0 0 28px; font-size:13px; line-height:1.6; color:#5d6a82;">${suiteEn}</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`
}
