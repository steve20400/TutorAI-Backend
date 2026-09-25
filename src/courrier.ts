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

async function envoyer(
  nomEnfant: string,
  journal: FastifyBaseLogger,
): Promise<void> {
  const bassin = bassinDuService()
  if (!bassin) {
    journal.warn(
      "BASE_SERVICE_IA n'est pas reglee : aucun adulte ne sera prevenu par courriel",
    )
    return
  }

  const { rows: cles } = await bassin.query<Cle>("select * from cle_du_courrier()")
  const cle = cles[0]

  if (!cle?.cle || !cle.expediteur) {
    // Bruyant, et c'est voulu. Sans clé, la moitié de la promesse faite à
    // l'enfant ne tient pas, et rien à l'écran ne le montrerait.
    journal.warn(
      "Clé de courrier absente : la demande est visible dans l'espace de l'adulte, mais aucun courriel ne partira. Espace d'administration → Clés.",
    )
    return
  }

  const { rows: destinataires } = await bassin.query<Destinataire>(
    "select * from destinataires_a_prevenir($1)",
    [nomEnfant],
  )

  // Aucun destinataire est un cas normal : nom inconnu, enfant sans adulte
  // rattaché, demande déjà en cours. La base a déjà tranché, on n'insiste pas.
  if (destinataires.length === 0) return

  const prenom = destinataires[0]?.prenom_enfant ?? ""

  for (const d of destinataires) {
    const reponse = await fetch(BREVO, {
      method: "POST",
      headers: {
        "api-key": cle.cle,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: { name: cle.expediteur_nom, email: cle.expediteur },
        to: [{ email: d.courriel }],
        subject: sujet(prenom),
        htmlContent: corps(prenom, process.env.SITE_URL),
      }),
    })

    if (!reponse.ok) {
      const detail = await reponse.text().catch(() => "")
      journal.error(
        { statut: reponse.status, detail: detail.slice(0, 300) },
        "courriel aux adultes : refus du service d'envoi",
      )
      return
    }
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
