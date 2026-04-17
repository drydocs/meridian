import type { FastifyPluginAsync } from "fastify";

export const vaultsRoute: FastifyPluginAsync = async (app) => {
  app.get("/", async (_req, reply) => {
    // TODO(#issue-6): fetch and aggregate live APY from Blend + DeFindex
    reply.send({
      vaults: [],
      updatedAt: new Date().toISOString(),
    });
  });

  app.get("/:vaultId", async (req, reply) => {
    const { vaultId } = req.params as { vaultId: string };
    // TODO(#issue-6): return single vault detail
    reply.code(404).send({ error: "vault not found", vaultId });
  });
};
