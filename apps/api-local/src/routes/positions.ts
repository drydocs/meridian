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
      app.log.error(result.error, "[positions] read failed");
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
    const { days } = req.query as { days?: string };

    const result = await handleGetPositionHistory(publicKey, days);
    if (result.error) {
      app.log.error(result.error, "[positions] history read failed");
    }
    reply.code(result.status).send(result.body);
  });
};
