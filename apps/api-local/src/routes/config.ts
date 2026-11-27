import type { FastifyPluginAsync } from "fastify";
import { CONFIG_CACHE_CONTROL, handleGetConfig } from "@meridian/api-core";

export const configRoute: FastifyPluginAsync = async (app) => {
  app.get("/", async (_req, reply) => {
    const result = await handleGetConfig();
    if (result.error) {
      app.log.warn(result.error, "[config] active adapter lookup failed");
    }
    return reply
      .header(
        "Cache-Control",
        result.error !== undefined ? "no-store" : CONFIG_CACHE_CONTROL
      )
      .code(result.status)
      .send(result.body);
  });

  app.route({
    method: ["POST", "PUT", "PATCH", "DELETE"],
    url: "/",
    handler: async (_req, reply) =>
      reply
        .code(405)
        .header("Allow", "GET")
        .send({ error: "method not allowed" }),
  });
};
