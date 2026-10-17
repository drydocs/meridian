import type { FastifyPluginAsync } from "fastify";
import {
  createAdminChallenge,
  handleGetVaultState,
  verifyAdminChallenge,
} from "@meridian/api-core";

export const adminRoute: FastifyPluginAsync = async (app) => {
  app.post("/challenge", async (req, reply) => {
    const body = (req.body ?? {}) as { address?: unknown };
    const result = await createAdminChallenge(
      typeof body.address === "string" ? body.address : ""
    );
    return reply.code(result.status).send(result.body);
  });

  app.post("/verify", async (req, reply) => {
    const body = (req.body ?? {}) as {
      address?: unknown;
      challenge?: unknown;
      signature?: unknown;
    };
    const result = await verifyAdminChallenge({
      address: typeof body.address === "string" ? body.address : "",
      challenge: typeof body.challenge === "string" ? body.challenge : "",
      signature: typeof body.signature === "string" ? body.signature : "",
    });
    return reply.code(result.status).send(result.body);
  });

  app.get("/vault-state", async (req, reply) => {
    const result = await handleGetVaultState(req.headers.authorization);
    if (result.error) {
      app.log.error(result.error, "[admin] failed to read vault state");
    }
    return reply.code(result.status).send(result.body);
  });
};
