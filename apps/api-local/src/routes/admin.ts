import type { FastifyPluginAsync } from "fastify";
import {
  handleGetAdminHistory,
  handleGetVaultState,
  HISTORY_CACHE_CONTROL,
} from "@meridian/api-core";

export const adminRoute: FastifyPluginAsync = async (app) => {
  app.get("/vault-state", async (req, reply) => {
    const result = await handleGetVaultState();
    if (result.error) {
      req.log.error(result.error, "[admin] failed to read vault state");
    }
    reply.header("Cache-Control", "no-store");
    return reply.code(result.status).send(result.body);
  });

  app.get("/history", async (req, reply) => {
    const { vaultId } = req.query as { vaultId?: string };
    if (!vaultId) return reply.code(400).send({ error: "vaultId is required" });

    const result = await handleGetAdminHistory(vaultId);
    if (result.error) {
      req.log.error(result.error, "[admin] failed to read admin history");
    }
    if (result.status === 200) {
      reply.header("Cache-Control", HISTORY_CACHE_CONTROL);
    }
    return reply.code(result.status).send(result.body);
  });

  for (const url of ["/vault-state", "/history"]) {
    app.route({
      method: ["POST", "PUT", "PATCH", "DELETE"],
      url,
      handler: async (_req, reply) =>
        reply
          .code(405)
          .header("Allow", "GET")
          .send({ error: "Method not allowed" }),
    });
  }
};
