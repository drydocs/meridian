import type { FastifyPluginAsync } from "fastify";
import { fetchAllVaults } from "../services/vaults.js";

export const vaultsRoute: FastifyPluginAsync = async (app) => {
  app.get("/", async (_req, reply) => {
    const vaults = await fetchAllVaults();
    return reply.send({ vaults, updatedAt: new Date().toISOString(), cached: false });
  });

  app.get("/:vaultId", async (req, reply) => {
    const { vaultId } = req.params as { vaultId: string };
    const vaults = await fetchAllVaults();
    const vault = vaults.find((v) => v.id === vaultId);
    if (!vault) return reply.code(404).send({ error: "vault not found", vaultId });
    return reply.send(vault);
  });
};
