import type { FastifyPluginAsync } from "fastify";
import { DepositRequestSchema, WithdrawRequestSchema } from "@meridian/shared";

export const txRoute: FastifyPluginAsync = async (app) => {
  app.post("/deposit", async (req, reply) => {
    const parsed = DepositRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    // TODO(#issue-7): build unsigned Soroban tx, return XDR for wallet signing
    reply.code(501).send({ error: "not yet implemented" });
  });

  app.post("/withdraw", async (req, reply) => {
    const parsed = WithdrawRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    // TODO(#issue-7): build unsigned Soroban tx, return XDR for wallet signing
    reply.code(501).send({ error: "not yet implemented" });
  });
};
