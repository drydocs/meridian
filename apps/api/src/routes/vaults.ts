import type { FastifyPluginAsync } from "fastify";
import { selectBestVault } from "@meridian/stellar-sdk-helpers";
import { CONTRACT_ADDRESSES } from "@meridian/shared";
import { fetchAllVaults } from "../services/vaults.js";

const defindexConfigured = Boolean(
  process.env.DEFINDEX_VAULT_ID ?? CONTRACT_ADDRESSES.testnet.defindex.vault
);

export const vaultsRoute: FastifyPluginAsync = async (app) => {
  app.get("/", async (_req, reply) => {
    const vaults = await fetchAllVaults();
    const best = selectBestVault(vaults, { defindexConfigured });
    return reply.send({
      vaults,
      recommendedVaultId: best?.id ?? null,
      updatedAt: new Date().toISOString(),
      cached: false,
    });
  });

  app.get("/:vaultId", async (req, reply) => {
    const { vaultId } = req.params as { vaultId: string };
    const vaults = await fetchAllVaults();
    const vault = vaults.find((v) => v.id === vaultId);
    if (!vault) return reply.code(404).send({ error: "vault not found", vaultId });
    return reply.send(vault);
  });
};
