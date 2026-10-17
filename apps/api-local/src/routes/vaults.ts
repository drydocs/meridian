import type { FastifyPluginAsync } from "fastify";
import { handleGetVaults, handleGetVaultById } from "@meridian/api-core";
import { KNOWN_VAULT_IDS } from "../lib/known-vault-ids";

export const vaultsRoute: FastifyPluginAsync = async (app) => {
  app.get("/", async (_req, reply) => {
    const result = await handleGetVaults();
    if (result.error) {
      app.log.error(result.error, "[vaults] failed to fetch vaults");
    }
    return reply.code(result.status).send(result.body);
  });

  app.get("/:vaultId", async (req, reply) => {
    const { vaultId } = req.params as { vaultId: string };
    if (!KNOWN_VAULT_IDS.has(vaultId))
      return reply.code(404).send({ error: "vault not found", vaultId });
    const result = await handleGetVaultById(vaultId);
    if (result.error) {
      app.log.error(result.error, "[vaults] failed to fetch vault by id");
    }
    return reply.code(result.status).send(result.body);
  });
};
