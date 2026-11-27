import type { FastifyPluginAsync } from "fastify";
import {
  handleGetPositionHistory,
  handleGetPositions,
  matchesPositionEtag,
} from "@meridian/api-core";

export const positionsRoute: FastifyPluginAsync = async (app) => {
  app.get("/:publicKey", async (req, reply) => {
    const { publicKey } = req.params as { publicKey: string };

    const { refresh } = req.query as { refresh?: string };
    const result = await handleGetPositions(publicKey, {
      refresh: refresh === "true" || refresh === "1",
    });
    if (result.error) {
      req.log.error(result.error, "[positions] read failed");
    }
    if (result.etag) reply.header("ETag", result.etag);
    reply.header("Cache-Control", "no-store");
    if (matchesPositionEtag(req.headers["if-none-match"], result.etag)) {
      return reply.code(304).send();
    }
    reply.code(result.status).send(result.body);
  });

  app.get("/:publicKey/history", async (req, reply) => {
    const { publicKey } = req.params as { publicKey: string };
    const { days, resolution, limit, cursor } = req.query as {
      days?: string;
      resolution?: string;
      limit?: string;
      cursor?: string;
    };

    const result = await handleGetPositionHistory(
      publicKey,
      days,
      resolution,
      limit,
      cursor
    );
    if (result.error) {
      req.log.error(result.error, "[positions] history read failed");
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
