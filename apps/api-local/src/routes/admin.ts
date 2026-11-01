import type { FastifyPluginAsync } from "fastify";
import {
  createAdminChallenge,
  handleGetAdminHistory,
  handleGetVaultState,
  verifyAdminChallenge,
} from "@meridian/api-core";

export const adminRoute: FastifyPluginAsync = async (app) => {
  app.post("/challenge", async (req, reply) => {
    const body = req.body as Record<string, unknown> | null | undefined;
    const address = typeof body?.address === "string" ? body.address : undefined;
    if (!address) return reply.code(400).send({ error: "address is required" });
    const result = await createAdminChallenge(address);
    if (result.error) req.log.error(result.error, "[admin] challenge failed");
    return reply.code(result.status).send(result.body);
  });

  app.post("/verify", async (req, reply) => {
    const body = req.body as Record<string, unknown> | null | undefined;
    const address = typeof body?.address === "string" ? body.address : undefined;
    const challenge = typeof body?.challenge === "string" ? body.challenge : undefined;
    const signature = typeof body?.signature === "string" ? body.signature : undefined;
    if (!address || !challenge || !signature) {
      return reply.code(400).send({ error: "address, challenge and signature are required" });
    }
    const result = await verifyAdminChallenge({ address, challenge, signature });
    if (result.error) req.log.error(result.error, "[admin] verify failed");
    return reply.code(result.status).send(result.body);
  });

  app.get("/vault-state", async (req, reply) => {
    const result = await handleGetVaultState(req.headers.authorization);
    if (result.error) req.log.error(result.error, "[admin] vault state failed");
    return reply.header("Cache-Control", "no-store").code(result.status).send(result.body);
  });

  app.get("/history", async (req, reply) => {
    const { vaultId } = req.query as { vaultId?: string };
    if (!vaultId) return reply.code(400).send({ error: "vaultId is required" });
    const result = await handleGetAdminHistory(vaultId, req.headers.authorization);
    if (result.error) req.log.error(result.error, "[admin] history failed");
    return reply.header("Cache-Control", "no-store").code(result.status).send(result.body);
  });

  for (const url of ["/vault-state", "/history"]) {
    app.route({
      method: ["POST", "PUT", "PATCH", "DELETE"],
      url,
      handler: async (_req, reply) => reply.code(405).header("Allow", "GET").send({ error: "Method not allowed" }),
    });
  }
};
