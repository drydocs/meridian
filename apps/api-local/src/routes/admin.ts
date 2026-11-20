import type { FastifyPluginAsync } from "fastify";
import {
  createAdminChallenge,
  handleGetAdminHistory,
  handleGetVaultState,
  verifyAdminChallenge,
} from "@meridian/api-core";

export const adminRoute: FastifyPluginAsync = async (app) => {
  // POST /api/v1/admin/challenge
  // Issues a one-time challenge string for the given address to sign.
  app.post("/challenge", async (req, reply) => {
    const body = req.body as Record<string, unknown> | null | undefined;
    const address =
      typeof body?.address === "string" ? body.address : undefined;
    if (!address) {
      return reply.code(400).send({ error: "address is required" });
    }
    const result = await createAdminChallenge(address);
    if (result.error) {
      app.log.error(result.error, "[admin] challenge creation failed");
    }
    return reply.code(result.status).send(result.body);
  });

  // POST /api/v1/admin/verify
  // Validates the wallet signature over the challenge and returns a
  // short-lived HMAC-signed session token.
  app.post("/verify", async (req, reply) => {
    const body = req.body as Record<string, unknown> | null | undefined;
    const address =
      typeof body?.address === "string" ? body.address : undefined;
    const challenge =
      typeof body?.challenge === "string" ? body.challenge : undefined;
    const signature =
      typeof body?.signature === "string" ? body.signature : undefined;

    if (!address || !challenge || !signature) {
      return reply
        .code(400)
        .send({ error: "address, challenge and signature are required" });
    }
    const result = await verifyAdminChallenge({
      address,
      challenge,
      signature,
    });
    if (result.error) {
      app.log.error(result.error, "[admin] verify failed");
    }
    return reply.code(result.status).send(result.body);
  });

  // GET /api/v1/admin/vault-state  (protected)
  app.get("/vault-state", async (req, reply) => {
    const authorization = req.headers.authorization;
    const result = await handleGetVaultState(authorization);
    if (result.error) {
      app.log.error(result.error, "[admin] failed to read vault state");
    }
    return reply.code(result.status).send(result.body);
  });

  // GET /api/v1/admin/history  (protected)
  app.get("/history", async (req, reply) => {
    const { vaultId } = req.query as { vaultId?: string };
    if (!vaultId) return reply.code(400).send({ error: "vaultId is required" });

    const authorization = req.headers.authorization;
    const result = await handleGetAdminHistory(vaultId, authorization);
    if (result.error) {
      app.log.error(result.error, "[admin] failed to read admin history");
    }
    return reply.code(result.status).send(result.body);
  });

  for (const url of ["/vault-state", "/history"]) {
    app.route({
      method: ["PUT", "PATCH", "DELETE"],
      url,
      handler: async (_req, reply) =>
        reply
          .code(405)
          .header("Allow", "GET")
          .send({ error: "method not allowed" }),
    });
    // Treat POST the same as any other non-GET verb on these read-only paths.
    app.post(url, async (_req, reply) =>
      reply
        .code(405)
        .header("Allow", "GET")
        .send({ error: "method not allowed" })
    );
  }
};
