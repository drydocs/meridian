import type { FastifyPluginAsync } from "fastify";
import { DepositRequestSchema, WithdrawRequestSchema } from "@meridian/shared";

export const txRoute: FastifyPluginAsync = async (app) => {
  app.post("/deposit", async (req, reply) => {
    const parsed = DepositRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const fields = parsed.error.flatten().fieldErrors;
      const msg = Object.entries(fields).map(([k, v]) => `${k}: ${v?.join(", ")}`).join("; ");
      return reply.code(400).send({ error: msg || "Invalid request" });
    }
    // TODO(#issue-7): build unsigned Soroban tx, return XDR for wallet signing
    reply.code(501).send({ error: "Deposit signing not yet implemented" });
  });

  app.post("/withdraw", async (req, reply) => {
    const parsed = WithdrawRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const fields = parsed.error.flatten().fieldErrors;
      const msg = Object.entries(fields).map(([k, v]) => `${k}: ${v?.join(", ")}`).join("; ");
      return reply.code(400).send({ error: msg || "Invalid request" });
    }
    // TODO(#issue-7): build unsigned Soroban tx, return XDR for wallet signing
    reply.code(501).send({ error: "Withdrawal signing not yet implemented" });
  });
};
