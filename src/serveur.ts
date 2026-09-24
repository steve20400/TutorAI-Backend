import { pathToFileURL } from "node:url"

import Fastify, { type FastifyError } from "fastify"
import cors from "@fastify/cors"
import sensible from "@fastify/sensible"
import swagger from "@fastify/swagger"
import swaggerUi from "@fastify/swagger-ui"

import { config } from "./config.js"
import { routesSante } from "./routes/sante.js"
import { routesMoi } from "./routes/v1/moi.js"
import { routesAdmin } from "./routes/v1/admin.js"
import { routesCompte } from "./routes/v1/compte.js"
import { routesContrats } from "./routes/v1/contrats.js"
import { routesConversation } from "./routes/v1/conversation.js"
import { routesMessage } from "./routes/v1/message.js"
import {
  routesInscription,
  routesRecuperationEnfant,
} from "./routes/v1/inscription.js"
import { routesEssai } from "./routes/v1/essai.js"
import { routesLiens } from "./routes/v1/liens.js"
import { routesEnfants } from "./routes/v1/enfants.js"
import { routesRepetiteur } from "./routes/v1/repetiteur.js"
import { routesRepetiteurs } from "./routes/v1/repetiteurs.js"
import { routesSeances } from "./routes/v1/seances.js"
import { routesSignalements } from "./routes/v1/signalements.js"
import { routesProgrammes, routesTuteurs } from "./routes/v1/tuteurs.js"
import {
  routesAvatars,
  routesContact,
  routesParametres,
  routesVilles,
  routesReferentiel,
} from "./routes/v1/villes.js"

export async function construireServeur() {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === "production" ? "info" : "debug",
      // Le jeton d'un parent ne doit jamais atterrir dans un fichier de log.
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    trustProxy: true,
  })

  await app.register(sensible)

  await app.register(cors, {
    origin: config.originesAutorisees,
    // Authentification par jeton porteur, pas par cookie : rien à partager.
    credentials: false,
  })

  await app.register(swagger, {
    openapi: {
      info: {
        title: "TUTELA — service Tuteurs",
        description:
          "API du service Tuteurs de la plateforme éducative. " +
          "L'authentification est celle de la plateforme : un jeton Supabase " +
          "obtenu à la connexion, envoyé en en-tête Authorization.",
        version: "0.1.0",
      },
      components: {
        securitySchemes: {
          porteur: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        },
      },
    },
  })

  // C'est ce document que l'application web et, plus tard, le mobile
  // consomment pour générer leur client. Le contrat est publié, pas recopié.
  await app.register(swaggerUi, { routePrefix: "/documentation" })

  await app.register(routesSante)
  await app.register(
    async (v1) => {
      await v1.register(routesMoi)
      await v1.register(routesRepetiteurs)
      await v1.register(routesEnfants)
      await v1.register(routesLiens)
      await v1.register(routesContrats)
      await v1.register(routesSeances)
      await v1.register(routesSignalements)
      await v1.register(routesInscription)
      await v1.register(routesRecuperationEnfant)
      await v1.register(routesEssai)
      await v1.register(routesVilles)
      await v1.register(routesReferentiel)
      await v1.register(routesParametres)
      await v1.register(routesContact)
      await v1.register(routesAvatars)
      await v1.register(routesProgrammes)
      await v1.register(routesTuteurs, { prefix: "/tuteurs" })
      await v1.register(routesConversation, { prefix: "/conversations" })
      await v1.register(routesMessage, { prefix: "/conversations" })
      await v1.register(routesCompte, { prefix: "/compte" })
      await v1.register(routesRepetiteur, { prefix: "/repetiteur" })
      await v1.register(routesAdmin, { prefix: "/admin" })
    },
    { prefix: "/v1" },
  )

  /**
   * Format d'erreur unique, partagé par les trois services de la plateforme :
   * un code lisible par une machine, une phrase lisible par une personne.
   * L'application globale n'a ainsi qu'une seule façon de traiter les échecs.
   */
  app.setErrorHandler((erreur: FastifyError, requete, reponse) => {
    const statut = erreur.statusCode ?? 500

    if (statut >= 500) {
      requete.log.error({ erreur }, "erreur non rattrapée")
      return reponse.code(statut).send({
        erreur: "erreur_interne",
        message: "Une erreur est survenue. Réessaie dans un instant.",
      })
    }

    return reponse.code(statut).send({
      erreur: erreur.code ?? "requete_invalide",
      message: erreur.message,
    })
  })

  app.setNotFoundHandler((_requete, reponse) =>
    reponse.code(404).send({
      erreur: "route_inconnue",
      message: "Cette adresse n'existe pas.",
    }),
  )

  return app
}

// Démarrage seulement quand ce fichier est le point d'entrée : les tests
// pourront importer `construireServeur` sans ouvrir de port.
const estPointDEntree =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (estPointDEntree) {
  const app = await construireServeur()
  try {
    // 0.0.0.0 et non localhost : dans un conteneur Render, écouter seulement
    // la boucle locale rend le service injoignable de l'extérieur.
    await app.listen({ port: config.port, host: "0.0.0.0" })
  } catch (erreur) {
    app.log.error(erreur)
    process.exit(1)
  }
}
