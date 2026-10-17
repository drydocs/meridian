import type { FastifyPluginAsync } from "fastify";
import { handleGetPublicVaultState } from "@meridian/api-core";

export const publicVaultStateRoute: FastifyPluginAsync = async (app) => {
  app.get("/", async (_req, reply) => {
    const result = await handleGetPublicVaultState();
    return reply.code(result.status).send(result.body);
  });
};
