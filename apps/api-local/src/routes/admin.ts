import type { FastifyPluginAsync } from "fastify";
import { handleGetAdminHistory, handleGetVaultState } from "@meridian/api-core";

export const adminRoute: FastifyPluginAsync = async (app) => {
  app.get("/vault-state", async (_req, reply) => {
    const result = await handleGetVaultState();
    if (result.error) {
      app.log.error(result.error, "[admin] failed to read vault state");
    }
    return reply.code(result.status).send(result.body);
  });

  app.get("/history", async (req, reply) => {
    const { vaultId } = req.query as { vaultId?: string };
    if (!vaultId) return reply.code(400).send({ error: "vaultId is required" });

    const result = await handleGetAdminHistory(vaultId);
    if (result.error) {
      app.log.error(result.error, "[admin] failed to read admin history");
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
          .send({ error: "method not allowed" }),
    });
  }
};
