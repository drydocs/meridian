import type { FastifyPluginAsync } from "fastify";
import { handleGetVaultState } from "@meridian/api-core";

export const adminRoute: FastifyPluginAsync = async (app) => {
  app.get("/vault-state", async (req, reply) => {
    const caller = req.headers["x-wallet-address"];
    const result = await handleGetVaultState(
      typeof caller === "string" ? caller : undefined
    );
    if (result.error) {
      app.log.error(result.error, "[admin] failed to read vault state");
    }
    return reply.code(result.status).send(result.body);
  });
};
