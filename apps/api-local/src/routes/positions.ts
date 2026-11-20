import type { FastifyPluginAsync } from "fastify";
import {
  handleGetPositionHistory,
  handleGetPositions,
} from "@meridian/api-core";

export const positionsRoute: FastifyPluginAsync = async (app) => {
  app.get("/:publicKey", async (req, reply) => {
    const { publicKey } = req.params as { publicKey: string };

    const result = await handleGetPositions(publicKey);
    if (result.error) {
      app.log.error(result.error, "[positions] read failed");
    }
    reply.header("Cache-Control", "no-store");
    reply.code(result.status).send(result.body);
  });

  app.get("/:publicKey/history", async (req, reply) => {
    const { publicKey } = req.params as { publicKey: string };
    const { days } = req.query as { days?: string };

    const result = await handleGetPositionHistory(publicKey, days);
    if (result.error) {
      app.log.error(result.error, "[positions] history read failed");
    }
    reply.header("Cache-Control", "no-store");
    reply.code(result.status).send(result.body);
  });

  app.route({
    method: ["POST", "PUT", "PATCH", "DELETE"],
    url: "/:publicKey",
    handler: async (_req, reply) =>
      reply
        .code(405)
        .header("Allow", "GET")
        .send({ error: "Method not allowed" }),
  });

  app.route({
    method: ["POST", "PUT", "PATCH", "DELETE"],
    url: "/:publicKey/history",
    handler: async (_req, reply) =>
      reply
        .code(405)
        .header("Allow", "GET")
        .send({ error: "Method not allowed" }),
  });
};
