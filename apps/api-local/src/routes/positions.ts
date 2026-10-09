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
