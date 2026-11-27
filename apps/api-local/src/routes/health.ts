import type { FastifyPluginAsync } from "fastify";
import { handleGetLiveness, handleGetReadiness } from "@meridian/api-core";

export const healthRoute: FastifyPluginAsync = async (app) => {
  app.get("/live", async (_req, reply) => {
    const result = handleGetLiveness();
    return reply
      .header("Cache-Control", "no-store")
      .code(result.status)
      .send(result.body);
  });

  app.get("/ready", async (_req, reply) => {
    const result = await handleGetReadiness();
    return reply
      .header("Cache-Control", "no-store")
      .code(result.status)
      .send(result.body);
  });

  for (const url of ["/live", "/ready"]) {
    app.route({
      method: ["POST", "PUT", "PATCH", "DELETE"],
      url,
      handler: async (_req, reply) =>
        reply
          .code(405)
          .header("Allow", "GET")
          .send({ error: "Method not allowed" }),
    });
  }
};
