import type { FastifyInstance } from "fastify"

/**
 * Sonde de vie. Render l'interroge pour savoir si le service répond, et c'est
 * la première adresse à essayer quand quelque chose ne va pas.
 *
 * Elle ne touche pas la base : on veut pouvoir distinguer « le service est
 * tombé » de « la base est tombée ».
 */
export async function routesSante(app: FastifyInstance): Promise<void> {
  app.get(
    "/sante",
    {
      schema: {
        tags: ["service"],
        summary: "Le service répond-il ?",
        response: {
          200: {
            type: "object",
            properties: {
              service: { type: "string" },
              version: { type: "string" },
              horodatage: { type: "string" },
            },
          },
        },
      },
    },
    async () => ({
      service: "tutela-backend",
      version: "0.1.0",
      horodatage: new Date().toISOString(),
    }),
  )
}
