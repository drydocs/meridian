import type { FastifyPluginAsync } from "fastify";
import {
  handleDepositRequest,
  handleWithdrawRequest,
  handleAddTrustlineRequest,
  handleSubmitRequest,
  handleQuoteRequest,
} from "@meridian/api-core";

export const txRoute: FastifyPluginAsync = async (app) => {
  app.post("/deposit", async (req, reply) => {
    const result = await handleDepositRequest(req.body);
    if (result.error) {
      req.log.error({ err: result.error }, "[tx/deposit] build failed");
    }
    reply.code(result.status).send(result.body);
  });

  app.post("/withdraw", async (req, reply) => {
    const result = await handleWithdrawRequest(req.body);
    if (result.error) {
      req.log.error({ err: result.error }, "[tx/withdraw] build failed");
    }
    reply.code(result.status).send(result.body);
  });

  app.post("/add-trustline", async (req, reply) => {
    const result = await handleAddTrustlineRequest(req.body);
    if (result.error) {
      req.log.error({ err: result.error }, "[tx/add-trustline] build failed");
    }
    reply.code(result.status).send(result.body);
  });

  app.post("/submit", async (req, reply) => {
    const result = await handleSubmitRequest(req.body);
    if (result.error) {
      req.log.error({ err: result.error }, "[tx/submit] failed");
    }
    reply.code(result.status).send(result.body);
  });

  app.post("/quote", async (req, reply) => {
    const result = await handleQuoteRequest(req.body);
    if (result.error)
      app.log.error({ err: result.error }, "[tx/quote] quote failed");
    reply.code(result.status).send(result.body);
  });

  for (const url of [
    "/deposit",
    "/withdraw",
    "/add-trustline",
    "/submit",
    "/quote",
  ]) {
    app.route({
      method: ["GET", "PUT", "PATCH", "DELETE"],
      url,
      handler: async (_req, reply) =>
        reply
          .code(405)
          .header("Allow", "POST")
          .send({ error: "Method not allowed" }),
    });
  }
};
