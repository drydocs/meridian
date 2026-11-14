import type { FastifyPluginAsync } from "fastify";
import { KNOWN_POOLS } from "@meridian/stellar-sdk-helpers";
import { handleGetVaults, handleGetVaultById } from "@meridian/api-core";

const KNOWN_VAULT_IDS = new Set(
  [
    ...Object.values(KNOWN_POOLS.mainnet),
    ...Object.values(KNOWN_POOLS.testnet),
  ].map((pool) => pool.id)
);

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

  app.route({
    method: ["POST", "PUT", "PATCH", "DELETE"],
    url: "/",
    handler: async (_req, reply) =>
      reply
        .code(405)
        .header("Allow", "GET")
        .send({ error: "method not allowed" }),
  });

  app.route({
    method: ["POST", "PUT", "PATCH", "DELETE"],
    url: "/:vaultId",
    handler: async (_req, reply) =>
      reply
        .code(405)
        .header("Allow", "GET")
        .send({ error: "method not allowed" }),
  });
};
