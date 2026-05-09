import type { FastifyPluginAsync } from "fastify";

export const positionsRoute: FastifyPluginAsync = async (app) => {
  app.get("/:publicKey", async (req, reply) => {
    const { publicKey } = req.params as { publicKey: string };
    // TODO(#issue-6): fetch real on-chain positions for this public key
    void publicKey;
    reply.send({ positions: [] });
  });
};
