import type { FastifyPluginAsync } from "fastify";
import {
  handleDepositRequest,
  handleWithdrawRequest,
  handleAddTrustlineRequest,
  handleSubmitRequest,
} from "@meridian/api-core";

function idempotencyOptions(header: string | string[] | undefined) {
  return typeof header === "string" ? { idempotencyKey: header } : {};
}

export const txRoute: FastifyPluginAsync = async (app) => {
  app.post("/deposit", async (req, reply) => {
    const result = await handleDepositRequest(
      req.body,
      idempotencyOptions(req.headers["idempotency-key"])
    );
    if (result.error) {
      app.log.error({ err: result.error }, "[tx/deposit] build failed");
    }
    reply.code(result.status).send(result.body);
  });

  app.post("/withdraw", async (req, reply) => {
    const result = await handleWithdrawRequest(
      req.body,
      idempotencyOptions(req.headers["idempotency-key"])
    );
    if (result.error) {
      app.log.error({ err: result.error }, "[tx/withdraw] build failed");
    }
    reply.code(result.status).send(result.body);
  });

  app.post("/add-trustline", async (req, reply) => {
    const result = await handleAddTrustlineRequest(
      req.body,
      idempotencyOptions(req.headers["idempotency-key"])
    );
    if (result.error) {
      app.log.error({ err: result.error }, "[tx/add-trustline] build failed");
    }
    reply.code(result.status).send(result.body);
  });

  app.post("/submit", async (req, reply) => {
    const result = await handleSubmitRequest(
      req.body,
      idempotencyOptions(req.headers["idempotency-key"])
    );
    if (result.error) {
      app.log.error({ err: result.error }, "[tx/submit] failed");
    }
    reply.code(result.status).send(result.body);
  });
};
